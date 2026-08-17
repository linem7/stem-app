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
import { Router } from 'express';
import { query, queryOne, withTransaction } from '../db/pool.js';
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

      // 手机号唯一：换了微信重新登录，不能靠新 openid 白拿一份额度
      const dup = (
        await client.query(
          `SELECT id FROM teachers WHERE phone = $1 AND id <> $2`,
          [row.phone, req.teacherId]
        )
      ).rows[0];
      if (dup) {
        return { err: '这个手机号已经激活过一个账号了。要是换了微信，找发码给你的人处理' };
      }

      const teacher = (
        await client.query(
          `UPDATE teachers
              SET phone = $1, real_name = $2, position = $3, class_name = $4,
                  kindergarten_id = $5,
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
