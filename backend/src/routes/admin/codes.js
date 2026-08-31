import { Router } from 'express';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../../utils/errors.js';
import { generateCode } from '../../utils/code.js';
import { logAction } from '../../services/admins.js';
import { logger } from '../../utils/logger.js';
import { requireSuper, maskName } from './_shared.js';

export const codesRouter = Router();

// ---------------------------------------------------------------
// 兑换码
// ---------------------------------------------------------------
codesRouter.get(
  '/codes',
  asyncRoute(async (req, res) => {
    // 🔴 **一行 = 一次建码操作**，不是一行一个码（2026-08-21 用户定，019 迁移）。
    //
    // 原来是一个码一行。而实际动作是「批量建 20 个灌进问卷星」——
    // 那一次操作在列表里摊成 20 行，几批混在一起按时间倒序排，
    // 分不出哪 20 个是刚才那一批的。
    //
    // 「共几张 / 已用几张」一律 COUNT 出来，**不存计数列** ——
    // 跟额度台账、平台账同一条纪律：汇总数是算出来的，
    // 存一列 used_count 就有了两份事实，而老师兑码时没人会记得去 +1。
    //
    // 上一轮加的「谁兑的」那一列在这个模型下没有意义了（一次批量操作对应
    // 很多个兑换者），所以撤掉。要看谁兑了走批次详情或老师页。
    const status = String(req.query.status || 'all');
    // 按状态筛的语义变成「这一批**里还有**这种状态的码」。
    // 比「整批都是这个状态」有用：她筛「未使用」是想找还能发出去的那几批
    const having = status === 'all' ? '' : `
      HAVING COUNT(*) FILTER (WHERE c.status = '${
        status === 'unused' ? 'unused' : status === 'used' ? 'used' : 'void'}') > 0`;

    const rows = (await query(`
      SELECT b.id, b.kind, b.requested, b.init_text, b.init_image,
             b.grant_reason, b.created_at,
             k.name AS kindergarten,
             a.display_name, a.username,
             COUNT(c.id)::int                                            AS total,
             COUNT(c.id) FILTER (WHERE c.status = 'used')::int            AS used,
             COUNT(c.id) FILTER (WHERE c.status = 'unused')::int          AS unused,
             COUNT(c.id) FILTER (WHERE c.status = 'void')::int            AS voided
        FROM code_batches b
        LEFT JOIN kindergartens k ON k.id = b.kindergarten_id
        LEFT JOIN admins a        ON a.id = b.created_by
        LEFT JOIN redemption_codes c ON c.batch_id = b.id
       GROUP BY b.id, k.name, a.display_name, a.username
       ${having}
       ORDER BY b.created_at DESC, b.id DESC LIMIT 200`)).rows;

    return ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        // requested 和 total 都给：不一样就是「有几张没建成」（撞码重试失败），
        // 那本身是要看见的信息，不该被抹平
        requested: r.requested,
        total: r.total,
        used: r.used,
        unused: r.unused,
        voided: r.voided,
        init_text: r.init_text,
        init_image: r.init_image,
        grant_reason: r.grant_reason,
        kindergarten: r.kindergarten,
        created_by_name: r.display_name || r.username || null,
        created_at: r.created_at,
      })),
    });
  })
);

/**
 * 按**单个码**查。
 *
 * `GET /codes` 2026-08-21 改成了「一行一次操作」（019 迁移），
 * 于是「这一个码现在什么状态」没地方问了 —— 而那是个真问题：
 * 老师说「码用不了」，得能查出它是没兑过、已经被别人兑了、还是被作废了。
 *
 * 界面上暂时没有调用方（兑换码页列的是操作），但**别删** ——
 * 回归脚本靠它验「激活失败绝不能消耗那个码」这条红线，
 * 而那条红线的反面（码被悄悄消耗掉）在界面上是看不出来的。
 */
codesRouter.get('/codes/items', asyncRoute(async (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase().replace(/[\s]/g, '');
  const status = String(req.query.status || 'all');
  const params = [];
  const where = [];
  if (code) {
    params.push(`%${code.replace(/-/g, '')}%`);
    where.push(`REPLACE(c.code, '-', '') LIKE $${params.length}`);
  }
  if (['unused', 'used', 'void'].includes(status)) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  const rows = (await query(`
    SELECT c.id, c.code, c.status, c.init_text, c.init_image, c.grant_reason,
           c.batch_id, c.used_at, c.created_at,
           c.used_by AS teacher_id,
           COALESCE(r.real_name, t.real_name) AS teacher_name,
           k.name AS kindergarten
      FROM redemption_codes c
      LEFT JOIN teachers t       ON t.id  = c.used_by
      LEFT JOIN teacher_roster r ON r.id  = t.roster_entry_id
      LEFT JOIN kindergartens k  ON k.id  = c.kindergarten_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.created_at DESC, c.id DESC LIMIT 500`, params)).rows;
  return ok(res, {
    items: rows.map((r) => ({
      ...r,
      teacher_name: maskName(r.teacher_name, req.isSuper),
    })),
  });
}));

/**
 * 一批里的码。
 *
 * 用处只有一个（用户原话）：「发放对象没收到时重新抄录」。
 * 所以**只给码，不标哪一张已被使用** —— 她要的是那份原始清单，
 * 标注反而让人以为「已用的那些不用抄了」，而没收到的那个人可能正好拿的是已用的那张。
 */
codesRouter.get('/codes/batches/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const batch = await queryOne(`
    SELECT b.*, k.name AS kindergarten
      FROM code_batches b LEFT JOIN kindergartens k ON k.id = b.kindergarten_id
     WHERE b.id = $1`, [id]);
  if (!batch) throw notFound('没有这一批');
  const codes = (await query(
    `SELECT code FROM redemption_codes WHERE batch_id = $1 ORDER BY id`, [id]
  )).rows.map((r) => r.code);
  return ok(res, {
    batch: {
      id: batch.id, kind: batch.kind, requested: batch.requested,
      init_text: batch.init_text, init_image: batch.init_image,
      grant_reason: batch.grant_reason, kindergarten: batch.kindergarten,
      created_at: batch.created_at,
    },
    codes,
  });
}));

/**
 * 删掉几次操作。
 *
 * 用户定的规则（2026-08-21）：**删操作，已兑的码留在库里**。
 *   · 批次行删掉
 *   · 这批里**未兑**的码跟着删（没发出去过，留着只是噪音）
 *   · **已兑的码留下**，`batch_id` 被外键 ON DELETE SET NULL 清成空 ——
 *     它变成一条无所属的历史记录，老师详情里「她兑的是哪个码」照样查得到。
 *     那是她的额度从哪来的唯一凭据，删了出争议时查不到
 *
 * 代价写在这里：**列表上「共几张」从此跟库里的码数对不上**（少了已兑的那些）。
 * 这是用户明确选的那个取舍，不是 bug。
 *
 * 锁超管：这是不可逆的批量删除。
 */
codesRouter.post('/codes/batches/delete', requireSuper, asyncRoute(async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw badRequest('先选几行再删');

  const result = await withTransaction(async (client) => {
    const kept = (await client.query(
      `SELECT COUNT(*)::int AS n FROM redemption_codes
        WHERE batch_id = ANY($1::bigint[]) AND status <> 'unused'`, [ids]
    )).rows[0].n;
    const dropped = (await client.query(
      `DELETE FROM redemption_codes
        WHERE batch_id = ANY($1::bigint[]) AND status = 'unused' RETURNING id`, [ids]
    )).rowCount;
    // 批次一删，剩下那些已兑的码 batch_id 被 SET NULL —— 靠外键，不用手动 UPDATE
    const batches = (await client.query(
      `DELETE FROM code_batches WHERE id = ANY($1::bigint[]) RETURNING id`, [ids]
    )).rowCount;
    return { batches, dropped, kept };
  });

  await logAction({ adminId: req.adminId, action: 'delete_code_batches',
    target: `batches:${result.batches}`, detail: result });
  logger.info('code_batches_deleted', { by: req.adminId, ...result });
  return ok(res, result);
}));

/**
 * 建码时那句「说明」——**最多 20 个字**（2026-08-25 用户定）。
 *
 * 20 是从表格反推的：兑换码列表那一列是等宽的一格，装得下 20 个字。
 * 再长就得靠省略号截断，而这句话的用处是「一眼看出这批码是发给谁的」——
 * 看不全就等于没写。
 *
 * ⚠️ 界面上那个输入框也有 `maxlength="20"`，所以这里的截断实际上打不着。
 * 留着是因为**建码有两条路**（单个和批量），而 update 那种「两条路只守一条」
 * 的事这个项目已经踩过（2026-08-22 配图模型地址被清空那次）。
 * 界面上**不写「限 20 字」**：输入框自己会停下来，写出来只是替我记笔记。
 */
const grantReason = (v, fallback) => String(v || '').trim().slice(0, 20) || fallback;

/**
 * 建一个码。
 *
 * **码只是一张入场券**，不带任何身份（016 迁移把那几列删了）。
 * 身份全部来自名单 —— 她激活时从名单里选自己是哪一位。
 *
 * 所以这里只有三个参数：给哪个园（可不填）、初始额度、原因。
 * 原来还能填手机号姓名建「绑定码」，那条路撤掉了：
 * 留着两套激活逻辑，以后改其中一条一定会忘了另一条。
 */
codesRouter.post(
  '/codes',
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const kgId = b.kindergarten_id ? Number(b.kindergarten_id) : null;
    const initText = Number(b.init_text) > 0 ? Number(b.init_text) : 20;
    const initImage = Number(b.init_image) > 0 ? Number(b.init_image) : 10;
    const reason = grantReason(b.grant_reason, '首次激活');
    const batch = await queryOne(
      `INSERT INTO code_batches
         (kind, requested, init_text, init_image, grant_reason, kindergarten_id, created_by)
       VALUES ('single',1,$1,$2,$3,$4,$5) RETURNING id`,
      [initText, initImage, reason, kgId, req.adminId]
    );
    const row = await queryOne(
      `INSERT INTO redemption_codes
         (code, kindergarten_id, init_text, init_image, grant_reason, batch_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        generateCode(),
        kgId,
        initText, initImage, reason,
        // 单张也记一次操作（kind='single'）—— 列表是按操作列的，
        // 不记的话单独建的码在那一页上一条都看不见
        batch.id,
      ]
    );
    await logAction({ adminId: req.adminId, action: 'create_code', target: `code:${row.code}`,
      detail: { init_text: row.init_text, init_image: row.init_image } });
    logger.info('code_created', { by: req.adminId, code_id: row.id });
    return ok(res, { code: row.code, id: row.id, batch_id: batch.id });
  })
);

codesRouter.post(
  '/codes/:id/void',
  asyncRoute(async (req, res) => {
    const row = await queryOne(
      `UPDATE redemption_codes SET status = 'void'
        WHERE id = $1 AND status = 'unused' RETURNING id, code`, [Number(req.params.id)]);
    if (!row) throw badRequest('只有还没被用的码可以作废');
    await logAction({ adminId: req.adminId, action: 'void_code', target: `code:${row.code}` });
    return ok(res, row);
  })
);

/**
 * 批量建码。
 *
 * **不需要名单**（2026-08-18 用户定）：直接要 N 个码，谁拿到谁能兑。
 * 用法是把导出的 CSV 灌进问卷星当奖励发放，或者整批交给园所。
 *
 * 因此「问卷答卷 ↔ 小程序账号」的对应关系**不在我们库里**了 ——
 * 它在问卷星那边（哪个手机号领到了哪个码）。后台按手机号搜不到这些老师，
 * 改成按**兑换码**搜。这是这次改动的真实代价，
 * 别指望还能像以前那样按手机号对账。
 *
 * **也不绑园所**（2026-08-21 用户定，原话「兑换码的基本逻辑是谁持有谁使用，
 * 无需设置过多门槛」）。批量建码的用途正是「灌进问卷星谁填谁拿」——
 * 那一刻根本不知道拿到码的人在哪个园，硬填一个只会让
 * 园所页的「发了 N 个码没人兑」变成假数字。
 *
 * ⚠️ 单个建码（`POST /codes`）**仍然可以选园所**，那是有用的：
 * 整批交给某个园的时候，「这个园发了几个码、兑了几个」是跟进合作的依据
 * （园所页那一列就靠它）。两个接口在这一点上不一样，是有意的。
 */
codesRouter.post('/codes/batch', asyncRoute(async (req, res) => {
  const b = req.body || {};
  // 一次最多 200 个：再多就不是「发一批」而是「刷库」了，而且导出的 CSV 也没人看得完
  const count = Math.min(Math.max(Number(b.count) || 0, 1), 200);
  const initText = Number(b.init_text) > 0 ? Number(b.init_text) : 20;
  const initImage = Number(b.init_image) > 0 ? Number(b.init_image) : 10;
  const reason = grantReason(b.grant_reason, '批量发放');

  // 先记这一次操作，再往里塞码。列表是按操作列的（019 迁移），
  // `requested` 记的是「要建几个」—— 跟实际建成的张数分开存：
  // 撞码重试失败时两个数会不一样，而那正是要看见的信息，不该被抹平
  // 要 1 个就记成 'single'（2026-08-22）。界面上「新建」和「批量建码」
  // 合成了一个入口、由数量决定，所以这条路现在也会收到 count=1 ——
  // 记成 'batch' 的话列表里会出现一行「批量建 1 个」，读起来像出了什么错
  const batch = await queryOne(
    `INSERT INTO code_batches
       (kind, requested, init_text, init_image, grant_reason, created_by)
     VALUES ($6,$1,$2,$3,$4,$5) RETURNING id`,
    [count, initText, initImage, reason, req.adminId, count === 1 ? 'single' : 'batch']
  );

  const created = [];
  for (let i = 0; i < count; i += 1) {
    // generateCode 里已经避开了容易看错的字符（0/O、1/I），这里只管重试撞码
    let code = generateCode();
    for (let retry = 0; retry < 5; retry += 1) {
      const dup = await queryOne(`SELECT id FROM redemption_codes WHERE code = $1`, [code]);
      if (!dup) break;
      code = generateCode();
    }
    await query(
      `INSERT INTO redemption_codes
         (code, init_text, init_image, grant_reason, status, batch_id)
       VALUES ($1,$2,$3,$4,'unused',$5)`,
      [code, initText, initImage, reason, batch.id]
    );
    created.push(code);
  }

  await logAction({ adminId: req.adminId, action: 'create_codes_batch', target: `codes:${created.length}`,
    detail: { count: created.length, init_text: initText, init_image: initImage } });
  logger.info('codes_batch_created', { by: req.adminId, count: created.length });

  // 把这一批的参数一起回给前端：建完要在弹框里**一行一个**铺出来，
  // 还要能就地生成一份 CSV 发给某个园或某个平台。
  // 参数是整批共用的（都是刚才那张表单填的），所以不用每行都查一遍库。
  // `kindergarten: null` 这个键留着只为一件事：老版前端还在读它，
  // 键没了会渲染出字面的 "undefined"。前端那份 CSV 已经把「幼儿园」那一列去掉了
  return ok(res, {
    created,
    batch: { id: batch.id, count: created.length, init_text: initText, init_image: initImage,
      grant_reason: reason, kindergarten: null },
  });
}));

/** 状态一律出中文。这份 CSV 是给人看的，unused / void 印在上面等于没写 */
const CODE_STATUS_CN = { unused: '未使用', used: '已使用', void: '已作废' };

/**
 * 导出 CSV。用途是把码灌进问卷星当奖励，或整批交给园所。
 *
 * 2026-08-19 之后**码上没有任何身份信息了**（016 迁移删了那几列），
 * 所以这份 CSV 只有六列，也不再有「手机号那列印着字面 null」那个毛病 ——
 * 那一列根本不存在了。之前修过的另两处保留：
 *   · 状态出中文（`unused` 印在给人看的表上等于没写）
 *   · `codes=A,B,C` 只导刚建的那一批（「发给某个园」要的是这一批，
 *     不是历史上所有未使用的码）
 *
 * 仍然锁超管：它是一份能直接兑成额度的东西，等于一叠现金券。
 */
codesRouter.get('/codes/export', requireSuper, asyncRoute(async (req, res) => {
  const status = String(req.query.status || 'unused');
  const only = String(req.query.code || '').trim();
  const list = String(req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);

  const params = [];
  let where = '';
  if (list.length) { params.push(list); where = `WHERE c.code = ANY($${params.length}::text[])`; }
  else if (only) { params.push(only); where = `WHERE c.code = $${params.length}`; }
  else if (status !== 'all') { params.push(status); where = `WHERE c.status = $${params.length}`; }

  const rows = (await query(`
    SELECT c.code, c.init_text, c.init_image, c.grant_reason, c.status, c.created_at,
           k.name AS kindergarten
      FROM redemption_codes c
      LEFT JOIN kindergartens k ON k.id = c.kindergarten_id
    ${where} ORDER BY c.created_at DESC LIMIT 2000`, params)).rows;

  const cols = [
    ['兑换码', (r) => r.code],
    ['幼儿园', (r) => r.kindergarten || ''],
    ['教案额度', (r) => r.init_text],
    ['配图额度', (r) => r.init_image],
    ['说明', (r) => r.grant_reason || ''],
    ['状态', (r) => CODE_STATUS_CN[r.status] || r.status],
    ['创建时间', (r) => new Date(r.created_at).toISOString().slice(0, 10)],
  ];

  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.map(([h]) => h).join(',')]
    .concat(rows.map((r) => cols.map(([, get]) => cell(get(r))).join(',')))
    .join('\r\n');

  await logAction({ adminId: req.adminId, action: 'export_codes', target: `codes:${rows.length}`,
    detail: { status, count: rows.length, batch: list.length || undefined, single: Boolean(only) } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="codes-${list.length ? 'batch' : status}.csv"`);
  // BOM：没有它 Excel 打开中文列头是乱码
  res.send('﻿' + csv);
}));
