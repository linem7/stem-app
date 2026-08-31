import { Router } from 'express';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { ok, asyncRoute, badRequest } from '../../utils/errors.js';
import { logAction } from '../../services/admins.js';
import { parseRoster, annotateExisting, summarize } from '../../services/roster.js';
import { buildTemplate, sheetToRows, rowsToText } from '../../services/xlsx.js';
import { logger } from '../../utils/logger.js';
import { maskName, sendXlsx } from './_shared.js';

export const rosterRouter = Router();

// ---------------------------------------------------------------
// 名单 —— 激活的第二把钥匙（013 迁移，operations.md 第 1 节）
//
// 码证明「你是这批人里的」（问卷星发），手机号证明「你是哪一个」（跟这张名单核对）。
// 两把钥匙**相互独立**：码不绑在名单某一行上，否则问卷星发的随机码
// 就对不上她的号，「答卷后自动发码」当场断掉。
//
// 🔴 真实手机号进库的前提：伦理审查 + 协议里单独写清楚。开发用假号。
// ---------------------------------------------------------------
rosterRouter.get('/roster', asyncRoute(async (req, res) => {
  const status = String(req.query.status || 'all');
  const where = [];
  const params = [];
  if (['pending', 'claimed', 'void'].includes(status)) {
    params.push(status); where.push(`r.status = $${params.length}`);
  }
  if (req.query.kindergarten_id) {
    params.push(Number(req.query.kindergarten_id)); where.push(`r.kindergarten_id = $${params.length}`);
  }
  const q = String(req.query.q || '').trim();
  if (q) {
    params.push(`%${q}%`);
    where.push(`(r.real_name LIKE $${params.length} OR r.class_name LIKE $${params.length}
                 OR r.teacher_ref::text LIKE $${params.length})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, counts] = await Promise.all([
    query(`
      SELECT r.*, k.name AS kindergarten
        FROM teacher_roster r LEFT JOIN kindergartens k ON k.id = r.kindergarten_id
      ${clause}
       ORDER BY r.created_at DESC, r.id DESC LIMIT 500`, params),
    query(`SELECT status, COUNT(*)::int AS n FROM teacher_roster GROUP BY status`),
  ]);

  return ok(res, {
    items: rows.rows.map((r) => ({
      id: r.id,
      // 手机号跟老师详情同一条纪律：一般管理员只看打码
      // teacher_ref = **人**（换班也不变，研究追人按它归组）
      // id 本身 = **位置**（class_teacher_id）：人 × 园 × 班 × 岗位
      teacher_ref: r.teacher_ref,
      // 姓名对一般管理员只给姓氏 —— 跟老师那边同一条纪律
      real_name: maskName(r.real_name, req.isSuper),
      name_masked: !req.isSuper,
      kindergarten: r.kindergarten,
      kindergarten_id: r.kindergarten_id,
      class_name: r.class_name,
      position: r.position,
      age_group: r.age_group,
      note_public: r.note_public,
      status: r.status,
      claimed_teacher_id: r.claimed_by,
      claimed_at: r.claimed_at,
      // 「谁顶了谁的名额」只给超管：它是一个能指向具体微信账号的标识
      claimed_openid: req.isSuper ? r.claimed_openid : undefined,
      note: r.note,
      created_at: r.created_at,
    })),
    counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])),
  });
}));

/**
 * 粘贴一段文本 **或** 上传一个 xlsx 导入名单。
 *
 * **`dry_run` 先预览再写**（前端默认先干跑一次）。不给预览就是让人闭眼提交
 * 一份从微信里复制来的名单 —— 里面必然有全角逗号、多余空格、少一列的行、
 * 甚至连表头一起复制进来。
 *
 * 🔴 **两条入口共用同一个解析器**（2026-08-21 加 xlsx 时定的）。
 * xlsx 在这里就地被拼成「单元格用制表符连、行用换行连」的文本，
 * 然后走跟粘贴完全一样的那条路 —— 而制表符正是从 Excel 复制粘贴时的分隔符，
 * 所以 parseRoster 本来就认，一行都不用改。
 *
 * 为什么不为 xlsx 单写一份：那套「按内容认而不按列位认」的规则
 * （姓名/班级/岗位/年级顺序随便、全角逗号也认）是踩出来的。写成两份迟早分叉，
 * 而分叉的表现是「粘贴能导进去、上传同一份数据少认出三个人」，**不报错**。
 */
rosterRouter.post('/roster/import', asyncRoute(async (req, res) => {
  const b = req.body || {};
  let text = String(b.text || '');
  // 按**键在不在**判，不按真假判：`file_base64: ''` 是「她选了文件、但读出来是空的」，
  // 走到下面那句「粘一段名单进来」会把她往完全错的方向引 ——
  // 她明明选了文件，界面却让她去粘文本。空内容的那句话在 sheetToRows 里
  if (b.file_base64 !== undefined) {
    const { rows: sheet } = await sheetToRows(b.file_base64);
    text = rowsToText(sheet);
  }
  if (!text.trim()) throw badRequest('粘一段名单进来，一行一个人');

  const kgId = b.kindergarten_id ? Number(b.kindergarten_id) : null;
  const rows = await annotateExisting(parseRoster(text), kgId);
  const summary = summarize(rows);
  const dryRun = b.dry_run !== false;

  if (dryRun) return ok(res, { rows, summary, imported: 0, dry_run: true });
  if (!summary.ok) throw badRequest('一行都没解析出来，检查一下格式');

  // 整批一个事务：要么全写进去，要么一行都不写 ——
  // 半截导入之后没人知道该从哪一行接着来
  const good = rows.filter((r) => r.ok);
  const created = await withTransaction(async (client) => {
    const out = [];
    for (const r of good) {
      // teacher_ref 每行分配一个新的：这一行代表一个**人**第一次进名单。
      // 她以后换班，是新开一行、沿用同一个 ref（走 /roster/:id/reassign）
      const row = (await client.query(
        `INSERT INTO teacher_roster
           (teacher_ref, real_name, kindergarten_id, class_name, position, age_group, note, created_by)
         VALUES (nextval('teacher_ref_seq'),$1,$2,$3,$4,$5,$6,$7)
         RETURNING id, teacher_ref`,
        [r.real_name, kgId, r.class_name, r.position, r.age_group,
          String(b.note || '').trim().slice(0, 128) || null, req.adminId]
      )).rows[0];
      out.push(row);
    }
    return out;
  });

  await logAction({ adminId: req.adminId, action: 'import_roster', target: `roster:${good.length}`,
    detail: { imported: good.length, skipped: summary.total - good.length, kindergarten_id: kgId } });
  // 日志里**不放姓名**（三条铁律之一），只记数量
  logger.info('roster_imported', { by: req.adminId, imported: good.length });
  return ok(res, { rows, summary, imported: good.length, created, dry_run: false });
}));

/**
 * 名单模板。**带两行示例，不给空模板。**
 *
 * 一份只有列头的空表，人填出来的「岗位」会是「班主任」「带班老师」这种 ——
 * parseRoster 只认 POSITIONS 里那几个词，认不出来就落到姓名那一列去了。
 * 给两行样例等于把可选值说清楚，而且不用在界面上写一段说明小字。
 *
 * 列顺序无所谓（parseRoster 按内容认不按列位认），但模板还是按
 * 「姓名在最前」排 —— 姓名那一列要是排在班级后面，
 * 「小一班」会被当成姓名，而 parseRoster 只能提醒、猜不出来。
 */
rosterRouter.get('/roster/template', asyncRoute(async (req, res) => {
  const buf = await buildTemplate({
    sheetName: '名单',
    columns: ['姓名', '班级', '岗位', '年级'],
    samples: [
      ['王小美', '小一班', '主班', '小班'],
      ['李红', '中二班', '配班', '中班'],
    ],
    widths: [14, 14, 12, 10],
  });
  return sendXlsx(res, buf, '老师名单模板.xlsx');
}));

/**
 * 她换班了。
 *
 * **新开一行、沿用同一个 `teacher_ref`**，旧那一行标 `moved` 留着不删 ——
 * 那是历史，研究要用它区分「她在小一班那半年」和「她在中二班这半年」。
 * 她账号的 `roster_entry_id` 指到新那一行。**她自己什么都不用做。**
 *
 * 这是「追踪对象可能是人、也可能是班」那个需求的落点：
 * 追人按 `teacher_ref` 归组，追班按（园所 + 班级）归组，两种都算得出来。
 */
rosterRouter.post('/roster/:id/reassign', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};

  const out = await withTransaction(async (client) => {
    const old = (await client.query(
      `SELECT * FROM teacher_roster WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!old) return { err: '名单上没有这一条' };
    if (old.status === 'void') return { err: '这一条已经作废了' };
    if (old.status === 'moved') return { err: '这一条已经是旧记录了，去她当前那一条上操作' };

    const className = b.class_name === undefined ? old.class_name : String(b.class_name).trim() || null;
    const ageGroup = b.age_group === undefined ? old.age_group : String(b.age_group).trim() || null;
    const position = b.position === undefined ? old.position : String(b.position).trim() || null;
    const kgId = b.kindergarten_id === undefined ? old.kindergarten_id : (Number(b.kindergarten_id) || null);

    if (className === old.class_name && position === old.position && kgId === old.kindergarten_id) {
      return { err: '班级、岗位、园所都没变，不用挪' };
    }

    const fresh = (await client.query(
      `INSERT INTO teacher_roster
         (teacher_ref, real_name, kindergarten_id, class_name, position, age_group,
          note_public, note, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [old.teacher_ref, old.real_name, kgId, className, position, ageGroup,
        old.note_public, old.note, req.adminId,
        // 她已经有账号了就直接算 claimed（她不用再认领一次）；
        // 还没激活的话新那一行仍然等她来认领
        old.status === 'claimed' ? 'claimed' : 'pending']
    )).rows[0];

    if (old.status === 'claimed') {
      await client.query(
        `UPDATE teacher_roster SET claimed_by = $1, claimed_openid = $2, claimed_at = $3
          WHERE id = $4`,
        [old.claimed_by, old.claimed_openid, old.claimed_at, fresh.id]);
      // 账号跟着指到新位置，并同步她的班级岗位（前端「我的」页显示的就是这些）
      await client.query(
        `UPDATE teachers
            SET roster_entry_id = $1, class_name = $2, position = $3,
                age_group = COALESCE($4, age_group), kindergarten_id = $5, updated_at = now()
          WHERE id = $6`,
        [fresh.id, className, position, ageGroup, kgId, old.claimed_by]);
    }

    // 旧那一行标 moved —— **不删**，它是历史
    await client.query(`UPDATE teacher_roster SET status = 'moved' WHERE id = $1`, [old.id]);
    return { entry: fresh, moved_from: old.id };
  });

  if (out.err) throw badRequest(out.err);
  await logAction({ adminId: req.adminId, action: 'reassign_roster',
    target: `roster:${out.entry.id}`,
    detail: { teacher_ref: out.entry.teacher_ref, from: out.moved_from } });
  return ok(res, out);
}));

rosterRouter.post('/roster/:id/void', asyncRoute(async (req, res) => {
  const row = await queryOne(
    // 已经认领的不许作废：那会让一个正在用的账号失去它的名单依据
    `UPDATE teacher_roster SET status = 'void'
      WHERE id = $1 AND status = 'pending' RETURNING id, status`,
    [Number(req.params.id)]);
  if (!row) throw badRequest('只有还没被认领的才能作废');
  await logAction({ adminId: req.adminId, action: 'void_roster', target: `roster:${row.id}` });
  return ok(res, row);
}));
