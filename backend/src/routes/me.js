/**
 * GET /me · PATCH /me —— api-spec 第 2 节
 */
import { Router } from 'express';
import { queryOne } from '../db/pool.js';
import { toTeacherDTO } from '../middleware/auth.js';
import { ok, asyncRoute, badRequest } from '../utils/errors.js';
import { AGE_GROUPS } from '../services/promptBuilder.js';
import { msgSecCheck, contentBlockedError } from '../services/wechat.js';

export const meRouter = Router();

meRouter.get(
  '/',
  asyncRoute(async (req, res) => ok(res, toTeacherDTO(req.teacher)))
);

meRouter.patch(
  '/',
  asyncRoute(async (req, res) => {
    const body = req.body || {};

    // 只允许改这五项。白名单而不是黑名单：
    // 万一日后加了敏感列，忘了加进黑名单就会被前端改掉。
    const sets = [];
    const params = [];
    const push = (sql, value) => {
      params.push(value);
      sets.push(`${sql} = $${params.length}`);
    };

    if (body.nickname !== undefined) {
      const v = String(body.nickname || '').trim().slice(0, 64);
      push('nickname', v || null);
    }
    if (body.avatar_url !== undefined) {
      push('avatar_url', String(body.avatar_url || '').trim().slice(0, 500) || null);
    }
    if (body.kindergarten_name !== undefined) {
      const v = String(body.kindergarten_name || '').trim().slice(0, 128);
      push('kindergarten_name', v || null);
    }
    if (body.age_group !== undefined) {
      const v = String(body.age_group || '').trim();
      if (v && !AGE_GROUPS.includes(v)) {
        throw badRequest('年龄班只能是小班、中班或大班');
      }
      push('age_group', v || null);
    }
    if (body.teaching_years !== undefined) {
      const n = Number(body.teaching_years);
      if (body.teaching_years !== null && (!Number.isInteger(n) || n < 0 || n > 60)) {
        throw badRequest('教龄请填 0 到 60 之间的整数');
      }
      push('teaching_years', body.teaching_years === null ? null : n);
    }
    if (body.preferences !== undefined) {
      if (typeof body.preferences !== 'object' || Array.isArray(body.preferences) || body.preferences === null) {
        throw badRequest('偏好设置的格式不对');
      }
      // 合并而不是覆盖：前端只传改动的那一项，不用先读一遍再整个回写
      const merged = { ...(req.teacher.preferences || {}), ...body.preferences };
      push('preferences', JSON.stringify(merged));
    }

    if (!sets.length) return ok(res, toTeacherDTO(req.teacher));

    // 老师自己填的文字也是 UGC，要过内容安全（api-spec 第 10 节）
    const userText = [body.nickname, body.kindergarten_name].filter(Boolean).join(' ');
    if (userText) {
      const check = await msgSecCheck({
        content: userText,
        openid: req.teacher.openid,
        scene: 1, // 1 = 资料
        stage: 'profile',
      });
      if (!check.pass) throw contentBlockedError('teacher_input');
    }

    params.push(req.teacherId);
    const updated = await queryOne(
      `UPDATE teachers SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params
    );

    return ok(res, toTeacherDTO(updated));
  })
);
