/**
 * POST /auth/login —— api-spec 第 1 节
 *
 * 唯一一个不需要 Authorization 的接口。
 */
import { Router } from 'express';
import { code2Session } from '../services/wechat.js';
import { queryOne } from '../db/pool.js';
import { signToken, toTeacherDTO } from '../middleware/auth.js';
import { ok, asyncRoute, badRequest } from '../utils/errors.js';
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

    // created_at 和 updated_at 是 Date 对象，必须比时间戳；直接用 === 比的是引用，永远 false
    const isNew = teacher.created_at?.getTime() === teacher.updated_at?.getTime();
    logger.info('login', { teacher_id: teacher.id, is_new: isNew });

    return ok(res, {
      token: signToken(teacher.id),
      expires_in: config.jwt.expiresInSeconds,
      teacher: toTeacherDTO(teacher),
    });
  })
);
