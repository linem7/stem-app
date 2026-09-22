/**
 * 反馈 —— operations.md 第 4 节
 *
 *   POST /feedback   产品建议（「我的」页）
 *
 * 【教案评价已删】（2026-09-21 用户定）
 *
 * 原来还有 `POST /lesson-plans/:id/rate`（成稿页底部问「这份教案能直接用吗？」
 * 三档：直接能用 / 改改能用 / 用不了）。用户的原话：
 *
 *   「我不要这个功能了，我觉得多余，页面最下方也有让教师重修教案的按键，
 *     假如要重修意味着当前教案不行。两者在功能上重复了」
 *
 * **这个理由是对的**：成稿页底下那条「哪里不对？我来改」已经表达同一件事，
 * 而且它更长 —— 她点进去要说清哪里不对，那比一个三档的选择信息量大得多。
 * 两个入口并排，她会犹豫点哪个，而其中一个是多余的那个。
 *
 * ⚠️ **`feedback` 表**不删（产品建议还在用），`kind = 'lesson_rating'` 那几列
 * （`lesson_plan_id` / `plan_version` / `rating`）**留在表上不删** ——
 * 库里还有历史行，删列会让它们失去含义。新代码不再写那几列。
 * 管理端那三档统计也一起撤了（见 `admin/app.js`）。
 */
import { Router } from 'express';
import { queryOne } from '../db/pool.js';
import { ok, asyncRoute, badRequest } from '../utils/errors.js';
import { checkText, contentBlockedError } from '../services/contentSafety.js';
import { logger } from '../utils/logger.js';

export const feedbackRouter = Router();

const CATEGORIES = ['quality', 'feature', 'usability', 'other'];

/** 反馈正文也是 UGC，规矩不变。
    ⚠️ 这个包装函数**不能叫 checkText** —— 会跟上面 import 进来的那个同名，
    形成「函数调用自己」的无限递归（2026-09-22 切换时真撞上了）。 */
async function checkFeedbackText(text) {
  if (!text) return;
  const c = await checkText({ content: text, stage: 'teacher_input' });
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

    await checkFeedbackText(text);

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

