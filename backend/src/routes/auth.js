/**
 * POST /auth/login —— api-spec 第 1 节
 *
 * 老师用**手机号 + 密码**登录。这是不需要 Authorization 的三个接口之一
 * （另外两个 /auth/activate 和 /auth/roster/options 在 routes/activate.js，
 * 都是「还没有账号的人」要用的）。
 *
 * 【为什么不再是 code2Session】（2026-09-20 改）
 * 2026-08-30 转向 web（ADR-002）。网页里没有 wx.login，拿不到 code，
 * 也没地方放 openid。原来那条静默登录的路随小程序一起作废了。
 *
 * 【手机号在这个系统里只是用户名】
 * 不用于联系、不进 AI 提示词、不下发到页面、不进日志。
 * 所以下面每一步都刻意不把它写进日志 —— 包括登录失败那一条，
 * 那一条原本最顺手记「是谁失败了」。
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { queryOne } from '../db/pool.js';
import { verifyPassword } from '../services/admins.js';
import { signToken, toTeacherDTO } from '../middleware/auth.js';
import { ok, asyncRoute, badRequest, AppError, ErrorCode } from '../utils/errors.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { normalizePhone } from '../utils/phone.js';

export const authRouter = Router();

authRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || '');

    if (!phone) throw badRequest('手机号看起来不对，是 11 位数字');
    if (!password) throw badRequest('请输入密码');

    const teacher = await queryOne(`SELECT * FROM teachers WHERE phone = $1`, [phone]);

    /* 手机号不存在时也跑一次哈希比较，让响应时间跟「密码错」一致 ——
       否则可以靠计时枚举出哪些号注册过。管理员登录那套（admin/index.js）同理。

       `?? ` 那两个兜底是给**迁移前的老行**留的：它们 phone 是 NULL，
       正常查不到；但万一有人手工填了 phone 没填哈希，这里会是 500 而不是 401。 */
    const okPwd = await verifyPassword(
      password,
      teacher?.password_hash ?? crypto.randomBytes(64).toString('hex'),
      teacher?.password_salt ?? 'x'
    );

    /* 🔴 两种失败**必须是同一句话**。
       分开说（「这个号没注册」/「密码不对」）等于白送一个
       「查这个手机号在不在我们库里」的接口 —— 而老师最怕的正是
       「园长知道我用了 AI 写教案」。 */
    if (!teacher || !okPwd) {
      logger.warn('teacher_login_failed', { ip: req.ip });
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: '手机号或密码不对' });
    }

    /* 注销过的账号不许再登录。

       ⚠️ **这条路现在是窄的**：注销会把手机号一并清掉，所以上面那句
       `WHERE phone = $1` 根本找不到注销过的行 —— 她再拿一个新码、用同一个手机号，
       会走激活流程建一个新账号。这是**认下来的代价**（api-spec「DELETE /me」一节）：
       要堵死「同一个手机号重新报名」就得留一份手机号哈希，
       那跟「删掉全部数据」直接矛盾。
       真正的门槛是**码**：我们只给填过问卷的人发码。

       那这一段为什么还留着？因为它是那道承诺唯一的技术表达，
       删掉之后「注销」就只是一个状态位了。留着，成本是六行。 */
    if (teacher.status === 'deleted') {
      logger.warn('login_rejected_deleted', { teacher_id: teacher.id });
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: '这个账号已经注销，数据都删掉了，没法再用了',
        detail: { reason: 'account_deleted' },
      });
    }

    const fresh = await queryOne(
      `UPDATE teachers SET last_login_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [teacher.id]
    );
    logger.info('teacher_login', { teacher_id: fresh.id });

    return ok(res, {
      token: signToken(fresh.id, fresh.token_version),
      expires_in: config.jwt.expiresInSeconds,
      teacher: toTeacherDTO(fresh),
    });
  })
);
