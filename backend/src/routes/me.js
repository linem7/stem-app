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
import { queryOne, withTransaction } from '../db/pool.js';
import { toTeacherDTO } from '../middleware/auth.js';
import { ok, asyncRoute, badRequest } from '../utils/errors.js';
import { AGE_GROUPS } from '../services/promptBuilder.js';
import { POSITIONS, EDUCATIONS, TITLES } from '../services/roster.js';
import { getQuota } from '../services/quota.js';
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
    /* 出生年月（2026-09-21 加进档案）。
       🔴 **要在这儿也守一次，不能只靠 `POST /me/profile`。**
       「完善信息」那个入口填完之后她要能在「我的 → 个人档案」里改，
       而那条路走的是这个接口 —— 只守 profile 那条的话，
       她改档案时能存进 `1995-13` 这种值，而那条 CHECK 会直接 500。 */
    if (body.birth_month !== undefined) {
      const v = String(body.birth_month ?? '').trim();
      if (v && !/^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(v)) {
        throw badRequest('出生年月像 1995-12 这样填');
      }
      push('birth_month', v || null);
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

// ---------------------------------------------------------------
// POST /me/profile —— 完善信息领额度（2026-09-21 新增，api-spec 第 2 节）
//
// 她主动填四项档案（出生年份 / 最高学历 / 教龄 / 当前任教年级），
// 换 10 教案 + 5 配图。
//
// 🔴 **这是第一条「她主动提供信息换东西」的接口。**
// 跟记忆抽取那条红线（不提取姓名、年龄、幼儿表现、家庭情况、健康与过敏）
// **不冲突** —— 那条管的是「AI 从她聊天里推断」，这里是「她自己填的」。
// 两者的区别不是数据是什么，是**数据从哪来、她知不知情**。
//
// 【为什么跟 PATCH /me 是两个接口】
// `PATCH /me` 也改这几项（档案那一行），但**不发额度**。
// 合成一个的话，她反复改学历就能反复领 —— 而「改一改自己的档案」
// 是完全正常、应该随时能做的操作。**发额度这件事只认这一个接口。**
//
// ⚠️ **交叉影响，改动这两处中的任何一处都要一起看**：
//   · `PATCH /me` 能改 `education` / `teaching_years` / `age_group`（不能改 birth_year）
//   · 所以上面那句注释「kindergarten_name 和 teaching_years 只有这一条路能填」
//     对 teaching_years **已经不成立了** —— 本接口也能填。
//   · 于是 `profile_completed`（toTeacherDTO 里 = kindergarten_name && age_group）
//     **不能拿来当「完善过信息」的判据** —— 她改了 age_group 它就真了。
//     「有没有领过」只认 quota_grants 里那条 reason='完善信息' 的记录。
// ---------------------------------------------------------------
const PROFILE_REWARD_TEXT = 10;
const PROFILE_REWARD_IMAGE = 5;
const PROFILE_REWARD_REASON = '完善信息';

meRouter.post(
  '/profile',
  asyncRoute(async (req, res) => {
    const body = req.body || {};

    /* ---- 先全部校验，一个字都不写 ---- */

    /* 出生年月（2026-09-21 从「出生年」改成「年月」）。
       🔴 存 `YYYY-MM` 字符串，**不存 DATE** —— DATE 会带上「日」，
       而日是不收的：存成 `1995-12-01` 会让「她生日是 12 月 1 日」这个
       **不存在的信息**看起来像是收上来了。校验跟 024 迁移里那条 CHECK 一致。

       范围挡的是打错的（1995 打成 1895、19995，或者月份写成 13）。
       下限 1930 是「现在 96 岁」—— 幼师里可能有返聘的，
       但不会有人在 1930 年前出生还在带班。**宁可放宽，不要误拒真人。** */
    const born = String(body.birth_month || '').trim();
    const thisYear = new Date().getFullYear();
    if (!/^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(born)) {
      throw badRequest('出生年月像 1995-12 这样填');
    }
    const bornYear = Number(born.slice(0, 4));
    /* 🔴 **上限不能卡「至少 16 岁」。**
       2026-09-21 用户报「日期还是不对」—— 原因是原来这条写的是
       `bornYear > thisYear - 16`，而她填了 2014（测试时随手填的），
       于是被拒。而**报的文案跟格式错那条一模一样**，
       所以看起来像格式问题，实际上她填的格式完全正确。

       一个出生年月的校验不该替她算「她该几岁」：
       · 老师里有实习的、有刚满 18 的，界线定在哪儿都是猜
       · 而**猜错的表现是「她填对了却进不去」，且看不出为什么**
       · 真填错的（1895、2995）由下面那条下限和上上限挡住就够了
       所以上限放到「不能是未来」—— 那才是客观上错的。 */
    if (bornYear < 1930 || bornYear > thisYear) {
      throw badRequest('出生年月像是填错了，检查一下年份');
    }

    if (!EDUCATIONS.includes(body.education)) {
      throw badRequest(`最高学历从选项里选一下（${EDUCATIONS.join(' / ')}）`);
    }

    /* 职称（2026-09-21 用户要求加进完善信息）。
       ⚠️ 「未评级」是 `TITLES` 里**一个有意义的值**，不是「没填」——
       跟 `teaching_years: 0` 同一个立场。所以这里只判「在不在白名单里」。 */
    if (!TITLES.includes(body.professional_title)) {
      throw badRequest(`职称从选项里选一下（${TITLES.join(' / ')}）`);
    }

    /* ⚠️ `0` 在这个字段上是**有意义的值**（刚入职），不是「没填」。
       所以判据必须写成「不是整数」而不是 `!body.teaching_years` ——
       后者会把 0 挡掉，而 0 正是新人老师的真实情况。 */
    const years = Number(body.teaching_years);
    if (!Number.isInteger(years) || years < 0 || years > 60) {
      throw badRequest('教龄填 0 到 60 之间的整数');
    }

    if (!AGE_GROUPS.includes(body.age_group)) {
      throw badRequest(`当前任教年级从选项里选一下（${AGE_GROUPS.join(' / ')}）`);
    }

    const result = await withTransaction(async (client) => {
      /* 🔴 **防重复领的判据：查台账里有没有这一笔。**
         写在这里而不是事务外，而且加了 FOR UPDATE 挡并发 ——
         她手快双击提交，两次请求各自的快照都可能看不到对方，
         那就发两笔。锁住她那一行就够了（同一个 teacher_id 串行）。 */
      await client.query(`SELECT id FROM teachers WHERE id = $1 FOR UPDATE`, [req.teacherId]);

      /* 🔴 **判据不是「四个字段填全了没有」。**
         那样她把学历从大专改成本科会**再领一次** —— 因为改完还是「填全了」。
         领过就是领过，跟填得全不全无关。 */
      const already = (await client.query(
        `SELECT 1 FROM quota_grants WHERE teacher_id = $1 AND reason = $2 LIMIT 1`,
        [req.teacherId, PROFILE_REWARD_REASON])).rows[0];

      const updated = (await client.query(
        `UPDATE teachers
            SET birth_month = $1, education = $2, professional_title = $3,
                teaching_years = $4, age_group = $5,
                updated_at = now()
          WHERE id = $6
          RETURNING *`,
        [born, body.education, body.professional_title,
          years, body.age_group, req.teacherId])).rows[0];

      // 领过了就只改档案，不再发额度 —— **不是报错**：
      // 她改自己的档案是完全正常的操作，不该被拦
      if (already) return { teacher: updated, granted: null };

      await client.query(
        `INSERT INTO quota_grants (teacher_id, delta_text, delta_image, reason)
         VALUES ($1, $2, $3, $4)`,
        [req.teacherId, PROFILE_REWARD_TEXT, PROFILE_REWARD_IMAGE, PROFILE_REWARD_REASON]);

      return {
        teacher: updated,
        granted: { text: PROFILE_REWARD_TEXT, image: PROFILE_REWARD_IMAGE },
      };
    });

    /* 额度是 **SUM(quota_grants)** 算出来的（quota.js），
       所以刚插的那笔立刻就在里面，不用额外做什么。 */
    const quota = await getQuota(req.teacherId);

    return ok(res, {
      teacher: toTeacherDTO(result.teacher),
      quota,
      granted: result.granted,
    });
  })
);
