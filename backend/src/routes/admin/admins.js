import { Router } from 'express';
import { query, queryOne } from '../../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../../utils/errors.js';
import { ROLES, verifyPassword, createAdmin, setPassword, listAdmins, logAction } from '../../services/admins.js';
import { logger } from '../../utils/logger.js';
import { requireSuper } from './_shared.js';

export const adminsRouter = Router();

// ---------------------------------------------------------------
// 管理员账号 —— 全部只有超管能碰
// ---------------------------------------------------------------
adminsRouter.get('/admins', requireSuper, asyncRoute(async (req, res) => {
  return ok(res, { items: await listAdmins(), me: req.adminId });
}));

adminsRouter.post('/admins', requireSuper, asyncRoute(async (req, res) => {
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

adminsRouter.post('/admins/:id/password', requireSuper, asyncRoute(async (req, res) => {
  try {
    const row = await setPassword(Number(req.params.id), req.body?.password);
    if (!row) throw notFound('没有这个账号');
    await logAction({ adminId: req.adminId, action: 'reset_password', target: `admin:${row.username}` });
    return ok(res, { id: row.id, username: row.username });
  } catch (e) { throw badRequest(e.message); }
}));

adminsRouter.post('/admins/:id/status', requireSuper, asyncRoute(async (req, res) => {
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
adminsRouter.post('/me/password', asyncRoute(async (req, res) => {
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
 * 改自己的称呼。
 *
 * `admins` 表能算「个人基本信息」的就这一列（其余是 username / role / status /
 * password_hash / salt / created_by / 两个时间）—— 所以这个接口只有一个字段，
 * 不是漏了别的。
 *
 * 🔴 **用户名和角色在这里改不了**，哪怕请求体里带了也不看：
 *   · 改自己的角色 = 一般管理员把自己提成超管，绕过整套权限
 *   · 改用户名 = 操作记录里 `admin:username` 那些 target 全部指向一个不存在的人
 * 角色要变走 `/admins`（超管专属）。
 */
adminsRouter.post('/me/profile', asyncRoute(async (req, res) => {
  const name = String(req.body?.display_name ?? '').trim().slice(0, 32);
  if (!name) throw badRequest('称呼不能是空的');
  const row = await queryOne(
    `UPDATE admins SET display_name = $2 WHERE id = $1
     RETURNING id, username, role, display_name`,
    [req.adminId, name]
  );
  if (!row) throw notFound('账号不存在');
  await logAction({ adminId: req.adminId, action: 'update_own_profile', target: `admin:${row.username}` });
  return ok(res, { admin: row });
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
/**
 * 操作类型分成 5 组（2026-08-22 用户提：「类别太多了，约束一下，保持在 5 类之内」）。
 *
 * 原来那个下拉列的是**动作本身**，二十多项 —— 而人翻记录时想的从来不是
 * 「我要找 set_default_image_model」，是「谁动了后台设置」。
 *
 * 🔴 **`system` 是兜底组，用「不属于其他四组」定义，不是列举。**
 * 列举的话，以后新加一个动作（比如导出什么）就会**同时不属于任何一组** ——
 * 于是它在按组筛的时候一条都查不到，而全部记录里又看得见。
 * 那种「筛了就消失」的缺陷不报错，只让人以为记录丢了。
 */
const ACTION_GROUPS = [
  { key: 'quota', cn: '额度与兑换码',
    actions: ['grant_quota', 'create_code', 'create_codes_batch', 'void_code',
      'export_codes', 'delete_code_batches', 'add_topup'] },
  { key: 'org', cn: '园所与名单',
    actions: ['create_kindergarten', 'update_kindergarten', 'import_kindergartens',
      'import_roster', 'void_roster', 'reassign_roster'] },
  { key: 'task', cn: '任务',
    actions: ['create_task', 'update_task', 'publish_task', 'close_task'] },
  { key: 'teacher', cn: '教师账号',
    actions: ['teacher_status', 'create_rebind_code', 'void_rebind_code'] },
  // 兜底：管理员账号、配图模型、本人的密码与信息，外加任何新动作
  { key: 'system', cn: '后台管理', actions: null },
];
const GROUPED_ACTIONS = ACTION_GROUPS.flatMap((g) => g.actions || []);

/** 时间范围三档（2026-08-22 用户定）。手选起止日期撤掉了 */
const LOG_RANGES = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

adminsRouter.get('/logs', requireSuper, asyncRoute(async (req, res) => {
  // 每页 20，可选 50 / 100（2026-08-22 用户定）。原来写死 100 ——
  // 一屏根本铺不完，「翻页」那两个按钮等于永远不出现。
  // **白名单而不是直接收 Number(per)**：`?per=100000` 会把这一页变成
  // 一次全表扫描，而它是超管随手能改的 URL
  const PER = [20, 50, 100].includes(Number(req.query.per)) ? Number(req.query.per) : 20;
  const page = Math.max(1, Number(req.query.page) || 1);

  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (req.query.admin_id) add('l.admin_id = $?', Number(req.query.admin_id));
  // `action`（单个动作）**留着**：回归脚本按它断言，而且出事时按单个动作查更准。
  // 界面用的是 `group`
  if (req.query.action) add('l.action = $?', String(req.query.action));
  const group = ACTION_GROUPS.find((g) => g.key === String(req.query.group || ''));
  if (group) {
    if (group.actions) add('l.action = ANY($?)', group.actions);
    else add('NOT (l.action = ANY($?))', GROUPED_ACTIONS);   // 兜底组，见上面那段
  }
  const range = LOG_RANGES[String(req.query.range || '')];
  if (range) where.push(`l.created_at > now() - interval '${range}'`);
  // from / to 也留着（回归脚本在用）。界面已经改成三档预设，不再传它们。
  // to 那天本身要算在里面，所以是「< 次日零点」而不是 <= 那天零点 ——
  // 写成 <= 会让当天的记录一条都筛不出来，而这种错很难看出来
  if (req.query.from) add('l.created_at >= $?::date', String(req.query.from));
  if (req.query.to) add("l.created_at < ($?::date + interval '1 day')", String(req.query.to));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [total, rows, admins, groupCounts] = await Promise.all([
    queryOne(`SELECT COUNT(*)::int AS n FROM admin_logs l ${clause}`, params),
    query(`
      SELECT l.*, a.username
        FROM admin_logs l LEFT JOIN admins a ON a.id = l.admin_id
      ${clause}
       ORDER BY l.created_at DESC
       LIMIT ${PER} OFFSET ${(page - 1) * PER}`, params),
    query(`SELECT DISTINCT l.admin_id, a.username
             FROM admin_logs l LEFT JOIN admins a ON a.id = l.admin_id
            WHERE l.admin_id IS NOT NULL ORDER BY a.username`),
    // 每组多少条。下拉里带上条数，跟原来按动作列时一样 ——
    // 空组也列出来（不是「真正出现过的才列」那条规则的反例：
    // 五组是固定的语义分区，藏掉一组反而让人以为那类操作不存在）
    query(`SELECT action, COUNT(*)::int AS n FROM admin_logs GROUP BY action`),
  ]);

  const perAction = Object.fromEntries(groupCounts.rows.map((r) => [r.action, r.n]));
  const groups = ACTION_GROUPS.map((g) => ({
    key: g.key,
    cn: g.cn,
    n: g.actions
      ? g.actions.reduce((s, a) => s + (perAction[a] || 0), 0)
      : Object.entries(perAction).reduce((s, [a, n]) => s + (GROUPED_ACTIONS.includes(a) ? 0 : n), 0),
  }));

  return ok(res, {
    items: rows.rows,
    total: total.n,
    page,
    pages: Math.max(1, Math.ceil(total.n / PER)),
    per_page: PER,
    admins: admins.rows,
    groups,
    ranges: Object.keys(LOG_RANGES),
  });
}));
