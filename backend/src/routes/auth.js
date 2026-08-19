/**
 * POST /auth/login —— api-spec 第 1 节
 *
 * 唯一一个不需要 Authorization 的接口。
 */
import { Router } from 'express';
import { code2Session } from '../services/wechat.js';
import { queryOne } from '../db/pool.js';
import { signToken, toTeacherDTO } from '../middleware/auth.js';
import { ok, asyncRoute, badRequest, AppError, ErrorCode } from '../utils/errors.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export const authRouter = Router();

authRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const { code, nickname, avatar_url } = req.body || {};
    if (!code || typeof code !== 'string') {
      throw badRequest('登录信息不完整，请退出小程序重新进入');
    }

    const { openid, unionid } = await code2Session(code);

    // 一条 SQL 解决「没有就建、有就更新登录时间」。
    // nickname/avatar 用 COALESCE(EXCLUDED.x, 原值)：这次没传就保留上次的，
    // 避免老师后来改过昵称又被一次静默登录冲掉。
    const teacher = await queryOne(
      `INSERT INTO teachers (openid, unionid, nickname, avatar_url, last_login_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (openid) DO UPDATE SET
         unionid       = COALESCE(EXCLUDED.unionid, teachers.unionid),
         nickname      = COALESCE(EXCLUDED.nickname, teachers.nickname),
         avatar_url    = COALESCE(EXCLUDED.avatar_url, teachers.avatar_url),
         last_login_at = now(),
         updated_at    = now()
       RETURNING *`,
      [openid, unionid, nickname?.slice(0, 64) || null, avatar_url?.slice(0, 500) || null]
    );

    // 注销过的账号不许再登录。这是「删完就不能再用这个平台」那句承诺的技术兑现 ——
    // teachers 那一行是**留壳去身份**的：身份字段已经清空，只留 id 和 openid 用来认出她。
    // 拦在这里而不是等 requireAuth：那样她会先拿到一个 token、进到首页再被弹出来，
    // 看起来像「时好时坏」，而不是「这个账号注销了」。
    if (teacher.status === 'deleted') {
      logger.warn('login_rejected_deleted', { teacher_id: teacher.id });
      throw new AppError(ErrorCode.UNAUTHORIZED, {
        message: '这个账号已经注销，数据都删掉了，没法再用了',
        detail: { reason: 'account_deleted' },
      });
    }

    // created_at 和 updated_at 是 Date 对象，必须比时间戳；直接用 === 比的是引用，永远 false
    const isNew = teacher.created_at?.getTime() === teacher.updated_at?.getTime();
    logger.info('login', { teacher_id: teacher.id, is_new: isNew });

    return ok(res, {
      // 带上 token_version：换绑之后它 +1 了，新签的 token 必须用当前那个值
      token: signToken(teacher.id, teacher.token_version),
      expires_in: config.jwt.expiresInSeconds,
      teacher: toTeacherDTO(teacher),
    });
  })
);
