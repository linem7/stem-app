/**
 * 教案会话 —— api-spec 第 3 节和第 7 节
 *
 *   POST   /conversations            开新会话，直接返回第一题
 *   POST   /conversations/:id/answer 答一题，拿下一题
 *   GET    /conversations/:id        断点续写时拉全量
 *   GET    /conversations            教案库列表（cursor 分页）
 *   DELETE /conversations/:id        软删除
 *
 * 贯穿这个文件的一条纪律：**先落库，再调模型**。
 * PRD 要求老师被打断退出后进度不丢，而模型调用是最慢也最容易失败的一步。
 * 顺序反了的话，模型超时会把老师刚答的那题一起弄丢。
 */
import { Router } from 'express';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../utils/errors.js';
import { limitNewConversation } from '../middleware/rateLimit.js';
import { msgSecCheck, contentBlockedError } from '../services/wechat.js';
import { listMemories } from '../services/memoryExtractor.js';
import { fallbackTitle } from '../services/lessonGenerator.js';
import {
  QUESTION_PLAN,
  TOTAL_ROUNDS,
  planIndexOf,
  positionOf,
  buildProgress,
  buildNextStep,
  resolveAnswer,
  clampDuration,
  canFinish,
  isFinished,
  progressText,
} from '../services/guideFlow.js';
import { logger } from '../utils/logger.js';

export const conversationsRouter = Router();

// ---------------------------------------------------------------
// 公用
// ---------------------------------------------------------------

/** 取会话并校验归属。查不到、不属于自己、已软删除，一律 404（不泄露"存在但不是你的"） */
async function loadConversation(id, teacherId) {
  const conv = await queryOne(
    `SELECT * FROM conversations WHERE id = $1 AND teacher_id = $2 AND deleted_at IS NULL`,
    [id, teacherId]
  );
  if (!conv) throw notFound('没有找到这份教案');
  return conv;
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw notFound('没有找到这份教案');
  return id;
}

/** 写一条 assistant 提问消息 */
async function insertQuestionMessage(client, conv, question, position, meta = {}) {
  await client.query(
    `INSERT INTO messages (conversation_id, role, content, payload, round_index, question_index, token_in, token_out, model)
     VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8)`,
    [
      conv.id,
      question.title,
      JSON.stringify(question),
      position.round,
      position.questionIndex,
      meta.tokenIn ?? null,
      meta.tokenOut ?? null,
      meta.model ?? null,
    ]
  );
}

/** 把 AI 的输出（ack + 推荐选项）过一遍内容安全 */
async function checkAiOutput({ openid, ack, question }) {
  const text = [ack, question?.title, ...(question?.options || []).map((o) => `${o.label} ${o.sub || ''}`)]
    .filter(Boolean)
    .join(' ');
  if (!text.trim()) return;
  const check = await msgSecCheck({ content: text, openid, scene: 3, stage: 'ai_output' });
  if (!check.pass) throw contentBlockedError('ai_output');
}

// ---------------------------------------------------------------
// POST /conversations
// ---------------------------------------------------------------
conversationsRouter.post(
  '/',
  limitNewConversation,
  asyncRoute(async (req, res) => {
    const seedInput = String(req.body?.seed_input || '').trim();
    if (!seedInput) throw badRequest('先说说你想做个什么活动吧');
    if (seedInput.length > 500) throw badRequest('说得有点长了，精简到 500 字以内');

    const check = await msgSecCheck({
      content: seedInput,
      openid: req.teacher.openid,
      scene: 3,
      stage: 'teacher_input',
    });
    if (!check.pass) throw contentBlockedError('teacher_input');

    // 老师档案里的年龄班先作为默认值放进 collected —— 但第 1 题仍然会问，
    // 因为老师可能同时带两个班（age-band-adaptation.md「对界面的影响」）。
    const conv = await queryOne(
      `INSERT INTO conversations (teacher_id, title, seed_input, status, round_index, question_index, total_rounds, collected)
       VALUES ($1, $2, $3, 'draft', 1, 1, $4, '{}'::jsonb)
       RETURNING *`,
      [req.teacherId, fallbackTitle(seedInput), seedInput, TOTAL_ROUNDS]
    );

    const memories = await listMemories(req.teacherId);
    const step = await buildNextStep({
      teacher: req.teacher,
      memories,
      collected: {},
      seedInput,
      planIndex: 0,
      lastAnswer: null,
    });

    await checkAiOutput({ openid: req.teacher.openid, ack: step.ack, question: step.question });

    await withTransaction(async (client) => {
      await insertQuestionMessage(client, conv, step.question, { round: 1, questionIndex: 1 });
    });

    logger.info('conv_created', { teacher_id: req.teacherId, conversation_id: conv.id });

    return ok(res, {
      conversation_id: conv.id,
      status: conv.status,
      progress: buildProgress(1, 1),
      question: step.question,
    });
  })
);

// ---------------------------------------------------------------
// POST /conversations/:id/answer
// ---------------------------------------------------------------
conversationsRouter.post(
  '/:id/answer',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const conv = await loadConversation(id, req.teacherId);

    if (conv.status !== 'draft') {
      throw badRequest(
        conv.status === 'generating' ? '这份教案正在生成中，稍等一下' : '这份教案已经生成好了'
      );
    }

    const planIndex = planIndexOf(conv.round_index, conv.question_index);
    const spec = QUESTION_PLAN[planIndex];
    if (!spec) throw badRequest('问题都答完了，可以直接生成教案');

    const { question_id: questionId, selected, custom_text: customText } = req.body || {};
    if (questionId && questionId !== spec.id) {
      // 前端拿着旧题目重复提交（比如网络重试）。告诉它当前该答哪题，而不是默默写坏进度。
      throw badRequest('这题已经答过了，刷新一下继续');
    }

    // 取出上一条 assistant 问题，用来把选项 key 还原成 label
    const pendingRow = await queryOne(
      `SELECT payload FROM messages
        WHERE conversation_id = $1 AND role = 'assistant'
        ORDER BY id DESC LIMIT 1`,
      [conv.id]
    );
    const pending = pendingRow?.payload || null;
    if (!pending || pending.id !== spec.id) {
      throw badRequest('题目对不上了，刷新一下继续');
    }

    if (customText) {
      if (String(customText).length > 300) throw badRequest('写得有点长了，精简一下');
      const check = await msgSecCheck({
        content: String(customText),
        openid: req.teacher.openid,
        scene: 3,
        stage: 'teacher_input',
      });
      if (!check.pass) throw contentBlockedError('teacher_input');
    }

    const { value, text } = resolveAnswer(spec, pending, { selected, custom_text: customText });

    // ---- 落库（这一步必须在调模型之前）----
    const collected = { ...(conv.collected || {}) };
    if (spec.key === 'duration') {
      const { duration, note } = clampDuration(value, collected.age_group);
      collected.duration = duration;
      if (note) collected.duration_note = note;
    } else if (value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      collected[spec.key] = value;
    }

    const nextPlanIndex = planIndex + 1;
    const nextPos = positionOf(nextPlanIndex);
    // 走完最后一题时，把进度停在「最后一题的下一格」，这样 isFinished 能判出来
    const newRound = nextPos ? nextPos.round : conv.round_index;
    const newQuestionIndex = nextPos ? nextPos.questionIndex : conv.question_index + 1;

    const updated = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO messages (conversation_id, role, content, payload, round_index, question_index)
         VALUES ($1, 'user', $2, $3, $4, $5)`,
        [
          conv.id,
          text,
          JSON.stringify({ question_id: spec.id, key: spec.key, selected: selected || [], custom_text: customText || null }),
          conv.round_index,
          conv.question_index,
        ]
      );
      const r = await client.query(
        `UPDATE conversations
            SET collected = $1::jsonb,
                age_group = COALESCE($2, age_group),
                round_index = $3,
                question_index = $4,
                updated_at = now()
          WHERE id = $5
          RETURNING *`,
        [
          JSON.stringify(collected),
          spec.key === 'age_group' ? value : null,
          newRound,
          newQuestionIndex,
          conv.id,
        ]
      );
      return r.rows[0];
    });

    // ---- 落库完成，接下来调模型出下一题；这一步失败也不影响已保存的答案 ----
    const memories = await listMemories(req.teacherId);
    const step = await buildNextStep({
      teacher: req.teacher,
      memories,
      collected,
      seedInput: conv.seed_input,
      planIndex: nextPlanIndex,
      lastAnswer: { title: spec.title, text },
    });

    await checkAiOutput({ openid: req.teacher.openid, ack: step.ack, question: step.question });

    if (step.question && nextPos) {
      await withTransaction(async (client) => {
        await insertQuestionMessage(client, updated, step.question, nextPos);
      });
    }

    logger.info('conv_answer', {
      conversation_id: conv.id,
      teacher_id: req.teacherId,
      question_id: spec.id,
      round: conv.round_index,
    });

    return ok(res, {
      progress: buildProgress(newRound, newQuestionIndex),
      ack: step.ack,
      question: step.question,
      can_finish: canFinish(collected),
      ready_to_generate: step.ready_to_generate,
    });
  })
);

// ---------------------------------------------------------------
// GET /conversations/:id —— 断点续写
// ---------------------------------------------------------------
conversationsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const conv = await loadConversation(id, req.teacherId);

    const messages = (
      await query(
        `SELECT role, content, payload, round_index, question_index, created_at
           FROM messages WHERE conversation_id = $1 ORDER BY id ASC`,
        [conv.id]
      )
    ).rows;

    // 把 assistant 提问和紧随其后的 user 回答配成对，供前端渲染已答列表
    const answered = [];
    let currentQuestion = null;
    for (const m of messages) {
      if (m.role === 'assistant' && m.payload?.id) {
        currentQuestion = m.payload;
      } else if (m.role === 'user' && currentQuestion) {
        answered.push({
          question_id: currentQuestion.id,
          title: currentQuestion.title,
          answer_text: m.content,
          answered_at: m.created_at,
        });
        currentQuestion = null;
      }
    }

    const plan = await queryOne(
      `SELECT id, title FROM lesson_plans WHERE conversation_id = $1`,
      [conv.id]
    );

    const finished = isFinished(conv.round_index, conv.question_index);

    return ok(res, {
      conversation_id: conv.id,
      status: conv.status,
      title: conv.title,
      seed_input: conv.seed_input,
      age_group: conv.age_group,
      collected: conv.collected,
      progress: buildProgress(conv.round_index, conv.question_index),
      progress_text: progressText(conv),
      answered,
      // currentQuestion 是最后一条没被回答的 assistant 提问 —— 正好是老师退出时停在的那题
      question: conv.status === 'draft' ? currentQuestion : null,
      can_finish: canFinish(conv.collected),
      ready_to_generate: finished,
      lesson_plan_id: plan?.id ?? null,
      updated_at: conv.updated_at,
    });
  })
);

// ---------------------------------------------------------------
// GET /conversations —— 教案库列表
// ---------------------------------------------------------------
conversationsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const status = String(req.query.status || 'all');
    const ageGroup = String(req.query.age_group || 'all');
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;

    const where = ['c.teacher_id = $1', 'c.deleted_at IS NULL'];
    const params = [req.teacherId];

    if (status !== 'all') {
      if (status === 'draft') {
        // 「草稿」在老师眼里包括生成中和生成失败的 —— 都是还没拿到成稿的
        where.push(`c.status IN ('draft','generating','failed')`);
      } else if (status === 'completed') {
        where.push(`c.status = 'completed'`);
      } else {
        throw badRequest('筛选条件不对');
      }
    }
    if (ageGroup !== 'all') {
      params.push(ageGroup);
      where.push(`c.age_group = $${params.length}`);
    }
    if (cursor) {
      // cursor 分页而非 offset：老师边用边新增，offset 会重复或漏条。
      // 这里用 id 递减做游标（id 单调递增，等价于按创建时间排序且绝不重复）。
      params.push(cursor);
      where.push(`c.id < $${params.length}`);
    }

    params.push(limit + 1); // 多取一条用来判断还有没有下一页
    const rows = (
      await query(
        `SELECT c.*, p.id AS lesson_plan_id
           FROM conversations c
           LEFT JOIN lesson_plans p ON p.conversation_id = c.id
          WHERE ${where.join(' AND ')}
          ORDER BY c.id DESC
          LIMIT $${params.length}`,
        params
      )
    ).rows;

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      age_group: c.age_group,
      progress_text: progressText(c),
      has_image: c.has_image,
      lesson_plan_id: c.lesson_plan_id ?? undefined,
      updated_at: c.updated_at,
    }));

    // counts 一起返回，省掉前端为了显示筛选器数字再请求一次（api-spec 第 7 节）
    const countRow = await queryOne(
      `SELECT COUNT(*)::int AS all_count,
              COUNT(*) FILTER (WHERE status IN ('draft','generating','failed'))::int AS draft_count,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count
         FROM conversations
        WHERE teacher_id = $1 AND deleted_at IS NULL`,
      [req.teacherId]
    );

    return ok(res, {
      items,
      next_cursor: hasMore ? items[items.length - 1].id : null,
      counts: {
        all: countRow.all_count,
        draft: countRow.draft_count,
        completed: countRow.completed_count,
      },
    });
  })
);

// ---------------------------------------------------------------
// DELETE /conversations/:id —— 软删除
// ---------------------------------------------------------------
conversationsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    await loadConversation(id, req.teacherId);

    // 软删除：30 天后由清理脚本物理删除（db-schema.md 第 8 节）。
    // 给老师留一个「删错了还能找回来」的窗口，也让误删不至于连带删掉教案和配图。
    await query(`UPDATE conversations SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
    logger.info('conv_deleted', { conversation_id: id, teacher_id: req.teacherId });

    return ok(res, { deleted: true });
  })
);

/** 给 generate.js 复用 —— 归属校验只写一遍，避免两处不一致漏掉 deleted_at */
export { loadConversation, parseId };
