/**
 * 管理后台 API —— operations.md 第 6 节
 *
 * 与老师端**完全隔离**：不同的登录方式、不同的 token、不同的中间件。
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
 *
 * ---
 * 【这个目录怎么分的】（2026-09-01 从一个 2736 行的 admin.js 拆开）
 *
 * 一个域一个文件，每个文件自带一个 `Router()`，在这里按顺序挂上。
 * 🔴 **挂载顺序就是路由匹配顺序，别随手调。** Express 从上往下试，
 * 先挂的先匹配 —— 换了顺序不会报错，只会让某个路由再也走不到。
 *
 * ⚠️ 拆的时候发现「批量建码」和「导出 CSV」原来掉在文件最末尾、
 * 夹在模型管理后面，跟兑换码那一节隔着一千多行。现在合回 `codes.js` 了。
 * 挪到前面注册是安全的：那两条都是两段路径（`/codes/batch`、`/codes/export`），
 * 而前面的 `/codes/:id/void`、`/codes/batches/:id` 是三段，盖不住它们。
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { ok, asyncRoute, AppError, ErrorCode } from '../../utils/errors.js';
import { findAdmin, verifyPassword, touchLogin } from '../../services/admins.js';
import { logger } from '../../utils/logger.js';

import { overviewRouter } from './overview.js';
import { rosterRouter } from './roster.js';
import { teachersRouter } from './teachers.js';
import { codesRouter } from './codes.js';
import { kindergartensRouter } from './kindergartens.js';
import { contentRouter } from './content.js';
import { tasksRouter } from './tasks.js';
import { adminsRouter } from './admins.js';
import { modelsRouter } from './models.js';

export { requireAdmin } from './_shared.js';

export const adminRouter = Router();

const TOKEN_TTL = 12 * 3600; // 12 小时，一个工作日

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

// ---------------------------------------------------------------
// 各域。顺序 = 原来那个大文件里的注册顺序，别调。
// ---------------------------------------------------------------
adminRouter.use(overviewRouter);
adminRouter.use(rosterRouter);
adminRouter.use(teachersRouter);
adminRouter.use(codesRouter);
adminRouter.use(kindergartensRouter);
adminRouter.use(contentRouter);
adminRouter.use(tasksRouter);
adminRouter.use(adminsRouter);
adminRouter.use(modelsRouter);
