/**
 * 账号与协议 —— api-spec 第 1 节补充、operations.md 第 1/2 节
 *
 *   POST   /auth/redeem   续兑（要登录）
 *   POST   /me/agree      同意协议
 *   GET    /me/quota      余额 + 台账明细
 *   DELETE /me            注销
 *
 * 这几个都挂在 requireAuth 后面，但**不要求已激活**（首次激活那三个接口
 * 在 routes/activate.js，它们是公开的，因为调用它们的人还没有账号）。
 *
 * 【2026-09-20 改动】
 * 「首次激活」和「拉名单」搬去了 routes/activate.js。
 * 原来它们挂在这里，靠的是小程序时代的静默登录 —— 人人一进来都有 token。
 * web 端没有静默登录，「拉名单要有 token」+「有 token 要先有账号」就是死循环。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { ok, asyncRoute, badRequest, AppError, ErrorCode } from '../utils/errors.js';
import { normalizeCode } from '../utils/code.js';
import { getQuota, listGrants } from '../services/quota.js';
import { toTeacherDTO, signToken } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

export const accountRouter = Router();

// ---------------------------------------------------------------
// POST /auth/redeem —— 续兑
//
// 老师端只有一个输入框，她分不出也不需要分。后端按码的类型决定做哪件事：
//
//   topup     续兑   只要码，只加额度，身份一个字段都不动
//   rebind    换绑   挪 openid，不发额度，**响应带新 token**
//
// 首次激活**不在这里** —— 它在 routes/activate.js，因为调用它的人还没有账号。
// ---------------------------------------------------------------
accountRouter.post(
  '/redeem',
  asyncRoute(async (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!code) throw badRequest('请输入兑换码');

    // 先看是不是换绑码。它跟额度完全无关，走另一条路
    const rebind = await queryOne(`SELECT id FROM account_rebinds WHERE code = $1`, [code]);
    if (rebind) return doRebind(req, res, code);

    return doTopup(req, res, code);
  })
);

/**
 * 续兑（任务奖励）：**只要码，不问手机号** —— 她已经被识别过了。
 *
 * **身份一个字段都不动**：码上的手机号姓名一律忽略、连查重都不做。
 * 再拿码上的信息去覆盖只会把她的资料改坏
 * （用户原话：「任何手机都可以使用这个兑换码，兑换完之后会落到这个手机号所在的账户上而已」）。
 */
async function doTopup(req, res, code) {
  const result = await withTransaction(async (client) => {
    const row = (await client.query(
      `SELECT * FROM redemption_codes WHERE code = $1 FOR UPDATE`, [code])).rows[0];

    if (!row) return { err: '这个兑换码不存在，检查一下有没有敲错' };
    if (row.status === 'used') return { err: '这个兑换码已经被用过了' };
    if (row.status === 'void') return { err: '这个兑换码已经作废了，找发码给你的人要一个新的' };

    await client.query(
      `UPDATE redemption_codes SET status = 'used', used_by = $1, used_at = now() WHERE id = $2`,
      [req.teacherId, row.id]);
    await client.query(
      `INSERT INTO quota_grants (teacher_id, delta_text, delta_image, reason)
       VALUES ($1, $2, $3, $4)`,
      [req.teacherId, row.init_text, row.init_image, row.grant_reason || '兑换码']);

    return { granted: { text: row.init_text, image: row.init_image } };
  });

  if (result.err) throw badRequest(result.err);
  logger.info('quota_topped_up', {
    teacher_id: req.teacherId,
    granted_text: result.granted.text, granted_image: result.granted.image,
  });

  return ok(res, {
    kind: 'topup',
    teacher: toTeacherDTO(req.teacher),
    quota: await getQuota(req.teacherId),
    granted: result.granted,
  });
}

/**
 * 换绑：她换了微信号。
 *
 * 老师的身份就是 openid，换微信号 = 一个全新账号，
 * 她的教案、额度、记忆全在那个进不去的旧账号里。这条路把旧账号挪到新 openid 上。
 *
 * **不是「把名单那行改回 pending 让她重新领」** —— 那样会新建一个账号，
 * 教案拿不回来，而教案是这个产品全部的价值。
 */
async function doRebind(req, res, code) {
  const result = await withTransaction(async (client) => {
    // ---- 全部校验，一个字都还没写 ----
    const rb = (await client.query(
      `SELECT * FROM account_rebinds WHERE code = $1 FOR UPDATE`, [code])).rows[0];

    if (!rb) return { err: '这个码不存在，检查一下有没有敲错' };
    if (rb.status === 'used') return { err: '这个换绑码已经用过了' };
    if (rb.status === 'void') return { err: '这个换绑码已经作废了' };
    if (new Date(rb.expires_at).getTime() < Date.now()) {
      return { err: '这个换绑码过期了，找发码给你的人要一个新的' };
    }

    const target = (await client.query(
      `SELECT * FROM teachers WHERE id = $1 FOR UPDATE`, [rb.teacher_id])).rows[0];
    if (!target) return { err: '要换绑的那个账号不在了' };
    // 换绑回一个注销过的账号等于绕过注销 —— 那条承诺是「删完就不能再用」
    if (target.status === 'deleted') return { err: '那个账号已经注销了，没法再用' };

    if (target.id === req.teacherId) {
      return { err: '你已经在这个账号上了，不用换绑' };
    }

    // 当前这一行（新微信刚登录建的）**必须是空的**。
    // 不空说明她在新微信上已经写了东西 —— 换绑会把那些孤立掉，宁可拒绝
    const mine = (await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM conversations WHERE teacher_id = $1) AS convs,
         (SELECT COUNT(*)::int FROM quota_grants  WHERE teacher_id = $1) AS grants`,
      [req.teacherId])).rows[0];
    if (mine.convs > 0 || mine.grants > 0) {
      return { err: '这个微信上已经有内容了，换绑会把它弄丢。换绑只能在一个全新的微信上做' };
    }

    // ---- 校验全过了，从这里开始写 ----
    const oldOpenid = target.openid;
    const newOpenid = req.teacher.openid;

    // 先删当前那一空行，**释放 openid 的唯一约束**，否则下一句 UPDATE 会撞唯一索引。
    // 它是空的（上面刚校验过），删掉不丢任何东西
    await client.query(`DELETE FROM teachers WHERE id = $1`, [req.teacherId]);

    const moved = (await client.query(
      `UPDATE teachers
          SET openid = $1, unionid = COALESCE($2, unionid),
              nickname = COALESCE($3, nickname), avatar_url = COALESCE($4, avatar_url),
              -- **+1 让旧设备上那个 token 当场失效**（015 迁移）。
              -- 换绑不改 status，所以 requireAuth 那道「非 active 就拒」拦不住旧 token，
              -- 而换绑的常见起因之一就是手机丢了 —— 「换绑」这个词让人以为
              -- 旧设备立刻失去访问，假设错一个安全属性比没有它更糟
              token_version = token_version + 1,
              last_login_at = now(), updated_at = now()
        WHERE id = $5 RETURNING *`,
      [newOpenid, req.teacher.unionid, req.teacher.nickname, req.teacher.avatar_url, target.id]
    )).rows[0];

    await client.query(
      `UPDATE account_rebinds
          SET status = 'used', used_at = now(), old_openid = $1, new_openid = $2
        WHERE id = $3`,
      [oldOpenid, newOpenid, rb.id]);

    return { teacher: moved };
  });

  if (result.err) throw badRequest(result.err);

  // 账号所有权转移，必须留痕。日志里不放手机号姓名，只放 id
  logger.warn('account_rebound', {
    teacher_id: result.teacher.id,
    dropped_teacher_id: req.teacherId,
  });

  return ok(res, {
    kind: 'rebind',
    // **新 token 不是可选的**，而且有两个原因：
    //   1. 她手上那个 JWT 指向刚被删掉的那一空行
    //   2. 目标账号的 token_version 刚 +1，旧的全都失效了
    // 前端必须存下来（session.js 的 redeem()）
    token: signToken(result.teacher.id, result.teacher.token_version),
    expires_in: config.jwt.expiresInSeconds,
    teacher: toTeacherDTO(result.teacher),
    quota: await getQuota(result.teacher.id),
  });
}

// ---------------------------------------------------------------
// POST /me/agree
// ---------------------------------------------------------------
accountRouter.post(
  '/agree',
  asyncRoute(async (req, res) => {
    const t = await queryOne(
      `UPDATE teachers SET agreed_at = COALESCE(agreed_at, now()), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [req.teacherId]
    );
    logger.info('agreement_accepted', { teacher_id: req.teacherId });
    return ok(res, { teacher: toTeacherDTO(t) });
  })
);

// ---------------------------------------------------------------
// GET /me/quota
// ---------------------------------------------------------------
accountRouter.get(
  '/quota',
  asyncRoute(async (req, res) => {
    const [quota, grants] = await Promise.all([
      getQuota(req.teacherId),
      listGrants(req.teacherId),
    ]);
    return ok(res, {
      quota,
      // 台账给老师自己看 —— 能对账，额度就不是黑箱
      grants: grants.map((g) => ({
        text: g.delta_text,
        image: g.delta_image,
        reason: g.reason,
        at: g.created_at,
      })),
      free_revisions: 2,
    });
  })
);

/**
 * DELETE /me · 注销：删掉我的全部数据
 *
 * 老师明确要求的语义（2026-08-18）：
 *   - 删完**不能再用这个平台**
 *   - 已经用于科研的那部分**撤不回来**
 *
 * 所以不是 `DELETE FROM teachers`。真删行会连带两个后果：
 *   1. openid 没了 → 她再登录就是一个全新账号，等于"删完还能接着用"，与要求相反
 *   2. quota_grants 和 feedback 跟着级联消失 → 额度对账断了、已用于研究的记录也没了
 *
 * 做法是**留壳去身份**：
 *   删：对话、教案、版本、配图（连同磁盘文件）、记忆，
 *       以及**手机号、密码哈希**、姓名、昵称、头像、园所班级岗位
 *   留：teachers 那一行的 id（用来挂住额度台账和已提交的反馈与评价，
 *       它们从此不再关联到任何姓名和手机号）
 *
 * ⚠️ **「拒绝再次登录」这道闸现在是窄的。** 手机号被真删了，
 * 所以上面 `WHERE phone = $1` 找不到注销过的行 —— 她拿一个新码、用同一个号
 * 可以重新报名。要堵死它就得留手机号哈希，那跟「删掉全部数据」矛盾。
 * 真正的门槛是**码**：我们只给填过问卷的人发码。
 */
accountRouter.delete(
  '/',
  asyncRoute(async (req, res) => {
    const teacherId = req.teacherId;

    // 先把图片的 object_key 取出来 —— 行删掉之后就找不到磁盘上那些文件了
    const keys = (
      await query(
        `SELECT i.object_key FROM lesson_images i
           JOIN lesson_plans p ON p.id = i.lesson_plan_id
          WHERE p.teacher_id = $1 AND i.object_key <> ''`,
        [teacherId]
      )
    ).rows.map((r) => r.object_key);

    await withTransaction(async (client) => {
      // conversations 一删，messages / lesson_plans / lesson_plan_versions / lesson_images
      // 全部按外键级联跟着走（见 001_init.sql 的 ON DELETE CASCADE）
      await client.query(`DELETE FROM conversations WHERE teacher_id = $1`, [teacherId]);
      await client.query(`DELETE FROM teacher_memories WHERE teacher_id = $1`, [teacherId]);
      await client.query(
        /* 🔴 手机号和密码哈希**必须一起清掉**（2026-09-20 加）。
           它们是老师本人最直接的身份 —— 留着就等于「删了但没删干净」，
           而协议里写的是「删掉全部数据」。

           清掉手机号顺带产生一个后果：同一个号可以重新报名（唯一索引不再挡她）。
           这是**认下来的代价**，见 api-spec「DELETE /me」一节 ——
           要堵死它就得留一份手机号哈希，那跟这一句直接矛盾。 */
        `UPDATE teachers
            SET status = 'deleted',
                phone = NULL, password_hash = NULL, password_salt = NULL,
                real_name = NULL, nickname = NULL, avatar_url = NULL,
                kindergarten_name = NULL, kindergarten_id = NULL,
                class_name = NULL, position = NULL, age_group = NULL, teaching_years = NULL,
                roster_entry_id = NULL,
                preferences = '{}'::jsonb,
                updated_at = now()
          WHERE id = $1`,
        [teacherId]
      );
      /**
       * 她注销了，名单上那个位置**放回「等她来认领」**。
       *
       * 不这么做的话那一行永远是 claimed 而认领人已经是个空壳，
       * 那个位置就废了 —— 而位置是园所的，不是她的：
       * 明年这个班还有主班，只是换了人。
       *
       * 但 claimed_openid 留着不清：那是「谁认领过这个位置」的历史，
       * 出争议时要查得到（跟注销「留壳去身份」同一个道理 ——
       * 删的是她的身份，不是发生过的事）。
       */
      await client.query(
        `UPDATE teacher_roster
            SET status = 'pending', claimed_by = NULL, claimed_at = NULL
          WHERE claimed_by = $1`,
        [teacherId]
      );
    });

    // 磁盘文件尽力删。删不掉不该让注销失败 —— 库里已经没有引用了，
    // 剩下的是一堆没人指向的字节，比"她以为删了其实没删"好
    let filesRemoved = 0;
    for (const key of keys) {
      try {
        await fs.unlink(path.join(config.localImageDir, key));
        filesRemoved += 1;
      } catch (err) {
        /* 云存储或文件已不在，忽略 */
      }
    }

    // 日志里**不放**手机号姓名，只留 id 和数量 —— 注销这件事本身要留痕，但不能因此多存一份身份
    logger.warn('teacher_deleted', { teacher_id: teacherId, images_removed: filesRemoved });
    return ok(res, { deleted: true });
  })
);
