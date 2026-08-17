/**
 * 管理员账号：密码哈希、认证、审计。
 *
 * 密码用 scrypt 加盐。不用明文、不用 md5、不用 sha256 裸哈希 ——
 * 这张表一旦泄露，攻击者拿到的是全部老师手机号和对话内容的入口。
 * scrypt 是 Node 自带的，不用装 bcrypt（省一个原生依赖，Windows 上编译 bcrypt 很折腾）。
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query, queryOne } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const scrypt = promisify(crypto.scrypt);

export const ROLES = { SUPER: 'super', ADMIN: 'admin' };

/** 超级管理员能做而一般管理员不能做的事 —— 都是「能看到老师最私密内容」的操作 */
export const SUPER_ONLY = {
  viewPhone: '看手机号全号',
  viewContent: '看对话正文和教案内容',
  manageAdmins: '管理管理员账号',
};

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = await scrypt(password, salt, 64);
  return { hash: buf.toString('hex'), salt };
}

export async function verifyPassword(password, hash, salt) {
  const buf = await scrypt(password, salt, 64);
  const a = Buffer.from(buf.toString('hex'), 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 启动时确保有一个超级管理员。
 *
 * 没有任何账号时，用 .env 的 ADMIN_PASSWORD 建一个 username=admin 的超管 ——
 * 否则升级到多账号之后没人能登进去，得手动改库才能启动，那是很糟的死锁。
 * 已经有账号了就什么都不做（不会用环境变量覆盖已改过的密码）。
 */
export async function ensureSuperAdmin() {
  const n = await queryOne(`SELECT COUNT(*)::int AS n FROM admins`);
  if (n.n > 0) return null;

  if (!config.admin.password) {
    logger.warn('admin_bootstrap_skipped', { reason: 'no ADMIN_PASSWORD' });
    return null;
  }
  const { hash, salt } = await hashPassword(config.admin.password);
  const row = await queryOne(
    `INSERT INTO admins (username, password_hash, salt, role, display_name)
     VALUES ('admin', $1, $2, 'super', '超级管理员') RETURNING id, username, role`,
    [hash, salt]
  );
  logger.info('admin_bootstrapped', { admin_id: row.id, username: row.username });
  return row;
}

export async function findAdmin(username) {
  return queryOne(
    `SELECT * FROM admins WHERE username = $1 AND status = 'active'`,
    [String(username || '').trim().toLowerCase()]
  );
}

export async function touchLogin(id) {
  await query(`UPDATE admins SET last_login_at = now() WHERE id = $1`, [id]);
}

export async function createAdmin({ username, password, role, displayName, createdBy }) {
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(u)) {
    throw new Error('用户名只能用小写字母、数字和下划线，3–32 位');
  }
  if (String(password || '').length < 6) throw new Error('密码至少 6 位');
  const dup = await queryOne(`SELECT id FROM admins WHERE username = $1`, [u]);
  if (dup) throw new Error('这个用户名已经有人用了');

  const { hash, salt } = await hashPassword(password);
  return queryOne(
    `INSERT INTO admins (username, password_hash, salt, role, display_name, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, username, role, display_name, status, created_at`,
    [u, hash, salt, role === ROLES.SUPER ? ROLES.SUPER : ROLES.ADMIN,
     String(displayName || '').trim() || null, createdBy]
  );
}

export async function setPassword(id, password) {
  if (String(password || '').length < 6) throw new Error('密码至少 6 位');
  const { hash, salt } = await hashPassword(password);
  return queryOne(
    `UPDATE admins SET password_hash = $1, salt = $2 WHERE id = $3 RETURNING id, username`,
    [hash, salt, id]
  );
}

export async function listAdmins() {
  const res = await query(
    `SELECT a.id, a.username, a.role, a.display_name, a.status, a.created_at, a.last_login_at,
            c.username AS created_by_name
       FROM admins a LEFT JOIN admins c ON c.id = a.created_by
      ORDER BY a.role DESC, a.created_at`
  );
  return res.rows;
}

/**
 * 记一条操作审计。
 *
 * 单人时期这张表没必要（"谁发的额度"答案永远是"我"）。
 * 多人之后它是对账的前提 —— 额度对不上时要能查出是谁在什么时候发的。
 * detail 里**不放对话正文**，只放操作参数。
 */
export async function logAction({ adminId, action, target, detail }) {
  try {
    await query(
      `INSERT INTO admin_logs (admin_id, action, target, detail) VALUES ($1,$2,$3,$4::jsonb)`,
      [adminId, action, target || null, JSON.stringify(detail || {})]
    );
  } catch (err) {
    // 审计失败不该让业务操作失败，但要留下痕迹
    logger.warn('admin_log_failed', { action, message: err.message });
  }
}
