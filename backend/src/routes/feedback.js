/**
 * 反馈 —— operations.md 第 4 节
 *
 *   POST /feedback                产品建议（「我的」页）
 *   POST /lesson-plans/:id/rate   教案评价（成稿页，挂在 lessonPlans 那边的路径下）
 *
 * 两类合一张表，靠 kind 区分。教案评价**绑 lesson_plan_id + version** ——
 * 这是关键：后台看到的是「大班搭高塔的 v2 被标了用不了，原文在这」，
 * 而不是一句无从查起的抱怨。CLAUDE.md 里「教案是否真的适龄可用」是这个产品最大的未知数，
 * 目前只有 3 个我自己跑的样本；这个字段一上线，它就变成每份教案都有的真实标注。
 */
import { Router } from 'express';
import { queryOne } from '../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../utils/errors.js';
import { msgSecCheck, contentBlockedError } from '../services/wechat.js';
import { logger } from '../utils/logger.js';

export const feedbackRouter = Router();

const CATEGORIES = ['quality', 'feature', 'usability', 'other'];
const RATINGS = ['usable', 'needs_edit', 'unusable'];

/** 反馈正文也是 UGC，规矩不变 */
async function checkText(text, openid) {
  if (!text) return;
  const c = await msgSecCheck({ content: text, openid, scene: 3, stage: 'teacher_input' });
  if (!c.pass) throw contentBlockedError('teacher_input');
}

// ---------------------------------------------------------------
// POST /feedback —— 产品建议
// ---------------------------------------------------------------
feedbackRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const category = String(req.body?.category || 'other');
    if (!CATEGORIES.includes(category)) throw badRequest('分类不对');

    const text = String(req.body?.text || '').trim().slice(0, 500);
    if (!text) throw badRequest('说说是什么事？');

    await checkText(text, req.teacher.openid);

    const row = await queryOne(
      `INSERT INTO feedback (teacher_id, kind, category, text)
       VALUES ($1, 'suggestion', $2, $3) RETURNING id, created_at`,
      [req.teacherId, category, text]
    );

    // 只记分类和长度，不记正文 —— 日志纪律
    logger.info('feedback_suggestion', {
      teacher_id: req.teacherId, feedback_id: row.id, category, len: text.length,
    });

    return ok(res, { id: row.id, received: true });
  })
);

/**
 * POST /lesson-plans/:id/rate —— 教案评价
 * 单独导出，由 lessonPlans 的路由挂进去（路径归属那边）。
 */
export const rateHandler = asyncRoute(async (req, res) => {
  const planId = Number(req.params.id);
  if (!Number.isInteger(planId) || planId <= 0) throw notFound('没有找到这份教案');

  const plan = await queryOne(
    `SELECT id, version FROM lesson_plans WHERE id = $1 AND teacher_id = $2`,
    [planId, req.teacherId]
  );
  if (!plan) throw notFound('没有找到这份教案');

  const rating = String(req.body?.rating || '');
  if (!RATINGS.includes(rating)) throw badRequest('请选一个评价');

  const text = String(req.body?.text || '').trim().slice(0, 500) || null;
  await checkText(text, req.teacher.openid);

  // 同一份教案的同一个版本只留最新一条：老师改主意是覆盖，不是叠加。
  // 唯一索引 idx_fb_plan_version 保证了这一点。
  const row = await queryOne(
    `INSERT INTO feedback (teacher_id, kind, lesson_plan_id, plan_version, rating, text)
     VALUES ($1, 'lesson_rating', $2, $3, $4, $5)
     ON CONFLICT (lesson_plan_id, plan_version) WHERE kind = 'lesson_rating'
     DO UPDATE SET rating = EXCLUDED.rating, text = EXCLUDED.text, created_at = now()
     RETURNING id`,
    [req.teacherId, plan.id, plan.version, rating, text]
  );

  logger.info('feedback_rating', {
    teacher_id: req.teacherId, lesson_plan_id: plan.id, version: plan.version, rating,
  });

  return ok(res, { id: row.id, rating, version: plan.version });
});
