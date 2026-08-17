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
adminRouter.get(
  '/overview',
  asyncRoute(async (req, res) => {
    const s = await queryOne(`
      SELECT
        (SELECT COUNT(*) FROM teachers WHERE activated_at IS NOT NULL)::int AS teachers,
        (SELECT COUNT(*) FROM kindergartens)::int                            AS kindergartens,
        (SELECT COUNT(*) FROM redemption_codes WHERE status = 'unused')::int  AS codes_unused,
        (SELECT COUNT(*) FROM lesson_plans)::int                              AS plans,
        (SELECT COUNT(*) FROM lesson_images WHERE status = 'ready')::int      AS images,
        (SELECT COUNT(*) FROM feedback WHERE handled = false)::int            AS feedback_new
    `);
    return ok(res, s);
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
      // 按手机号或姓名搜 —— 从问卷答卷复制一个手机号过来直接粘，是最常用的操作
      where.push(`(t.phone LIKE $${params.length} OR t.real_name LIKE $${params.length})`);
    }

    const rows = (await query(`
      SELECT t.id, t.phone, t.real_name, t.position, t.class_name, t.age_group,
             t.last_login_at, t.activated_at, t.status,
             k.name AS kindergarten,
             COALESCE(g.text,0)::int  AS granted_text,
             COALESCE(g.image,0)::int AS granted_image,
             COALESCE(p.n,0)::int     AS plans,
             COALESCE(p.extra,0)::int AS extra_revisions,
             COALESCE(i.n,0)::int     AS images
        FROM teachers t
        LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
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

adminRouter.post(
  '/codes',
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const phone = String(b.phone || '').replace(/\D/g, '');
    if (!/^1\d{10}$/.test(phone)) throw badRequest('手机号看着不对，应该是 11 位');
    const realName = String(b.real_name || '').trim();
    if (!realName) throw badRequest('填一下姓名 —— 发额度时要知道是谁');

    // 同一个手机号已经激活过就别再发码了，否则她兑不了（激活时会撞手机号唯一约束）
    const dup = await queryOne(`SELECT id FROM teachers WHERE phone = $1`, [phone]);
    if (dup) throw badRequest('这个手机号已经激活过账号了，直接在她的页面加额度就行');
    const pending = await queryOne(
      `SELECT code FROM redemption_codes WHERE phone = $1 AND status = 'unused'`, [phone]);
    if (pending) throw badRequest(`这个手机号已经有一个没用的码：${pending.code}`);

    const row = await queryOne(
      `INSERT INTO redemption_codes
         (code, phone, real_name, kindergarten_id, class_name, position, age_group,
          init_text, init_image, grant_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [generateCode(), phone, realName,
       b.kindergarten_id ? Number(b.kindergarten_id) : null,
       String(b.class_name || '').trim() || null,
       String(b.position || '').trim() || null,
       String(b.age_group || '').trim() || null,
       Number(b.init_text) || 20, Number(b.init_image) || 10,
       String(b.grant_reason || '').trim() || '首次激活']
    );
    logger.info('admin_code_created', { code_id: row.id, kindergarten_id: row.kindergarten_id });
    await logAction({ adminId: req.adminId, action: 'create_code', target: `code:${row.code}`,
      detail: { init_text: row.init_text, init_image: row.init_image, reason: row.grant_reason } });
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
