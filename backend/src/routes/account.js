/**
 * 账号激活与协议 —— api-spec 第 1 节补充、operations.md 第 1/2 节
 *
 *   POST /auth/redeem   兑换码激活（要登录，但不要求已激活）
 *   POST /me/agree      同意协议
 *   GET  /me/quota      余额 + 台账明细
 *
 * 这三个接口的共同点：它们是**激活前也能调**的，所以不能挂在 requireActivated 后面，
 * 否则老师会卡在「要激活才能激活」的死循环里。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { ok, asyncRoute, badRequest, AppError, ErrorCode } from '../utils/errors.js';
import { normalizeCode } from '../utils/code.js';
import { getQuota, listGrants } from '../services/quota.js';
import { toTeacherDTO } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

export const accountRouter = Router();

// ---------------------------------------------------------------
// POST /auth/redeem
// ---------------------------------------------------------------
accountRouter.post(
  '/redeem',
  asyncRoute(async (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!code) throw badRequest('请输入兑换码');

    if (req.teacher.activated_at) {
      throw badRequest('你的账号已经激活过了，不用再输码');
    }

    // 整个激活在一个事务里：绑身份、标记码已用、发首笔额度，
    // 三件事必须同生共死 —— 码标记成已用但额度没发，老师就永远拿不到了。
    const result = await withTransaction(async (client) => {
      // FOR UPDATE 挡住同一个码被两个人同时兑换
      const row = (
        await client.query(
          `SELECT * FROM redemption_codes WHERE code = $1 FOR UPDATE`,
          [code]
        )
      ).rows[0];

      if (!row) return { err: '这个兑换码不存在，检查一下有没有敲错' };
      if (row.status === 'used') return { err: '这个兑换码已经被用过了' };
      if (row.status === 'void') return { err: '这个兑换码已经作废了，找发码给你的人要一个新的' };

      // 手机号唯一：换了微信重新登录，不能靠新 openid 白拿一份额度。
      // **只对绑了手机号的码成立** —— 批量发的匿名码没有手机号，
      // 这道防线对它们天然不存在（谁拿到码谁能兑，这就是匿名码的定义）。
      // 真正的防线在码本身：一个码只能兑一次。
      if (row.phone) {
        const dup = (
          await client.query(
            `SELECT id FROM teachers WHERE phone = $1 AND id <> $2`,
            [row.phone, req.teacherId]
          )
        ).rows[0];
        if (dup) {
          return { err: '这个手机号已经激活过一个账号了。要是换了微信，找发码给你的人处理' };
        }
      }

      const teacher = (
        await client.query(
          // 一律 COALESCE：匿名码这几个字段都是空的，不能把老师已有的信息冲掉
          `UPDATE teachers
              SET phone = COALESCE($1, phone), real_name = COALESCE($2, real_name),
                  position = COALESCE($3, position), class_name = COALESCE($4, class_name),
                  kindergarten_id = COALESCE($5, kindergarten_id),
                  age_group = COALESCE($6, age_group),
                  activated_at = now(), updated_at = now()
            WHERE id = $7
            RETURNING *`,
          [row.phone, row.real_name, row.position, row.class_name,
           row.kindergarten_id, row.age_group, req.teacherId]
        )
      ).rows[0];

      await client.query(
        `UPDATE redemption_codes SET status = 'used', used_by = $1, used_at = now() WHERE id = $2`,
        [req.teacherId, row.id]
      );

      await client.query(
        `INSERT INTO quota_grants (teacher_id, delta_text, delta_image, reason)
         VALUES ($1, $2, $3, $4)`,
        [req.teacherId, row.init_text, row.init_image, row.grant_reason || '首次激活']
      );

      return { teacher, granted: { text: row.init_text, image: row.init_image } };
    });

    if (result.err) throw badRequest(result.err);

    // 日志不记手机号和姓名（三条铁律之一）
    logger.info('account_activated', {
      teacher_id: req.teacherId,
      kindergarten_id: result.teacher.kindergarten_id,
      granted_text: result.granted.text,
      granted_image: result.granted.image,
    });

    return ok(res, {
      teacher: toTeacherDTO(result.teacher),
      quota: await getQuota(req.teacherId),
      granted: result.granted,
    });
  })
);

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
 *   删：对话、教案、版本、配图（连同磁盘文件）、记忆，以及手机号/姓名/昵称/头像/园所班级岗位
 *   留：teachers 那一行的 id 和 openid（用来认出「这个人注销过」并拒绝再次登录）、
 *       额度台账、已提交的反馈与评价 —— 但它们从此不再关联到任何姓名和手机号
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
        `UPDATE teachers
            SET status = 'deleted',
                phone = NULL, real_name = NULL, nickname = NULL, avatar_url = NULL,
                kindergarten_name = NULL, kindergarten_id = NULL,
                class_name = NULL, position = NULL, age_group = NULL, teaching_years = NULL,
                preferences = '{}'::jsonb,
                updated_at = now()
          WHERE id = $1`,
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
