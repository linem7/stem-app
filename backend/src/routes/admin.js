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
import { logger } from '../utils/logger.js';

export const adminRouter = Router();

const TOKEN_TTL = 12 * 3600; // 12 小时，一个工作日

/** 139****1234 —— 保留前 3 后 4，够认人又不至于满屏号码 */
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
 * 概览。
 *
 * 原来是六个累计数（老师/园所/教案/配图…）。累计数**看一眼就没用了** ——
 * 它只会一直变大，不告诉你今天该做什么。这一屏要回答的是三个问题：
 *   1. 这东西还有人用吗（今天/近七天的量、活跃老师）
 *   2. 有什么在等我处理（反馈、失败的生成、快没额度的老师、码不够了）
 *   3. 我做的东西好不好、花了多少钱（教案评价分布、本月配图成本）
 */
adminRouter.get(
  '/overview',
  asyncRoute(async (req, res) => {
    const [s, quality, lowQuota, recent] = await Promise.all([
      queryOne(`
        SELECT
          (SELECT COUNT(*) FROM teachers WHERE activated_at IS NOT NULL AND status <> 'deleted')::int AS teachers,
          (SELECT COUNT(*) FROM teachers t WHERE t.last_login_at > now() - interval '7 days')::int    AS active_7d,
          (SELECT COUNT(*) FROM lesson_plans WHERE created_at::date = current_date)::int              AS plans_today,
          (SELECT COUNT(*) FROM lesson_plans WHERE created_at > now() - interval '7 days')::int       AS plans_7d,
          (SELECT COUNT(*) FROM lesson_images WHERE status = 'ready' AND created_at::date = current_date)::int AS images_today,
          (SELECT COUNT(*) FROM lesson_images WHERE status = 'failed' AND created_at > now() - interval '7 days')::int AS images_failed_7d,
          (SELECT COUNT(*) FROM conversations WHERE status = 'failed' AND updated_at > now() - interval '7 days')::int AS gen_failed_7d,
          (SELECT COUNT(*) FROM feedback WHERE handled = false)::int                                  AS feedback_new,
          (SELECT COUNT(*) FROM redemption_codes WHERE status = 'unused')::int                        AS codes_unused,
          -- 配图是主要成本项，按月看才有意义（cost_cents 是整数分，直接 SUM 不担心浮点）
          (SELECT COALESCE(SUM(cost_cents),0) FROM lesson_images
            WHERE status = 'ready' AND created_at >= date_trunc('month', now()))::int                 AS cost_cents_month
      `),
      // 教案评价分布 —— 「AI 写的教案是否真的适龄可用」是这个产品最大的未知数，
      // 这一行是它唯一的持续数据源，必须摆在概览上
      query(`SELECT rating, COUNT(*)::int n FROM feedback
              WHERE kind = 'rating' AND rating IS NOT NULL GROUP BY rating`),
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
      // 最近几份教案：光看数字不知道老师在写什么，这几行是「这东西被拿去干嘛了」的直观答案
      query(`
        SELECT p.id, p.title, p.age_group, p.created_at, k.name AS kindergarten
          FROM lesson_plans p
          LEFT JOIN teachers t ON t.id = p.teacher_id
          LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
         ORDER BY p.created_at DESC LIMIT 6`),
    ]);

    const byRating = Object.fromEntries(quality.rows.map((r) => [r.rating, r.n]));
    return ok(res, {
      ...s,
      quality: {
        usable: byRating.usable || 0,
        needs_edit: byRating.needs_edit || 0,
        unusable: byRating.unusable || 0,
      },
      low_quota: lowQuota.rows.map((r) => ({
        id: r.id,
        // 姓名也算身份信息，一般管理员只看得到姓氏
        name: req.isSuper ? r.real_name : `${String(r.real_name || '').slice(0, 1)}老师`,
        kindergarten: r.kindergarten,
        text_left: r.text_left,
      })),
      recent_plans: recent.rows.map((r) => ({
        id: r.id, title: r.title, age_group: r.age_group,
        kindergarten: r.kindergarten, created_at: r.created_at,
      })),
    });
  })
);

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
      // 手机号、姓名、**兑换码**都能搜。
      // 码这条是后加的：批量发的匿名码不带手机号，那批老师按手机号根本搜不到，
      // 只能靠「她兑的是哪个码」来对上问卷星那边的记录
      where.push(`(
        t.phone LIKE $${params.length - 1}
        OR t.real_name LIKE $${params.length - 1}
        OR REPLACE(REPLACE(rc.code, '-', ''), ' ', '') LIKE $${params.length}
      )`);
    }

    const rows = (await query(`
      SELECT t.id, t.phone, t.real_name, t.position, t.class_name, t.age_group,
             t.last_login_at, t.activated_at, t.status,
             k.name AS kindergarten,
             rc.code AS redeem_code,
             COALESCE(g.text,0)::int  AS granted_text,
             COALESCE(g.image,0)::int AS granted_image,
             COALESCE(p.n,0)::int     AS plans,
             COALESCE(p.extra,0)::int AS extra_revisions,
             COALESCE(i.n,0)::int     AS images
        FROM teachers t
        LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
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
          phone_masked: maskPhone(r.phone),   // 列表只给打码的
          real_name: r.real_name,
          redeem_code: r.redeem_code,         // 匿名码激活的老师只能靠它认人
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

adminRouter.get(
  '/teachers/:id',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const t = await queryOne(
      `SELECT t.*, k.name AS kindergarten FROM teachers t
         LEFT JOIN kindergartens k ON k.id = t.kindergarten_id WHERE t.id = $1`, [id]);
    if (!t) throw notFound('没有这位老师');

    const [quota, grants, convs, fb] = await Promise.all([
      getQuota(id),
      query(`SELECT delta_text, delta_image, reason, created_at FROM quota_grants
              WHERE teacher_id = $1 ORDER BY created_at DESC`, [id]),
      query(`SELECT c.id, c.title, c.status, c.age_group, c.created_at,
                    p.id AS plan_id, p.version
               FROM conversations c LEFT JOIN lesson_plans p ON p.conversation_id = c.id
              WHERE c.teacher_id = $1 AND c.deleted_at IS NULL
              ORDER BY c.created_at DESC LIMIT 50`, [id]),
      query(`SELECT id, kind, category, rating, text, lesson_plan_id, plan_version, created_at
               FROM feedback WHERE teacher_id = $1 ORDER BY created_at DESC`, [id]),
    ]);

    return ok(res, {
      teacher: {
        id: t.id,
        // 全号只给超管。一般管理员做运营用不着完整号码 ——
        // 少一个人能看到，对老师的那句承诺就多一分是真的
        phone: req.isSuper ? t.phone : maskPhone(t.phone),
        phone_masked: !req.isSuper,
        real_name: t.real_name,
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
      // 一般管理员只看到「写了几份、什么时候写的」，看不到标题和内容
      conversations: req.isSuper ? convs.rows : convs.rows.map((c) => ({
        id: c.id, status: c.status, age_group: c.age_group,
        created_at: c.created_at, version: c.version,
      })),
      feedback: fb.rows,
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
        phone_masked: maskPhone(r.phone),
        real_name: r.real_name,
        kindergarten: r.kindergarten,
        class_name: r.class_name, position: r.position, age_group: r.age_group,
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
 * **码不绑手机号**（2026-08-18 用户定）。原来必须填手机号和姓名，
 * 因为那时的模型是「一人一码、按手机号对账」；现在改成一批匿名码，
 * 谁拿到谁能兑 —— 发的时候不需要知道她是谁。
 *
 * 代价要说清楚：**我们库里不再有「问卷答卷 ↔ 小程序账号」的对应关系**。
 * 那份对应关系现在只存在于问卷星那边（哪个手机号领到了哪个码）。
 * 所以后台按手机号搜老师，对这些人搜不到 —— 改成按**兑换码**搜（老师列表已带上她用的码）。
 * 手机号姓名仍然可以填，填了就还是老规矩（一人一码 + 查重）。
 */
adminRouter.post(
  '/codes',
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const phone = String(b.phone || '').replace(/\D/g, '');
    const realName = String(b.real_name || '').trim();

    // 填了手机号就按老规矩查重：填了半个（比如 138）多半是敲错，不是想留空
    if (phone) {
      if (!/^1\d{10}$/.test(phone)) throw badRequest('手机号看着不对，应该是 11 位。不想绑就整个留空');
      const dup = await queryOne(`SELECT id FROM teachers WHERE phone = $1`, [phone]);
      if (dup) throw badRequest('这个手机号已经激活过账号了，直接在她的页面加额度就行');
      const pending = await queryOne(
        `SELECT code FROM redemption_codes WHERE phone = $1 AND status = 'unused'`, [phone]);
      if (pending) throw badRequest(`这个手机号已经有一个没用的码：${pending.code}`);
    }

    const row = await queryOne(
      `INSERT INTO redemption_codes
         (code, phone, real_name, kindergarten_id, class_name, position, age_group,
          init_text, init_image, grant_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        generateCode(),
        phone || null,
        realName || null,
        b.kindergarten_id ? Number(b.kindergarten_id) : null,
        b.class_name || null,
        b.position || null,
        b.age_group || null,
        Number(b.init_text) > 0 ? Number(b.init_text) : 20,
        Number(b.init_image) > 0 ? Number(b.init_image) : 10,
        String(b.grant_reason || '').trim() || '首次激活',
      ]
    );
    await logAction({ adminId: req.adminId, action: 'create_code', target: `code:${row.code}`,
      detail: { init_text: row.init_text, init_image: row.init_image, bound: Boolean(phone) } });
    logger.info('code_created', { by: req.adminId, code_id: row.id, bound: Boolean(phone) });
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
adminRouter.get('/kindergartens', asyncRoute(async (req, res) => {
  const rows = (await query(`
    SELECT k.*, COUNT(t.id)::int AS teachers
      FROM kindergartens k LEFT JOIN teachers t ON t.kindergarten_id = k.id AND t.activated_at IS NOT NULL
     GROUP BY k.id ORDER BY k.name`)).rows;
  return ok(res, { items: rows });
}));

adminRouter.post('/kindergartens', asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw badRequest('填个园所名字');
  const dup = await queryOne(`SELECT id FROM kindergartens WHERE name = $1`, [name]);
  if (dup) throw badRequest('这个园所已经有了');
  const row = await queryOne(
    `INSERT INTO kindergartens (name, note) VALUES ($1,$2) RETURNING *`,
    [name, String(req.body?.note || '').trim() || null]);
  return ok(res, row);
}));

// ---------------------------------------------------------------
// 内容与反馈
// ---------------------------------------------------------------
// 教案正文和对话记录 —— **只有超管**。
// 这是老师写的东西，运营工作（发额度、建码、看反馈）根本用不到。
adminRouter.get('/plans/:id', requireSuper, asyncRoute(async (req, res) => {
  const p = await queryOne(
    `SELECT p.*, t.real_name, k.name AS kindergarten
       FROM lesson_plans p
       JOIN teachers t ON t.id = p.teacher_id
       LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
      WHERE p.id = $1`, [Number(req.params.id)]);
  if (!p) throw notFound('没有这份教案');
  const msgs = (await query(
    `SELECT role, content, payload, created_at FROM messages
      WHERE conversation_id = $1 ORDER BY id`, [p.conversation_id])).rows;
  return ok(res, { plan: p, messages: msgs });
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

/** 操作审计。多人之后「这笔额度是谁发的」必须能查。 */
adminRouter.get('/logs', requireSuper, asyncRoute(async (req, res) => {
  const rows = (await query(`
    SELECT l.*, a.username, a.display_name
      FROM admin_logs l LEFT JOIN admins a ON a.id = l.admin_id
     ORDER BY l.created_at DESC LIMIT 200`)).rows;
  return ok(res, { items: rows });
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
  return ok(res, { created });
}));

/**
 * 导出 CSV。
 *
 * **超管专属**：里面是手机号全号。一般管理员在列表里看到的是遮住的，
 * 导出要是不设限，那道遮挡就形同虚设。
 */
adminRouter.get('/codes/export', requireSuper, asyncRoute(async (req, res) => {
  const status = String(req.query.status || 'unused');
  const only = String(req.query.code || '').trim();
  const params = [];
  let where = '';
  if (only) { params.push(only); where = `WHERE c.code = $${params.length}`; }
  else if (status !== 'all') { params.push(status); where = `WHERE c.status = $${params.length}`; }

  const rows = (await query(`
    SELECT c.code, c.phone, c.real_name, c.class_name, c.position, c.age_group,
           c.init_text, c.init_image, c.status, c.created_at, k.name AS kindergarten
      FROM redemption_codes c
      LEFT JOIN kindergartens k ON k.id = c.kindergarten_id
    ${where} ORDER BY c.created_at DESC LIMIT 2000`, params)).rows;

  const head = ['兑换码', '手机号', '姓名', '幼儿园', '班级', '岗位', '年龄班', '教案额度', '配图额度', '状态', '创建时间'];
  // 手机号前面加制表符，否则 Excel 会把 13800000000 显示成 1.38E+10
  const csv = [head.join(',')].concat(
    rows.map((r) => [
      r.code, `\t${r.phone}`, r.real_name || '', r.kindergarten || '', r.class_name || '',
      r.position || '', r.age_group || '', r.init_text, r.init_image,
      r.status, new Date(r.created_at).toISOString().slice(0, 10),
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
  ).join('\r\n');

  await logAction({ adminId: req.adminId, action: 'export_codes', target: `codes:${rows.length}`,
    detail: { status, count: rows.length, single: Boolean(only) } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="codes-${status}.csv"`);
  // BOM：没有它 Excel 打开中文列头是乱码
  res.send('﻿' + csv);
}));
