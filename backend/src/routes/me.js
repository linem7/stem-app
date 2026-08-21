/**
 * GET /me · PATCH /me —— api-spec 第 2 节
 *
 * **改档案两个方法指向同一个 handler**：
 *   PATCH /me          —— 语义正确的那个
 *   POST  /me/update   —— 给小程序用，因为 **wx.request 发不出 PATCH**
 * 同 memories.js 那条别名，理由一模一样。
 *
 * ⚠️ `kindergarten_name` 和 `teaching_years` **只有这一条路能填**。
 * 激活只从名单写 kindergarten_id 和 age_group（account.js），
 * 而 toTeacherDTO 里 profile_completed = kindergarten_name && age_group ——
 * 在这个接口有调用方之前，那个标记对任何老师都恒为 false。
 * 它没被当闸门用（激活闸门查 activated_at），但别拿它当「档案填全了」的依据。
 */
import { Router } from 'express';
import { queryOne } from '../db/pool.js';
import { toTeacherDTO } from '../middleware/auth.js';
import { ok, asyncRoute, badRequest } from '../utils/errors.js';
import { AGE_GROUPS } from '../services/promptBuilder.js';
import { POSITIONS, EDUCATIONS, TITLES } from '../services/roster.js';
import { msgSecCheck, contentBlockedError } from '../services/wechat.js';

export const meRouter = Router();

meRouter.get(
  '/',
  asyncRoute(async (req, res) => ok(res, toTeacherDTO(req.teacher)))
);

const updateMe = asyncRoute(async (req, res) => {
    const body = req.body || {};

    /*
      白名单而不是黑名单：万一日后加了敏感列，忘了加进黑名单就会被前端改掉。

      现在这份是「我的」页那一行档案涵盖的六项（用户 2026-08-21 定）
      —— 园所 / 年级 / 岗位 / 最高学历 / 职称 / 教龄 —— 加上昵称、头像、偏好。

      ⚠️ **`position` 是可以被她改的，改了会跟名单那一行不一致。** 这是有意的：
      `teacher_roster.position` 是研究记录（谁在哪个位置上、什么时候换的），
      `teachers.position` 是她自己的档案。两者本来就该允许分开 ——
      名单是园所报上来的一次快照，而她可能这学期就从配班变主班了。
      要追「这个班的主班是谁」查名单，不查这里。
      任务定向的六维**不含 position**（services/tasks.js 的 TARGET_DIMS），
      所以改它不会影响她能看到哪些任务；`age_group` 会，而那本来就该跟着她带的班走。
    */
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
    /*
      岗位 / 最高学历 / 职称 —— 三项都是白名单里挑一个，或者传 null 清空。

      清空要发 `null`，不是 `''`：判空用的是 `!== undefined`，
      所以「传了空串」和「传了 null」都走到这里，`v || null` 把两者都归成 NULL。
      而**没传这个键**才是「这一项不改」。前端那边同一个约定。
    */
    for (const [key, allowed, label] of [
      ['position', POSITIONS, '岗位'],
      ['education', EDUCATIONS, '最高学历'],
      ['professional_title', TITLES, '职称'],
    ]) {
      if (body[key] === undefined) continue;
      const v = String(body[key] ?? '').trim();
      if (v && !allowed.includes(v)) {
        // 把可选项列出来 —— 只说「不对」的话，她（或者调接口的我）不知道该填什么
        throw badRequest(`${label}只能是：${allowed.join('、')}`);
      }
      push(key, v || null);
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
  });

meRouter.patch('/', updateMe);
meRouter.post('/update', updateMe);
