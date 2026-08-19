/**
 * 管理后台 API —— operations.md 第 6 节
 *
 * 与小程序**完全隔离**：不同的登录方式、不同的 token、不同的中间件。
 * 老师的 JWT 打不开这里，管理员的 token 也调不了业务接口。
 *
 * 【两级权限，和对老师的承诺直接相关】
 * 老师同意的协议里写着「你的幼儿园和园长看不到这里的任何东西」。
 * 同事不是园方，这句承诺依然成立；但最敏感的两项锁在超级管理员手里：
 *   · **手机号全号** —— 一般管理员只看打码
 *   · **对话正文与教案内容** —— 一般管理员完全看不到
 * 同事做运营（发额度、建兑换码、看反馈）不需要读老师写了什么。
 * 少一个人能读，那句承诺就多一分是真的。
 *
 * 仍然**没有**「园所管理员」这种角色。要是哪天加了园长只读账号，
 * 那句承诺就作废了，必须先跟老师们重新讲清楚。
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { ok, asyncRoute, badRequest, notFound, AppError, ErrorCode } from '../utils/errors.js';
import { generateCode } from '../utils/code.js';
import { getQuota, grantQuota } from '../services/quota.js';
import {
  ROLES, findAdmin, verifyPassword, touchLogin, createAdmin,
  setPassword, listAdmins, logAction,
} from '../services/admins.js';
import { listModels, generateWith, FORMATS, isKnownFormat } from '../services/imageModels.js';
import { uploadImage, buildImageUrl } from '../services/imageStore.js';
import { getSetting, setSetting, SETTING_KEYS } from '../services/appSettings.js';
import { getMoney, listTopups, addTopup, TOPUP_CHANNELS } from '../services/costLedger.js';
import { parseRoster, annotateExisting, summarize, surnameOf } from '../services/roster.js';
import { previewTarget, normalizeTarget } from '../services/tasks.js';
import { logger } from '../utils/logger.js';

export const adminRouter = Router();

const TOKEN_TTL = 12 * 3600; // 12 小时，一个工作日

/**
 * 139****1234 —— 保留前 3 后 4，够认人又不至于满屏号码。
 *
 * **现在只有园长的联系电话用它**。老师的手机号 016 迁移已经从库里删掉了 ——
 * 她的号只在问卷星那边，要联系她去那边看答卷。
 */
function maskPhone(p) {
  if (!p) return null;
  const s = String(p);
  return s.length < 8 ? '***' : `${s.slice(0, 3)}****${s.slice(-4)}`;
}

// ---------------------------------------------------------------
// 登录
// ---------------------------------------------------------------
adminRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    const admin = await findAdmin(username);
    // 用户名不存在时也跑一次哈希比较，让响应时间跟「密码错」一致 ——
    // 否则可以靠计时枚举出哪些用户名存在
    const okPwd = admin
      ? await verifyPassword(password, admin.password_hash, admin.salt)
      : await verifyPassword(password, crypto.randomBytes(64).toString('hex'), 'x');

    if (!admin || !okPwd) {
      logger.warn('admin_login_failed', { username, ip: req.ip });
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: '用户名或密码不对' });
    }

    await touchLogin(admin.id);
    const token = jwt.sign(
      { role: 'admin', aid: admin.id, arole: admin.role },
      config.jwt.secret, { expiresIn: TOKEN_TTL }
    );
    logger.info('admin_login', { admin_id: admin.id, role: admin.role });
    return ok(res, {
      token, expires_in: TOKEN_TTL,
      admin: { id: admin.id, username: admin.username, role: admin.role, display_name: admin.display_name },
    });
  })
);

/** 管理员守卫。老师的 token 里没有 role=admin，进不来。 */
export function requireAdmin(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) return next(new AppError(ErrorCode.UNAUTHORIZED, { message: '请先登录' }));
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    if (payload.role !== 'admin') {
      return next(new AppError(ErrorCode.UNAUTHORIZED, { message: '这个账号没有后台权限' }));
    }
    req.adminId = payload.aid;
    req.adminRole = payload.arole || ROLES.ADMIN;
    req.isSuper = req.adminRole === ROLES.SUPER;
    next();
  } catch {
    next(new AppError(ErrorCode.UNAUTHORIZED, { message: '登录过期了，重新登录一下' }));
  }
}

/** 只有超管能过。用在账号管理、看手机号全号、看对话正文这几处。 */
function requireSuper(req, res, next) {
  if (!req.isSuper) {
    return next(new AppError(ErrorCode.UNAUTHORIZED, {
      message: '这一项只有超级管理员能看',
      detail: { need: 'super' },
    }));
  }
  next();
}

// ---------------------------------------------------------------
// 概览
// ---------------------------------------------------------------
/**
 * 概览。2026-08-18 按用户的要求重做了一遍。
 *
 * 删掉的：**「最近写的」**（用户原话「没有实际意义」）、以及「今天写了几份 /
 * 今天几张配图 / 累计多少老师」这类只会一直变大的累计数 ——
 * 它们看一眼就没用了，不告诉你今天该做什么。
 *
 * 现在这一屏只回答四句话：
 *   1. **我的钱** —— 充了多少、花了多少、还剩多少（配图 + 文本分开列）
 *   2. **谁在用** —— 几个园、几位老师，近 7 天各是多少
 *   3. **哪个园用了多少额度** —— 合作是按园谈的，钱也该按园看
 *   4. **等我处理** —— 反馈、失败、快没额度的老师、码不够了
 *
 * 顺手修了一个真 bug：教案评价分布原来查 `kind = 'rating'`，
 * 而库里的真实值是 `'lesson_rating'` —— 所以那一屏**永远显示「还没有人评价过」**，
 * 而实际上早就有数据了。这是这个产品最大未知数的唯一数据源，
 * 一个 typo 让它静静地消失，看起来还完全正常。
 */
adminRouter.get(
  '/overview',
  asyncRoute(async (req, res) => {
    const [money, usage, quality, lowQuota, todo, byKg] = await Promise.all([
      getMoney(),
      // 「几位老师 / 近 7 天来过几位」这两个数**必须同一个口径**，
      // 否则会出现「33 位老师，近 7 天来过 41 位」这种读不通的话。
      // 原来活跃那个 count 没排掉未激活和已注销的账号（联调脚本造了一堆），
      // 于是分子比分母大 —— 这类错不会报警，只会让人不再相信这一屏
      queryOne(`
        SELECT
          (SELECT COUNT(*) FROM kindergartens)::int AS kindergartens,
          (SELECT COUNT(DISTINCT t.kindergarten_id) FROM teachers t
            WHERE t.kindergarten_id IS NOT NULL
              AND t.activated_at IS NOT NULL AND t.status <> 'deleted'
              AND t.last_login_at > now() - interval '7 days')::int AS kindergartens_active_7d,
          (SELECT COUNT(*) FROM teachers
            WHERE activated_at IS NOT NULL AND status <> 'deleted')::int AS teachers,
          (SELECT COUNT(*) FROM teachers
            WHERE activated_at IS NOT NULL AND status <> 'deleted'
              AND last_login_at > now() - interval '7 days')::int AS teachers_active_7d
      `),
      // 教案评价分布 —— 「AI 写的教案是否真的适龄可用」是这个产品最大的未知数，
      // 这一行是它唯一的持续数据源，必须摆在概览上。
      // **kind 是 'lesson_rating' 不是 'rating'**（原来写错了，这一屏一直是空的）
      query(`SELECT rating, COUNT(*)::int n FROM feedback
              WHERE kind = 'lesson_rating' AND rating IS NOT NULL GROUP BY rating`),
      // 快没额度的老师：她下一次点「写教案」就会撞墙，而那时才发现就晚了
      query(`
        SELECT t.id, t.real_name, k.name AS kindergarten,
               COALESCE(g.text,0)::int - COALESCE(p.n,0)::int AS text_left
          FROM teachers t
          LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
          LEFT JOIN (SELECT teacher_id, SUM(delta_text) text FROM quota_grants GROUP BY teacher_id) g ON g.teacher_id = t.id
          LEFT JOIN (SELECT teacher_id, COUNT(*) n FROM lesson_plans GROUP BY teacher_id) p ON p.teacher_id = t.id
         WHERE t.activated_at IS NOT NULL AND t.status = 'active'
           AND COALESCE(g.text,0) - COALESCE(p.n,0) <= 2
         ORDER BY text_left ASC LIMIT 8`),
      queryOne(`
        SELECT
          (SELECT COUNT(*) FROM feedback WHERE handled = false)::int AS feedback_new,
          (SELECT COUNT(*) FROM conversations
            WHERE status = 'failed' AND updated_at > now() - interval '7 days')::int AS gen_failed_7d,
          (SELECT COUNT(*) FROM lesson_images
            WHERE status = 'failed' AND created_at > now() - interval '7 days')::int AS images_failed_7d,
          (SELECT COUNT(*) FROM redemption_codes WHERE status = 'unused')::int AS codes_unused
      `),
      // 哪个园用了多少。跟 /kindergartens 同一套算法，这里只取要显示的几列 ——
      // 「合作是按园谈的，钱也该按园看」
      query(`
        SELECT k.id, k.name, k.province, k.city,
          (SELECT COUNT(*)::int FROM teachers t
            WHERE t.kindergarten_id = k.id AND t.activated_at IS NOT NULL
              AND t.status <> 'deleted')                                     AS teachers,
          (SELECT COALESCE(SUM(g.delta_text),0)::int FROM quota_grants g
             JOIN teachers t ON t.id = g.teacher_id
            WHERE t.kindergarten_id = k.id)                                  AS granted_text,
          (SELECT COALESCE(SUM(1 + GREATEST(0, p.version - 3)),0)::int
             FROM lesson_plans p JOIN teachers t ON t.id = p.teacher_id
            WHERE t.kindergarten_id = k.id)                                  AS used_text,
          (SELECT COUNT(*)::int FROM lesson_images i
             JOIN lesson_plans p ON p.id = i.lesson_plan_id
             JOIN teachers t ON t.id = p.teacher_id
            WHERE t.kindergarten_id = k.id AND i.status = 'ready')           AS images,
          -- 配图成本 + 文本成本，按园算。文本成本靠 model_calls.teacher_id 归到园上
          (SELECT COALESCE(SUM(i.cost_cents),0)::int FROM lesson_images i
             JOIN lesson_plans p ON p.id = i.lesson_plan_id
             JOIN teachers t ON t.id = p.teacher_id
            WHERE t.kindergarten_id = k.id AND i.status = 'ready')           AS image_cost_cents,
          (SELECT COALESCE(SUM(m.cost_cents),0)::int FROM model_calls m
             JOIN teachers t ON t.id = m.teacher_id
            WHERE t.kindergarten_id = k.id)                                  AS text_cost_cents
          FROM kindergartens k
         ORDER BY used_text DESC, k.name`),
    ]);

    const byRating = Object.fromEntries(quality.rows.map((r) => [r.rating, r.n]));
    return ok(res, {
      money,
      usage,
      by_kindergarten: byKg.rows,
      todo: {
        ...todo,
        low_quota: lowQuota.rows.map((r) => ({
          id: r.id,
          // 姓名也算身份信息，一般管理员只看得到姓氏
          name: req.isSuper ? r.real_name : `${String(r.real_name || '').slice(0, 1)}老师`,
          kindergarten: r.kindergarten,
          text_left: r.text_left,
        })),
      },
      quality: {
        usable: byRating.usable || 0,
        needs_edit: byRating.needs_edit || 0,
        unusable: byRating.unusable || 0,
      },
    });
  })
);

// ---------------------------------------------------------------
// 充值台账 —— 概览那块「我的钱」的收入侧
// ---------------------------------------------------------------
adminRouter.get('/topups', asyncRoute(async (req, res) => {
  return ok(res, { items: await listTopups(), channels: TOPUP_CHANNELS });
}));

adminRouter.post('/topups', asyncRoute(async (req, res) => {
  const b = req.body || {};
  // 元 → 分。界面上填的是「200」这样的元，库里一律整数分
  const yuan = Number(b.amount_yuan);
  const cents = Number.isFinite(yuan) ? Math.round(yuan * 100) : Number(b.amount_cents);
  // 允许负数（记错了冲一笔账），但不允许 0 —— 0 是一条没有意义的记录
  if (!Number.isFinite(cents) || cents === 0) throw badRequest('填一下充了多少钱');
  const channel = String(b.channel || '').trim();
  if (!TOPUP_CHANNELS.includes(channel)) {
    throw badRequest(`充到哪家？只能是 ${TOPUP_CHANNELS.join(' / ')}`);
  }
  const row = await addTopup({
    amountCents: cents, channel,
    note: String(b.note || '').trim().slice(0, 128) || null,
    occurredOn: String(b.occurred_on || '').trim() || null,
    adminId: req.adminId,
  });
  await logAction({ adminId: req.adminId, action: 'add_topup', target: `topup:${row.id}`,
    detail: { amount_cents: cents, channel } });
  return ok(res, row);
}));

// ---------------------------------------------------------------
// 名单 —— 激活的第二把钥匙（013 迁移，operations.md 第 1 节）
//
// 码证明「你是这批人里的」（问卷星发），手机号证明「你是哪一个」（跟这张名单核对）。
// 两把钥匙**相互独立**：码不绑在名单某一行上，否则问卷星发的随机码
// 就对不上她的号，「答卷后自动发码」当场断掉。
//
// 🔴 真实手机号进库的前提：伦理审查 + 协议里单独写清楚。开发用假号。
// ---------------------------------------------------------------
adminRouter.get('/roster', asyncRoute(async (req, res) => {
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
      real_name: req.isSuper ? r.real_name : `${surnameOf(r.real_name)}**`,
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
 * 粘贴一段文本导入名单。
 *
 * **`dry_run` 先预览再写**（前端默认先干跑一次）。不给预览就是让人闭眼提交
 * 一份从微信里复制来的名单 —— 里面必然有全角逗号、多余空格、少一列的行、
 * 甚至连表头一起复制进来。
 */
adminRouter.post('/roster/import', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '');
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
 * 她换班了。
 *
 * **新开一行、沿用同一个 `teacher_ref`**，旧那一行标 `moved` 留着不删 ——
 * 那是历史，研究要用它区分「她在小一班那半年」和「她在中二班这半年」。
 * 她账号的 `roster_entry_id` 指到新那一行。**她自己什么都不用做。**
 *
 * 这是「追踪对象可能是人、也可能是班」那个需求的落点：
 * 追人按 `teacher_ref` 归组，追班按（园所 + 班级）归组，两种都算得出来。
 */
adminRouter.post('/roster/:id/reassign', asyncRoute(async (req, res) => {
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

adminRouter.post('/roster/:id/void', asyncRoute(async (req, res) => {
  const row = await queryOne(
    // 已经认领的不许作废：那会让一个正在用的账号失去它的名单依据
    `UPDATE teacher_roster SET status = 'void'
      WHERE id = $1 AND status = 'pending' RETURNING id, status`,
    [Number(req.params.id)]);
  if (!row) throw badRequest('只有还没被认领的才能作废');
  await logAction({ adminId: req.adminId, action: 'void_roster', target: `roster:${row.id}` });
  return ok(res, row);
}));

// ---------------------------------------------------------------
// 老师
// ---------------------------------------------------------------
adminRouter.get(
  '/teachers',
  asyncRoute(async (req, res) => {
    const kg = req.query.kindergarten_id ? Number(req.query.kindergarten_id) : null;
    const q = String(req.query.q || '').trim();

    const where = ['t.activated_at IS NOT NULL'];
    const params = [];
    if (kg) { params.push(kg); where.push(`t.kindergarten_id = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      params.push(`%${q.toUpperCase().replace(/[\s_-]/g, '')}%`);
      // 姓名、班级、**兑换码**、**teacher_ref** 都能搜。
      // 库里没有手机号了（016 迁移删的），所以对账的锚点是
      // 「她兑的是哪个码」（对上问卷星那边的记录）和 teacher_ref（对上我的名单）
      where.push(`(
        t.real_name LIKE $${params.length - 1}
        OR t.class_name LIKE $${params.length - 1}
        OR r.teacher_ref::text LIKE $${params.length - 1}
        OR REPLACE(REPLACE(rc.code, '-', ''), ' ', '') LIKE $${params.length}
      )`);
    }

    const rows = (await query(`
      SELECT t.id, t.real_name, t.position, t.class_name, t.age_group,
             t.last_login_at, t.activated_at, t.status,
             k.name AS kindergarten,
             r.teacher_ref,
             rc.code AS redeem_code,
             COALESCE(g.text,0)::int  AS granted_text,
             COALESCE(g.image,0)::int AS granted_image,
             COALESCE(p.n,0)::int     AS plans,
             COALESCE(p.extra,0)::int AS extra_revisions,
             COALESCE(i.n,0)::int     AS images
        FROM teachers t
        LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
        LEFT JOIN teacher_roster r ON r.id = t.roster_entry_id
        LEFT JOIN redemption_codes rc ON rc.used_by = t.id
        LEFT JOIN (SELECT teacher_id, SUM(delta_text) text, SUM(delta_image) image
                     FROM quota_grants GROUP BY teacher_id) g ON g.teacher_id = t.id
        LEFT JOIN (SELECT teacher_id, COUNT(*) n, SUM(GREATEST(0, version - 3)) extra
                     FROM lesson_plans GROUP BY teacher_id) p ON p.teacher_id = t.id
        LEFT JOIN (SELECT p2.teacher_id, COUNT(*) n
                     FROM lesson_images i2 JOIN lesson_plans p2 ON p2.id = i2.lesson_plan_id
                    WHERE i2.status = 'ready' GROUP BY p2.teacher_id) i ON i.teacher_id = t.id
       WHERE ${where.join(' AND ')}
       ORDER BY t.last_login_at DESC NULLS LAST`, params)).rows;

    return ok(res, {
      items: rows.map((r) => {
        const usedText = r.plans + r.extra_revisions;
        return {
          id: r.id,
          // teacher_ref = **人**：她换班也不变，研究追人按它归组
          teacher_ref: r.teacher_ref,
          // 姓名对一般管理员只给姓氏
          real_name: req.isSuper ? r.real_name : `${surnameOf(r.real_name)}**`,
          name_masked: !req.isSuper,
          redeem_code: r.redeem_code,
          kindergarten: r.kindergarten,
          class_name: r.class_name,
          position: r.position,
          age_group: r.age_group,
          status: r.status,
          quota: {
            text: { granted: r.granted_text, used: usedText, left: r.granted_text - usedText },
            image: { granted: r.granted_image, used: r.images, left: r.granted_image - r.images },
          },
          last_login_at: r.last_login_at,
        };
      }),
    });
  })
);

/**
 * 老师详情。这一页要回答四件事，缺哪一件都得跳出去查：
 *   1. **她是谁** —— 三层：`teacher_ref`（人，换班也不变）、
 *      `roster_entry_id`（位置 = 人 × 园 × 班 × 岗位）、她兑的那个码。
 *      **库里没有手机号**（016 迁移删的），要联系她去问卷星那边看答卷
 *   2. **额度用到哪了** —— 台账。**不再有发放表单**（2026-08-18）：
 *      额度只走兑换码一条路，我建码发给她，她自己兑
 *   3. **她用得怎么样** —— 写完几份、每份出到第几版、画了几张、花了多少钱
 *   4. **她说了什么** —— 评价与建议，附带那份教案的标题
 *
 * 教案那张表**只列写完的**（2026-08-18 用户提）：答题中的草稿不是「她写过的教案」，
 * 是她被叫走留下的半截。库里那些 draft 一行都不动 —— 断点续写依赖它们，
 * 只是这个视图不显示，另外给一个「还在答题中的有几个」的计数。
 */
adminRouter.get(
  '/teachers/:id',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const t = await queryOne(
      `SELECT t.*, k.name AS kindergarten, rc.code AS redeem_code, r.teacher_ref
         FROM teachers t
         LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
         LEFT JOIN teacher_roster r ON r.id = t.roster_entry_id
         LEFT JOIN redemption_codes rc ON rc.used_by = t.id
        WHERE t.id = $1`, [id]);
    if (!t) throw notFound('没有这位老师');

    const PLAN_LIMIT = 50;
    const [quota, grants, plans, drafts, fb, img, purposes, pendingRebind] = await Promise.all([
      getQuota(id),
      query(`SELECT delta_text, delta_image, reason, created_at FROM quota_grants
              WHERE teacher_id = $1 ORDER BY created_at DESC`, [id]),
      // 每份教案连它的全部版本一起取：一次查询，用 json_agg 把版本卷进去 ——
      // 分两次查再在 JS 里拼，会变成「N+1 次查询」，而这一页本来就慢
      query(`SELECT c.id AS conversation_id, c.title, c.age_group, c.created_at,
                    p.id AS plan_id, p.version, p.current_version,
                    COALESCE((
                      SELECT json_agg(json_build_object(
                               'version', v.version,
                               'revise_note', v.revise_note,
                               'created_at', v.created_at) ORDER BY v.version)
                        FROM lesson_plan_versions v WHERE v.lesson_plan_id = p.id
                    ), '[]'::json) AS versions
               FROM conversations c JOIN lesson_plans p ON p.conversation_id = c.id
              WHERE c.teacher_id = $1 AND c.deleted_at IS NULL
                AND c.status = 'completed'
              ORDER BY c.created_at DESC LIMIT ${PLAN_LIMIT + 1}`, [id]),
      // 答题中的只给个数。她开了 12 个草稿只写完 2 份，这本身是个信号
      // （题目太长？被打断太多？），但列出 12 行半截的东西没有用
      queryOne(`SELECT COUNT(*)::int AS n FROM conversations
                 WHERE teacher_id = $1 AND deleted_at IS NULL AND status <> 'completed'`, [id]),
      // 反馈带上那份教案的标题：光看「用不了」不知道是哪一份，得去翻教案表对 id
      query(`SELECT f.id, f.kind, f.category, f.rating, f.text,
                    f.lesson_plan_id, f.plan_version, f.handled, f.created_at,
                    p.title AS plan_title
               FROM feedback f LEFT JOIN lesson_plans p ON p.id = f.lesson_plan_id
              WHERE f.teacher_id = $1 ORDER BY f.created_at DESC`, [id]),
      // 配图统计。配图是成本的主要变量（CLAUDE.md 说上线后要盯采用率），
      // 而「这位老师画了几张」只在这一页看得到
      queryOne(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE i.status = 'ready')::int  AS ready,
               COUNT(*) FILTER (WHERE i.status = 'failed')::int AS failed,
               COALESCE(SUM(i.cost_cents) FILTER (WHERE i.status = 'ready'), 0)::int AS cost_cents
          FROM lesson_images i JOIN lesson_plans p ON p.id = i.lesson_plan_id
         WHERE p.teacher_id = $1`, [id]),
      query(`
        SELECT i.purpose, COUNT(*)::int AS n
          FROM lesson_images i JOIN lesson_plans p ON p.id = i.lesson_plan_id
         WHERE p.teacher_id = $1 AND i.status = 'ready'
         GROUP BY i.purpose ORDER BY n DESC`, [id]),
      // 有没有一把还没用的换绑钥匙在外面。界面要显示它而不是又生成一把
      queryOne(`
        SELECT id, code, expires_at FROM account_rebinds
         WHERE teacher_id = $1 AND status = 'pending' AND expires_at > now()
         ORDER BY id DESC LIMIT 1`, [id]),
    ]);

    const truncated = plans.rows.length > PLAN_LIMIT;
    const planRows = plans.rows.slice(0, PLAN_LIMIT);

    return ok(res, {
      teacher: {
        id: t.id,
        // 三层身份：人 / 位置 / 账号（016 迁移，operations.md 第 1 节）
        teacher_ref: t.teacher_ref,
        roster_entry_id: t.roster_entry_id,
        // 姓名全名只给超管。一般管理员做运营用不着 ——
        // 少一个人能看到，对老师的那句承诺就多一分是真的。
        // **手机号根本不存**（016 迁移删了那一列）
        real_name: req.isSuper ? t.real_name : `${surnameOf(t.real_name)}**`,
        name_masked: !req.isSuper,
        // 码不是身份信息（它不指向某个自然人），一般管理员也能看 ——
        // 否则她们连「这是谁」都答不上来，运营就做不了
        redeem_code: t.redeem_code,
        kindergarten: t.kindergarten,
        class_name: t.class_name,
        position: t.position,
        age_group: t.age_group,
        status: t.status,
        activated_at: t.activated_at,
        agreed_at: t.agreed_at,
        last_login_at: t.last_login_at,
      },
      quota,
      grants: grants.rows,
      // 一般管理员只看到「写完几份、什么时候写的、出到第几版」，看不到标题和内容。
      // 是**删掉字段**而不是置空：前端靠 title === undefined 判断该显示
      // 「超管可见」，置空会变成一个看不出原因的空格。
      // **plan_id 和 versions 必须一起拿掉** —— 给了 plan_id 她就能自己去敲 /plans/:id
      plans: req.isSuper ? planRows : planRows.map((p) => ({
        conversation_id: p.conversation_id, age_group: p.age_group,
        created_at: p.created_at, version: p.version, current_version: p.current_version,
      })),
      // 界面必须说出「只显示了最近 50 份」，否则那个数字会被当成总数
      plans_truncated: truncated,
      drafts: drafts.n,
      feedback: req.isSuper ? fb.rows : fb.rows.map(({ plan_title, ...f }) => f),
      // 数量和成本是用量，不是老师写的内容，所以不锁超管
      images: { ...img, by_purpose: purposes.rows },
      // 只给超管：换绑码能接管一整个账号
      pending_rebind: req.isSuper ? pendingRebind || null : undefined,
      can_view_content: req.isSuper,
    });
  })
);

/** 发额度。这是最常用的操作：老师完成新任务 → 加一笔 */
adminRouter.post(
  '/teachers/:id/grant',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const t = await queryOne(`SELECT id FROM teachers WHERE id = $1`, [id]);
    if (!t) throw notFound('没有这位老师');

    const dt = Number(req.body?.delta_text) || 0;
    const di = Number(req.body?.delta_image) || 0;
    const reason = String(req.body?.reason || '').trim();
    if (!dt && !di) throw badRequest('至少填一项额度');
    if (!reason) throw badRequest('写一下原因 —— 这是对账和研究记录的依据');

    await grantQuota({ teacherId: id, deltaText: dt, deltaImage: di, reason });
    // 多个人能改额度之后，「这 20 次是谁发的」必须能查
    await logAction({ adminId: req.adminId, action: 'grant_quota', target: `teacher:${id}`,
      detail: { delta_text: dt, delta_image: di, reason } });
    return ok(res, { quota: await getQuota(id) });
  })
);

/**
 * 「她换微信了」—— 生成一个换绑码（**超管专属**）。
 *
 * 为什么锁超管：这把钥匙能把一整个账号（教案、额度、记忆）交给另一个微信，
 * 比发额度敏感得多。
 *
 * 生成之前**必须线下核实这个人真是她**。不收手机号验证，所以只能问她
 * 只有她知道的东西：**她兑的是哪个码**（后台记着）或**她最近写的教案标题**。
 * 这一步没有技术保障，全靠人认真问 —— 见 operations.md 第 1.7 节。
 */
adminRouter.post('/teachers/:id/rebind-code', requireSuper, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const t = await queryOne(`SELECT id, status FROM teachers WHERE id = $1`, [id]);
  if (!t) throw notFound('没有这位老师');
  if (t.status === 'deleted') throw badRequest('这个账号已经注销了，没法换绑');

  // **已经有没用的就返回那一个**，不重复生成 ——
  // 否则外面同时有两把能接管她账号的钥匙，而我不知道另一把在谁手上
  const exist = await queryOne(
    `SELECT * FROM account_rebinds
      WHERE teacher_id = $1 AND status = 'pending' AND expires_at > now()
      ORDER BY id DESC LIMIT 1`, [id]);
  if (exist) {
    return ok(res, { code: exist.code, expires_at: exist.expires_at, reused: true });
  }

  let code = generateCode();
  for (let retry = 0; retry < 5; retry += 1) {
    const dup = await queryOne(
      `SELECT 1 FROM account_rebinds WHERE code = $1
        UNION ALL SELECT 1 FROM redemption_codes WHERE code = $1`, [code]);
    if (!dup) break;
    code = generateCode();
  }

  const row = await queryOne(
    // 7 天：我生成之后要在微信上告诉她，她不一定当场就换。
    // 但也不能无限期 —— 这把钥匙能接管一整个账号
    `INSERT INTO account_rebinds (code, teacher_id, expires_at, created_by)
     VALUES ($1, $2, now() + interval '7 days', $3) RETURNING *`,
    [code, id, req.adminId]);

  await logAction({ adminId: req.adminId, action: 'create_rebind_code', target: `teacher:${id}` });
  logger.warn('rebind_code_created', { by: req.adminId, teacher_id: id });
  return ok(res, { code: row.code, expires_at: row.expires_at, reused: false });
}));

adminRouter.post('/rebind-codes/:id/void', requireSuper, asyncRoute(async (req, res) => {
  const row = await queryOne(
    `UPDATE account_rebinds SET status = 'void'
      WHERE id = $1 AND status = 'pending' RETURNING id, teacher_id`, [Number(req.params.id)]);
  if (!row) throw badRequest('只有还没用过的换绑码可以作废');
  await logAction({ adminId: req.adminId, action: 'void_rebind_code',
    target: `teacher:${row.teacher_id}` });
  return ok(res, { voided: true });
}));

adminRouter.post(
  '/teachers/:id/status',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body?.status || '');
    if (!['active', 'disabled'].includes(status)) throw badRequest('状态不对');
    const t = await queryOne(
      `UPDATE teachers SET status = $1, updated_at = now() WHERE id = $2 RETURNING id, status`,
      [status, id]);
    if (!t) throw notFound('没有这位老师');
    logger.info('admin_teacher_status', { teacher_id: id, status });
    await logAction({ adminId: req.adminId, action: 'teacher_status', target: `teacher:${id}`, detail: { status } });
    return ok(res, t);
  })
);

// ---------------------------------------------------------------
// 兑换码
// ---------------------------------------------------------------
adminRouter.get(
  '/codes',
  asyncRoute(async (req, res) => {
    const status = String(req.query.status || 'all');
    const where = status === 'all' ? '' : `WHERE c.status = '${status === 'unused' ? 'unused' : status === 'used' ? 'used' : 'void'}'`;
    const rows = (await query(`
      SELECT c.*, k.name AS kindergarten, t.id AS teacher_id
        FROM redemption_codes c
        LEFT JOIN kindergartens k ON k.id = c.kindergarten_id
        LEFT JOIN teachers t ON t.id = c.used_by
      ${where}
       ORDER BY c.created_at DESC LIMIT 200`)).rows;
    return ok(res, {
      items: rows.map((r) => ({
        id: r.id, code: r.code,
        kindergarten: r.kindergarten,
        init_text: r.init_text, init_image: r.init_image,
        grant_reason: r.grant_reason,
        status: r.status, teacher_id: r.teacher_id,
        used_at: r.used_at, created_at: r.created_at,
      })),
    });
  })
);

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
adminRouter.post(
  '/codes',
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const row = await queryOne(
      `INSERT INTO redemption_codes
         (code, kindergarten_id, init_text, init_image, grant_reason)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        generateCode(),
        b.kindergarten_id ? Number(b.kindergarten_id) : null,
        Number(b.init_text) > 0 ? Number(b.init_text) : 20,
        Number(b.init_image) > 0 ? Number(b.init_image) : 10,
        String(b.grant_reason || '').trim() || '首次激活',
      ]
    );
    await logAction({ adminId: req.adminId, action: 'create_code', target: `code:${row.code}`,
      detail: { init_text: row.init_text, init_image: row.init_image } });
    logger.info('code_created', { by: req.adminId, code_id: row.id });
    return ok(res, { code: row.code, id: row.id });
  })
);

adminRouter.post(
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

// ---------------------------------------------------------------
// 园所
// ---------------------------------------------------------------
/**
 * 园所列表 —— 带用量汇总。
 *
 * 原来只有名字、备注、老师数，回答不了唯一真正要问的问题：
 * **这个园到底在不在用**。发出去 20 个码、兑了 1 个、那一个人写了 2 份就停了 ——
 * 这三个数摆在一行才看得出来，分散在三个页面就永远看不出来。
 *
 * 全部是聚合数，**不含任何老师个人信息**，所以一般管理员也能看全部。
 *
 * 写法上用标量子查询而不是多个 LEFT JOIN + GROUP BY：join 一多就会互相放大
 * （老师 × 教案 × 配图 的笛卡尔积让 COUNT 全部虚高），这是这类统计最常见的错。
 * 园所是几十行的表，多几个子查询无所谓。
 */
adminRouter.get('/kindergartens', asyncRoute(async (req, res) => {
  const rows = (await query(`
    SELECT k.id, k.name, k.note, k.created_at,
      -- 特征（010 迁移）。这不只是档案：**任务定向就筛这几个字段**
      k.province, k.city, k.area_type, k.ownership,
      k.teacher_count, k.child_count, k.contact_name, k.contact_phone,
      (SELECT COUNT(*)::int FROM teachers t
        WHERE t.kindergarten_id = k.id AND t.activated_at IS NOT NULL
          AND t.status <> 'deleted')                                        AS teachers,
      (SELECT COUNT(*)::int FROM teachers t
        WHERE t.kindergarten_id = k.id
          AND t.last_login_at > now() - interval '7 days')                  AS active_7d,
      (SELECT MAX(t.last_login_at) FROM teachers t
        WHERE t.kindergarten_id = k.id)                                     AS last_active_at,
      -- 码是挂在园所上发的，兑没兑得看这个：发了一批没人兑 = 这次合作没落地
      (SELECT COUNT(*)::int FROM redemption_codes c
        WHERE c.kindergarten_id = k.id AND c.status = 'unused')             AS codes_unused,
      (SELECT COUNT(*)::int FROM lesson_plans p JOIN teachers t ON t.id = p.teacher_id
        WHERE t.kindergarten_id = k.id)                                     AS plans,
      -- 额度跟老师页同一套算法：台账 Σ发放 −（教案数 + 超过 3 版的改稿次数）。
      -- 那个 3 是 quota.js 的 FREE_VERSION_CEILING（初稿 + 2 次免费改稿），
      -- 本文件的老师列表也硬写着同一个数 —— 改免费次数时三处一起改

      (SELECT COALESCE(SUM(g.delta_text),0)::int FROM quota_grants g
         JOIN teachers t ON t.id = g.teacher_id
        WHERE t.kindergarten_id = k.id)                                     AS granted_text,
      (SELECT COALESCE(SUM(1 + GREATEST(0, p.version - 3)),0)::int
         FROM lesson_plans p JOIN teachers t ON t.id = p.teacher_id
        WHERE t.kindergarten_id = k.id)                                     AS used_text,
      (SELECT COUNT(*)::int FROM lesson_images i
         JOIN lesson_plans p ON p.id = i.lesson_plan_id
         JOIN teachers t ON t.id = p.teacher_id
        WHERE t.kindergarten_id = k.id AND i.status = 'ready')              AS images,
      (SELECT COALESCE(SUM(i.cost_cents),0)::int FROM lesson_images i
         JOIN lesson_plans p ON p.id = i.lesson_plan_id
         JOIN teachers t ON t.id = p.teacher_id
        WHERE t.kindergarten_id = k.id AND i.status = 'ready')              AS cost_cents
      FROM kindergartens k ORDER BY k.name`)).rows;
  // 园长的号跟老师手机号同一条纪律：一般管理员只看打码。
  // 它不是老师的号，但「每多一个人能看到一个真实号码」的道理一样
  return ok(res, {
    items: rows.map((r) => ({
      ...r,
      contact_phone: req.isSuper ? r.contact_phone : maskPhone(r.contact_phone),
      contact_phone_masked: !req.isSuper,
    })),
  });
}));

/** 城乡与办园性质的合法值。定向要按它们筛，写歪一个字那个园就永远筛不到 */
const AREA_TYPES = ['city', 'county', 'rural'];
const OWNERSHIPS = ['public', 'private'];

/**
 * 从请求体里挑出园所特征字段。
 *
 * 语义是**只传哪项改哪项**：`undefined` = 不动，空字符串 = 清空。
 * 这两者必须分开——园所常常是先建一行，过几天才补齐省市和联系人，
 * 中间那些请求不该把没提到的字段刷成 null。
 */
function pickKgProfile(b, cur = {}) {
  const str = (k, max) => (b[k] === undefined
    ? cur[k] ?? null
    : String(b[k]).trim().slice(0, max) || null);
  const num = (k) => {
    if (b[k] === undefined) return cur[k] ?? null;
    const n = Number(b[k]);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };
  const enumOf = (k, allowed) => {
    if (b[k] === undefined) return cur[k] ?? null;
    const v = String(b[k]).trim();
    if (!v) return null;
    if (!allowed.includes(v)) throw badRequest(`${k} 只能是 ${allowed.join(' / ')}`);
    return v;
  };
  return {
    province: str('province', 16),
    city: str('city', 32),
    area_type: enumOf('area_type', AREA_TYPES),
    ownership: enumOf('ownership', OWNERSHIPS),
    teacher_count: num('teacher_count'),
    child_count: num('child_count'),
    contact_name: str('contact_name', 32),
    contact_phone: str('contact_phone', 20),
  };
}

const KG_PROFILE_COLS = [
  'province', 'city', 'area_type', 'ownership',
  'teacher_count', 'child_count', 'contact_name', 'contact_phone',
];

adminRouter.post('/kindergartens', asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw badRequest('填个园所名字');
  const dup = await queryOne(`SELECT id FROM kindergartens WHERE name = $1`, [name]);
  if (dup) throw badRequest('这个园所已经有了');

  const p = pickKgProfile(req.body || {});
  const row = await queryOne(
    `INSERT INTO kindergartens (name, note, ${KG_PROFILE_COLS.join(', ')})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [name, String(req.body?.note || '').trim() || null, ...KG_PROFILE_COLS.map((c) => p[c])]);
  await logAction({ adminId: req.adminId, action: 'create_kindergarten', target: `kg:${row.id}`,
    detail: { name: row.name } });
  return ok(res, row);
}));

/**
 * 改园所。
 *
 * 一开始只能改名字和备注（备注写的是「合作起止、联系人」这类会变的东西，
 * 原来建完就永远改不了 —— 联系人换了只能建第二个园，
 * 而「同一个园不能有两行」正是这张表存在的全部理由）。
 *
 * 现在把**全部特征字段**也放进来：园所往往是先建一行占位，
 * 过几天才从园长那儿问齐省市、城乡、办园性质、人数。
 * 而这几个字段是**任务定向的依据** —— 填不上就意味着这个园收不到任何定向任务。
 */
adminRouter.post('/kindergartens/:id/update', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await queryOne(`SELECT * FROM kindergartens WHERE id = $1`, [id]);
  if (!cur) throw notFound('没有这个园所');

  const b = req.body || {};
  const name = b.name === undefined ? cur.name : String(b.name).trim();
  if (!name) throw badRequest('园所名字不能空');
  if (name !== cur.name) {
    const dup = await queryOne(`SELECT id FROM kindergartens WHERE name = $1 AND id <> $2`, [name, id]);
    if (dup) throw badRequest('这个名字已经有别的园在用了');
  }
  const note = b.note === undefined ? cur.note : (String(b.note).trim() || null);
  const p = pickKgProfile(b, cur);

  const sets = KG_PROFILE_COLS.map((c, i) => `${c} = $${i + 4}`).join(', ');
  const row = await queryOne(
    `UPDATE kindergartens SET name = $2, note = $3, ${sets} WHERE id = $1 RETURNING *`,
    [id, name, note, ...KG_PROFILE_COLS.map((c) => p[c])]);
  await logAction({ adminId: req.adminId, action: 'update_kindergarten', target: `kg:${id}`,
    detail: { renamed: name !== cur.name } });
  return ok(res, row);
}));

// ---------------------------------------------------------------
// 内容与反馈
// ---------------------------------------------------------------
/**
 * 教案正文和对话记录 —— **只有超管**。
 * 这是老师写的东西，运营工作（建码、看反馈）根本用不到。
 *
 * `?version=2` 看历史版本（2026-08-18 加）。为什么要按版本看：
 * 老师标「用不了」是标在**某一个版本**上的（feedback 绑 plan_version），
 * 而 lesson_plans 那一行只存当前内容 —— 她改过之后，
 * 当前内容已经不是她当初评价的那一份了。看错版本等于看错了证据。
 */
adminRouter.get('/plans/:id', requireSuper, asyncRoute(async (req, res) => {
  const planId = Number(req.params.id);
  const p = await queryOne(
    `SELECT p.*, t.real_name, k.name AS kindergarten
       FROM lesson_plans p
       JOIN teachers t ON t.id = p.teacher_id
       LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
      WHERE p.id = $1`, [planId]);
  if (!p) throw notFound('没有这份教案');

  const versions = (await query(
    `SELECT version, revise_note, created_at FROM lesson_plan_versions
      WHERE lesson_plan_id = $1 ORDER BY version`, [planId])).rows;

  // 要看哪一版。不传 = 当前内容（lesson_plans 那一行）
  const want = req.query.version ? Number(req.query.version) : null;
  let shown = p;
  let shownVersion = p.current_version ?? p.version;
  if (want) {
    const snap = await queryOne(
      `SELECT * FROM lesson_plan_versions WHERE lesson_plan_id = $1 AND version = $2`,
      [planId, want]);
    if (!snap) throw notFound(`这份教案没有第 ${want} 版`);
    // 用快照覆盖内容字段，但**保留身份字段**（谁写的、哪个园）——
    // 那些不在版本快照里，它们不随版本变
    shown = { ...p, title: snap.title, age_group: snap.age_group,
      duration_min: snap.duration_min, content_md: snap.content_md,
      content_json: snap.content_json, quality_self: snap.quality_self };
    shownVersion = snap.version;
  }

  // 对话记录**给结构化数组**，界面上以 JSON 呈现（2026-08-18 用户定）：
  // 这一屏的用处是拿去做研究分析，一个能整块选中复制的 JSON 比排好的表更有用。
  // system 那条不在库里（每次实时拼装，见 001_init.sql 的注释），所以本来就不会出现
  const msgs = (await query(
    `SELECT role, content, payload, created_at FROM messages
      WHERE conversation_id = $1 ORDER BY id`, [p.conversation_id])).rows;

  return ok(res, {
    plan: shown,
    shown_version: shownVersion,
    versions,
    messages: msgs,
  });
}));

adminRouter.get('/feedback', asyncRoute(async (req, res) => {
  const kind = String(req.query.kind || 'all');
  const where = kind === 'all' ? '' : `WHERE f.kind = '${kind === 'lesson_rating' ? 'lesson_rating' : 'suggestion'}'`;
  const rows = (await query(`
    SELECT f.*, t.real_name, k.name AS kindergarten, p.title AS plan_title, p.age_group
      FROM feedback f
      JOIN teachers t ON t.id = f.teacher_id
      LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
      LEFT JOIN lesson_plans p ON p.id = f.lesson_plan_id
    ${where}
     ORDER BY f.created_at DESC LIMIT 200`)).rows;
  return ok(res, { items: rows });
}));

adminRouter.post('/feedback/:id/handled', asyncRoute(async (req, res) => {
  const row = await queryOne(
    `UPDATE feedback SET handled = $1 WHERE id = $2 RETURNING id, handled`,
    [req.body?.handled !== false, Number(req.params.id)]);
  if (!row) throw notFound('没有这条反馈');
  return ok(res, row);
}));

// ---------------------------------------------------------------
// 任务 —— 告诉老师现在有什么活动可以换额度（012 迁移）
//
// **任务不自动发额度**（用户定的）。它只承诺，到账靠我事后核对答卷、
// 建码发给她，她自己兑。系统不去猜「她是不是真填了」——
// 答卷在问卷星，我们库里没有。
// ---------------------------------------------------------------
adminRouter.get('/tasks', asyncRoute(async (req, res) => {
  const rows = (await query(`
    SELECT s.*, a.display_name AS created_by_name,
           (SELECT COUNT(*)::int FROM task_reads r WHERE r.task_id = s.id) AS reads
      FROM tasks s LEFT JOIN admins a ON a.id = s.created_by
     ORDER BY s.status = 'open' DESC, s.created_at DESC LIMIT 200`)).rows;

  // 每个任务算一次覆盖人数。任务是个位数，逐个试算无所谓；
  // 而「这个任务发给了几个人」不显示出来，那一页就只是一堆标题
  const items = [];
  for (const s of rows) {
    const p = await previewTarget(s.target);
    items.push({
      id: s.id, title: s.title, body: s.body, survey_url: s.survey_url,
      reward_text: s.reward_text, reward_image: s.reward_image,
      deadline: s.deadline, status: s.status, target: p.target,
      covers: p.teachers, unrestricted: p.unrestricted,
      reads: s.reads, created_by_name: s.created_by_name, created_at: s.created_at,
    });
  }
  return ok(res, { items });
}));

/**
 * 试算覆盖人数。
 *
 * **不是锦上添花**：定向条件叠到六层之后不试算没法确认筛对了，
 * 而发错是发给真人的。跟老师端 `GET /tasks` 共用 `buildMatchSql` ——
 * 写两份迟早分叉，分叉的表现是「后台说发给 12 个人，实际只有 8 个人看到」。
 */
adminRouter.post('/tasks/preview', asyncRoute(async (req, res) =>
  ok(res, await previewTarget(req.body?.target))));

function pickTask(b, cur = {}) {
  const str = (k, max) => (b[k] === undefined
    ? cur[k] ?? null : String(b[k]).trim().slice(0, max) || null);
  const num = (k) => {
    if (b[k] === undefined) return cur[k] ?? 0;
    const n = Number(b[k]);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  const url = str('survey_url', 500);
  // 问卷链接要能点开，所以必须是 http(s)。填了个「见群里」之类的东西
  // 界面上就会变成一个点不动的链接，而她不会知道为什么
  if (url && !/^https?:\/\//i.test(url)) {
    throw badRequest('问卷链接要以 http:// 或 https:// 开头');
  }
  return {
    title: str('title', 64),
    body: b.body === undefined ? cur.body ?? null : String(b.body).trim().slice(0, 2000) || null,
    survey_url: url,
    reward_text: num('reward_text'),
    reward_image: num('reward_image'),
    deadline: b.deadline === undefined ? cur.deadline ?? null : String(b.deadline).trim() || null,
    target: b.target === undefined ? normalizeTarget(cur.target) : normalizeTarget(b.target),
  };
}

adminRouter.post('/tasks', asyncRoute(async (req, res) => {
  const t = pickTask(req.body || {});
  if (!t.title) throw badRequest('给任务起个标题');
  // 建出来是**草稿**，不是直接发布 —— 发布是另一个动作，
  // 中间那一步就是给我机会试算一遍覆盖人数
  const row = await queryOne(
    `INSERT INTO tasks (title, body, survey_url, reward_text, reward_image,
                        deadline, target, created_by, status)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::jsonb,$8,'draft') RETURNING *`,
    [t.title, t.body, t.survey_url, t.reward_text, t.reward_image, t.deadline,
      JSON.stringify(t.target), req.adminId]);
  await logAction({ adminId: req.adminId, action: 'create_task', target: `task:${row.id}`,
    detail: { title: row.title } });
  return ok(res, row);
}));

adminRouter.post('/tasks/:id/update', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await queryOne(`SELECT * FROM tasks WHERE id = $1`, [id]);
  if (!cur) throw notFound('没有这个任务');
  const t = pickTask(req.body || {}, cur);
  if (!t.title) throw badRequest('标题不能空');

  const row = await queryOne(
    `UPDATE tasks SET title=$2, body=$3, survey_url=$4, reward_text=$5, reward_image=$6,
            deadline=$7::date, target=$8::jsonb, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [id, t.title, t.body, t.survey_url, t.reward_text, t.reward_image, t.deadline,
      JSON.stringify(t.target)]);
  await logAction({ adminId: req.adminId, action: 'update_task', target: `task:${id}` });
  return ok(res, row);
}));

adminRouter.post('/tasks/:id/publish', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await queryOne(`SELECT * FROM tasks WHERE id = $1`, [id]);
  if (!cur) throw notFound('没有这个任务');
  if (cur.status === 'open') throw badRequest('这个任务已经发布了');
  // 过了截止日期再发布，老师那边一条都看不到（列表按 deadline >= today 筛）——
  // 那是「发布成功了但没人收到」，最难查的一种
  if (cur.deadline && new Date(cur.deadline) < new Date(new Date().toDateString())) {
    throw badRequest('截止日期已经过了，改一下日期再发布');
  }
  const row = await queryOne(
    `UPDATE tasks SET status='open', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
  const p = await previewTarget(row.target);
  await logAction({ adminId: req.adminId, action: 'publish_task', target: `task:${id}`,
    detail: { covers: p.teachers } });
  logger.info('task_published', { by: req.adminId, task_id: id, covers: p.teachers });
  return ok(res, { ...row, covers: p.teachers });
}));

adminRouter.post('/tasks/:id/close', asyncRoute(async (req, res) => {
  const row = await queryOne(
    `UPDATE tasks SET status='closed', updated_at=now() WHERE id=$1 RETURNING id, status`,
    [Number(req.params.id)]);
  if (!row) throw notFound('没有这个任务');
  await logAction({ adminId: req.adminId, action: 'close_task', target: `task:${row.id}` });
  return ok(res, row);
}));

// ---------------------------------------------------------------
// 管理员账号 —— 全部只有超管能碰
// ---------------------------------------------------------------
adminRouter.get('/admins', requireSuper, asyncRoute(async (req, res) => {
  return ok(res, { items: await listAdmins(), me: req.adminId });
}));

adminRouter.post('/admins', requireSuper, asyncRoute(async (req, res) => {
  const b = req.body || {};
  try {
    const row = await createAdmin({
      username: b.username, password: b.password,
      role: b.role, displayName: b.display_name, createdBy: req.adminId,
    });
    await logAction({ adminId: req.adminId, action: 'create_admin',
      target: `admin:${row.username}`, detail: { role: row.role } });
    logger.info('admin_created', { by: req.adminId, admin_id: row.id, role: row.role });
    return ok(res, row);
  } catch (e) { throw badRequest(e.message); }
}));

adminRouter.post('/admins/:id/password', requireSuper, asyncRoute(async (req, res) => {
  try {
    const row = await setPassword(Number(req.params.id), req.body?.password);
    if (!row) throw notFound('没有这个账号');
    await logAction({ adminId: req.adminId, action: 'reset_password', target: `admin:${row.username}` });
    return ok(res, { id: row.id, username: row.username });
  } catch (e) { throw badRequest(e.message); }
}));

adminRouter.post('/admins/:id/status', requireSuper, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  // 不能停用自己 —— 停完就登不进来了，得手动改库才能救回来
  if (id === req.adminId) throw badRequest('不能停用自己的账号');

  const status = String(req.body?.status || '');
  if (!['active', 'disabled'].includes(status)) throw badRequest('状态不对');

  // 最后一个可用的超管不能被停用，否则没人能管账号了
  if (status === 'disabled') {
    const target = await queryOne(`SELECT role FROM admins WHERE id = $1`, [id]);
    if (target?.role === ROLES.SUPER) {
      const n = await queryOne(
        `SELECT COUNT(*)::int AS n FROM admins WHERE role = 'super' AND status = 'active'`);
      if (n.n <= 1) throw badRequest('这是最后一个超级管理员，停用之后就没人能管账号了');
    }
  }

  const row = await queryOne(
    `UPDATE admins SET status = $1 WHERE id = $2 RETURNING id, username, status`, [status, id]);
  if (!row) throw notFound('没有这个账号');
  await logAction({ adminId: req.adminId, action: 'admin_status',
    target: `admin:${row.username}`, detail: { status } });
  return ok(res, row);
}));

/** 改自己的密码 —— 这个一般管理员也能做，改的是自己的 */
adminRouter.post('/me/password', asyncRoute(async (req, res) => {
  const oldPwd = String(req.body?.old_password || '');
  const newPwd = String(req.body?.new_password || '');
  const me = await queryOne(`SELECT * FROM admins WHERE id = $1`, [req.adminId]);
  if (!me) throw notFound('账号不存在');
  if (!(await verifyPassword(oldPwd, me.password_hash, me.salt))) {
    throw badRequest('原密码不对');
  }
  try {
    await setPassword(req.adminId, newPwd);
    await logAction({ adminId: req.adminId, action: 'change_own_password' });
    return ok(res, { changed: true });
  } catch (e) { throw badRequest(e.message); }
}));

/**
 * 操作审计。多人之后「这笔额度是谁发的」必须能查。
 *
 * 2026-08-18 加了筛选和分页。一开始只是一张倒序裸表 LIMIT 200 ——
 * 攒到几百条之后它就废了：翻不动，而且第 201 条起根本看不到，
 * 也就是说「查得到」这件事在数据变多之后自己失效了，还不出声。
 *
 * `?admin_id=&action=&from=&to=&page=`，每页 100。
 * 也回一份 `admins` 和 `actions` 让筛选下拉只列**真正出现过的**值 ——
 * 列一堆从来没发生过的动作，筛选框自己就变成噪音。
 */
adminRouter.get('/logs', requireSuper, asyncRoute(async (req, res) => {
  const PER = 100;
  const page = Math.max(1, Number(req.query.page) || 1);

  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (req.query.admin_id) add('l.admin_id = $?', Number(req.query.admin_id));
  if (req.query.action) add('l.action = $?', String(req.query.action));
  if (req.query.from) add('l.created_at >= $?::date', String(req.query.from));
  // to 那天本身要算在里面，所以是「< 次日零点」而不是 <= 那天零点 ——
  // 写成 <= 会让当天的记录一条都筛不出来，而这种错很难看出来
  if (req.query.to) add("l.created_at < ($?::date + interval '1 day')", String(req.query.to));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [total, rows, admins, actions] = await Promise.all([
    queryOne(`SELECT COUNT(*)::int AS n FROM admin_logs l ${clause}`, params),
    query(`
      SELECT l.*, a.username, a.display_name
        FROM admin_logs l LEFT JOIN admins a ON a.id = l.admin_id
      ${clause}
       ORDER BY l.created_at DESC
       LIMIT ${PER} OFFSET ${(page - 1) * PER}`, params),
    query(`SELECT DISTINCT l.admin_id, a.username, a.display_name
             FROM admin_logs l LEFT JOIN admins a ON a.id = l.admin_id
            WHERE l.admin_id IS NOT NULL ORDER BY a.username`),
    query(`SELECT action, COUNT(*)::int AS n FROM admin_logs GROUP BY action ORDER BY n DESC`),
  ]);

  return ok(res, {
    items: rows.rows,
    total: total.n,
    page,
    pages: Math.max(1, Math.ceil(total.n / PER)),
    per_page: PER,
    admins: admins.rows,
    actions: actions.rows,
  });
}));

// ---------------------------------------------------------------
// 配图模型 —— **超管专属**
//
// 为什么不在小程序设置页里加：那一屏是给老师看的。加一个模型要填地址和 API key，
// 而「API key 只在服务端、任何情况不下发到小程序」是这个项目的铁律
// （CLAUDE.md）。让老师在手机上敲 key，等于把钥匙串挂在门上，
// 而且任何一个老师都能改所有人用的模型。
//
// 所以：**这里负责增删改（含 key），小程序设置页只负责选**。
// 老师那边拿到的永远只有 key/名字/一句话，没有地址也没有密钥。
// ---------------------------------------------------------------

/** key 一律遮住再下发。sk-abcd…wxyz 这种形状足够认出是哪一把，又拼不回原文 */
function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 12) return s ? '****' : '';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

adminRouter.get('/image-models', requireSuper, asyncRoute(async (req, res) => {
  const all = await listModels({ includeDisabled: true });
  return ok(res, {
    // 内置那两家也列出来，但标着 builtin —— 它们的 key 在 .env 里，后台改不了。
    // 不列的话会显得「明明在用却查不到」
    items: all.map((m) => ({
      key: m.key,
      name_cn: m.name_cn,
      hint: m.hint,
      format: m.format,
      builtin: m.builtin,
      enabled: m.enabled,
      sort_order: m.sort_order,
      model: m.account?.model || '',
      base_url: m.builtin ? '' : m.account?.baseURL || '',
      api_key_masked: maskKey(m.account?.apiKey),
    })),
    formats: Object.entries(FORMATS).map(([k, v]) => ({ key: k, cn: v.cn, hint: v.hint })),
    // 后台设过就以它为准，没设过才是 .env 那个 —— 跟 pickModel 的取值顺序保持一致，
    // 否则界面上显示的默认和实际用的会是两回事
    default_provider: await getSetting(SETTING_KEYS.imageProvider, config.imageProvider),
  });
}));

adminRouter.post('/image-models', requireSuper, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const key = String(b.key || '').trim().toLowerCase();
  // key 会存进 lesson_images.provider，所以限死字符集：以后按它统计、按它对账
  if (!/^[a-z0-9_-]{2,32}$/.test(key)) throw badRequest('模型代号只能用小写字母、数字、- 和 _，2–32 位');
  if (['gpt', 'minimax'].includes(key)) throw badRequest('这个代号是内置模型占用的，换一个');
  if (!isKnownFormat(b.format)) throw badRequest('不认识这个接口格式');
  if (!String(b.base_url || '').startsWith('http')) throw badRequest('接口地址要以 http 开头');
  if (!String(b.api_key || '').trim()) throw badRequest('填一下 API key');
  if (!String(b.model || '').trim()) throw badRequest('填一下模型名');

  const exists = await queryOne(`SELECT id FROM image_models WHERE key = $1`, [key]);
  if (exists) throw badRequest('这个代号已经有了');

  const row = await queryOne(
    `INSERT INTO image_models (key, name_cn, hint, format, base_url, api_key, model, options, enabled, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id, key`,
    [
      key,
      String(b.name_cn || key).slice(0, 40),
      String(b.hint || '').slice(0, 60),
      b.format,
      String(b.base_url).trim(),
      String(b.api_key).trim(),
      String(b.model).trim(),
      JSON.stringify(b.options || {}),
      b.enabled === false ? false : true,
      Number(b.sort_order) || 100,
    ]
  );
  // detail 里**不放 key**。审计表是给人翻的，密钥进去就等于多一个明文副本
  await logAction({
    adminId: req.adminId, action: 'create_image_model',
    target: `image_model:${key}`, detail: { format: b.format, model: b.model },
  });
  logger.info('image_model_created', { by: req.adminId, key, format: b.format });
  return ok(res, { id: row.id, key: row.key });
}));

adminRouter.post('/image-models/:key/update', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const b = req.body || {};
  const cur = await queryOne(`SELECT * FROM image_models WHERE key = $1`, [key]);
  if (!cur) throw notFound('没有这个模型（内置的两家改不了，它们在 .env 里）');

  // api_key 留空 = 不改。否则每次改个名字都要把密钥重新敲一遍，
  // 而界面上显示的是遮住的那串，敲回去只会把 sk-abcd…wxyz 存成真 key
  const nextKey = String(b.api_key || '').trim();
  const row = await queryOne(
    `UPDATE image_models
        SET name_cn = $2, hint = $3, base_url = $4, model = $5,
            options = $6::jsonb, enabled = $7, sort_order = $8,
            api_key = COALESCE(NULLIF($9, ''), api_key), updated_at = now()
      WHERE key = $1 RETURNING key, enabled`,
    [
      key,
      String(b.name_cn ?? cur.name_cn).slice(0, 40),
      String(b.hint ?? cur.hint).slice(0, 60),
      String(b.base_url ?? cur.base_url).trim(),
      String(b.model ?? cur.model).trim(),
      JSON.stringify(b.options ?? cur.options ?? {}),
      b.enabled === undefined ? cur.enabled : Boolean(b.enabled),
      Number(b.sort_order ?? cur.sort_order) || 100,
      nextKey,
    ]
  );
  await logAction({
    adminId: req.adminId, action: 'update_image_model',
    target: `image_model:${key}`, detail: { enabled: row.enabled, key_changed: Boolean(nextKey) },
  });
  return ok(res, { key: row.key, enabled: row.enabled });
}));

adminRouter.post('/image-models/:key/delete', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const row = await queryOne(`DELETE FROM image_models WHERE key = $1 RETURNING key`, [key]);
  if (!row) throw notFound('没有这个模型');
  // 已经用它画出来的图不动 —— lesson_images.provider 只是一条历史记录，
  // 删模型不该让老师的图消失
  await logAction({ adminId: req.adminId, action: 'delete_image_model', target: `image_model:${key}` });
  logger.info('image_model_deleted', { by: req.adminId, key });
  return ok(res, { deleted: true });
}));

/**
 * 试一张。加完一个模型最想知道的就是「它到底能不能出图」，
 * 而不是回到小程序、开一份教案、选材料、等一分钟才发现地址填错了。
 */
adminRouter.post('/image-models/:key/test', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const model = (await listModels({ includeDisabled: true })).find((m) => m.key === key);
  if (!model) throw notFound('没有这个模型');
  const prompt =
    String(req.body?.prompt || '').trim() ||
    'Black and white line drawing on pure white paper, thick solid black outlines. ' +
      'An empty printable chart: one plain table, 3 columns and 4 rows, every cell empty. ' +
      'Absolutely no text of any kind.';
  const t = Date.now();
  const img = await generateWith(model, { prompt, width: 1536, height: 2048, optimize: false });
  const { objectKey } = await uploadImage({ buffer: img.buffer, ext: img.ext || 'jpg' });
  await logAction({ adminId: req.adminId, action: 'test_image_model', target: `image_model:${key}` });
  return ok(res, {
    ok: true,
    ms: Date.now() - t,
    width: img.width,
    height: img.height,
    bytes: img.bytes,
    url: buildImageUrl(objectKey),
  });
}));

/**
 * 设为默认 —— 老师配图时用哪家。
 *
 * 存进 app_settings 而不是改 .env：改完**立刻生效，不用重启**。
 * 这个选择要经常改（哪家把记录表画对了、哪家快、哪家便宜，都是试出来的），
 * 锁在服务器文件里等于锁给会 ssh 的人。
 */
adminRouter.post('/image-models/:key/default', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const model = (await listModels()).find((m) => m.key === key);
  // 只能把**启用着且配好了**的设成默认。设一个停用的等于让所有老师立刻画不出图
  if (!model) throw badRequest('这个模型不存在，或者已停用 / 没配好，不能设成默认');

  await setSetting(SETTING_KEYS.imageProvider, key, req.adminId);
  await logAction({ adminId: req.adminId, action: 'set_default_image_model', target: `image_model:${key}` });
  logger.info('default_image_model_changed', { by: req.adminId, key });
  return ok(res, { default_provider: key });
}));

/**
 * 批量建码。
 *
 * **不需要名单**（2026-08-18 用户定）：直接要 N 个码，谁拿到谁能兑。
 * 用法是把导出的 CSV 灌进问卷星当奖励发放，或者整批交给园所。
 *
 * 因此「问卷答卷 ↔ 小程序账号」的对应关系**不在我们库里**了 ——
 * 它在问卷星那边（哪个手机号领到了哪个码）。后台按手机号搜不到这些老师，
 * 改成按**兑换码**搜（老师列表已经带上她用的那个码）。这是这次改动的真实代价，
 * 别指望还能像以前那样按手机号对账。
 */
adminRouter.post('/codes/batch', asyncRoute(async (req, res) => {
  const b = req.body || {};
  // 一次最多 200 个：再多就不是「发一批」而是「刷库」了，而且导出的 CSV 也没人看得完
  const count = Math.min(Math.max(Number(b.count) || 0, 1), 200);
  const initText = Number(b.init_text) > 0 ? Number(b.init_text) : 20;
  const initImage = Number(b.init_image) > 0 ? Number(b.init_image) : 10;
  const reason = String(b.grant_reason || '').trim() || '批量发放';
  const kgId = b.kindergarten_id ? Number(b.kindergarten_id) : null;

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
         (code, kindergarten_id, init_text, init_image, grant_reason, status)
       VALUES ($1,$2,$3,$4,$5,'unused')`,
      [code, kgId, initText, initImage, reason]
    );
    created.push(code);
  }

  await logAction({ adminId: req.adminId, action: 'create_codes_batch', target: `codes:${created.length}`,
    detail: { count: created.length, init_text: initText, init_image: initImage } });
  logger.info('codes_batch_created', { by: req.adminId, count: created.length });

  // 把这一批的参数一起回给前端：建完要在弹框里**一行一个**铺出来，
  // 还要能就地生成一份 CSV 发给某个园或某个平台。
  // 参数是整批共用的（都是刚才那张表单填的），所以不用每行都查一遍库
  const kg = kgId
    ? (await queryOne(`SELECT name FROM kindergartens WHERE id = $1`, [kgId]))?.name || null
    : null;
  return ok(res, {
    created,
    batch: { count: created.length, init_text: initText, init_image: initImage,
      grant_reason: reason, kindergarten: kg },
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
adminRouter.get('/codes/export', requireSuper, asyncRoute(async (req, res) => {
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
