/**
 * 教案会话 —— api-spec 第 3 节和第 7 节
 *
 *   POST   /conversations             开新会话，一次返回全部 4 题
 *   GET    /conversations/:id/questions 换了年龄班时重拉推荐答案
 *   POST   /conversations/:id/answer  答一题即落库，不限顺序、可覆盖
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
import { assertQuota } from '../services/quota.js';
import { fallbackTitle } from '../services/lessonGenerator.js';
import {
  TOTAL_QUESTIONS,
  buildProgress,
  buildAllQuestions,
  buildAck,
  resolveAnswer,
  canFinish,
  isFinished,
  progressText,
  specOf,
} from '../services/guideFlow.js';
import { LEARNING_LEAD, attachWhy, isLearning, resolveMode } from '../services/learningMode.js';
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

/** 写一条 assistant 提问消息。题目一次性全给，所以不再有「第几轮第几题」的坐标。 */
async function insertQuestionMessage(client, conv, question) {
  await client.query(
    `INSERT INTO messages (conversation_id, role, content, payload)
     VALUES ($1, 'assistant', $2, $3)`,
    [conv.id, question.title, JSON.stringify(question)]
  );
}

/** 把 AI 生成的题目和推荐答案过一遍内容安全 */
async function checkAiOutput({ openid, ack, questions = [] }) {
  const text = [ack, ...questions.flatMap((q) => [q.title, ...(q.options || []).map((o) => `${o.label} ${o.sub || ''}`)])]
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
    // 额度闸门放在最前面：让老师答完 4 题、等了 20 秒生成，
    // 最后才告诉她「额度不够」—— 那是最糟的时机
    await assertQuota(req.teacherId, 'text');

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

    // 模式挂在会话上：她可能这份想快（明天就要上）、下一份想学（周末有空）。
    // 不认识的值当效率模式 —— 客户端传错不该让她拿不到教案
    const mode = resolveMode(req.body?.mode);

    const conv = await queryOne(
      // round_index / question_index 这两列留着不用了（题目一次性全给，没有「第几题」的概念），
      // 但它们是 NOT NULL DEFAULT，不删列就不用写迁移，等下次改表时一并清理
      `INSERT INTO conversations (teacher_id, title, seed_input, status, total_rounds, collected, mode)
       VALUES ($1, $2, $3, 'draft', $4, '{}'::jsonb, $5)
       RETURNING *`,
      [req.teacherId, fallbackTitle(seedInput), seedInput, TOTAL_QUESTIONS, mode]
    );

    const memories = await listMemories(req.teacherId);
    // 一次把全部题目和推荐答案生成出来。推荐答案按老师档案里的年龄班算
    // —— 她只带一个班，这个默认几乎总是对的；选了别的班再调 /questions 重拉。
    const questions = await buildAllQuestions({
      teacher: req.teacher,
      memories,
      collected: {},
      seedInput,
    });

    await checkAiOutput({ openid: req.teacher.openid, questions });

    // 落库存的是**不带 why 的题目** —— why 是写死的中文，不是模型产出，
    // 存一遍等于把同一段话抄进每一条消息里。挂在下发那一刻就够
    await withTransaction(async (client) => {
      for (const q of questions) await insertQuestionMessage(client, conv, q);
    });

    logger.info('conv_created', { teacher_id: req.teacherId, conversation_id: conv.id, mode });

    return ok(res, {
      conversation_id: conv.id,
      status: conv.status,
      mode,
      progress: buildProgress({}),
      questions: attachWhy(questions, mode),
      ...(isLearning(mode) ? { learning_lead: LEARNING_LEAD } : {}),
    });
  })
);

// ---------------------------------------------------------------
// GET /conversations/:id/questions —— 换了年龄班时重拉推荐答案
// ---------------------------------------------------------------
conversationsRouter.get(
  '/:id/questions',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const conv = await loadConversation(id, req.teacherId);
    const ageGroup = req.query.age_group ? String(req.query.age_group) : null;

    const memories = await listMemories(req.teacherId);
    const questions = await buildAllQuestions({
      teacher: req.teacher,
      memories,
      collected: conv.collected || {},
      seedInput: conv.seed_input,
      ageGroup,
    });

    await checkAiOutput({ openid: req.teacher.openid, questions });

    // 覆盖掉旧的题目消息：老师换了年龄班，旧推荐答案已经不适用了。
    // 她**已经填的答案不动** —— collected 一个字都没碰。
    await withTransaction(async (client) => {
      await client.query(
        `DELETE FROM messages WHERE conversation_id = $1 AND role = 'assistant'
           AND payload->>'kind' IS DISTINCT FROM 'revise_question'`,
        [conv.id]
      );
      for (const q of questions) await insertQuestionMessage(client, conv, q);
    });

    // 换年龄班重拉时 why 也要跟着回去 —— 前端是整份替换 questions 的，
    // 不带就等于「换了个班，那几句为什么就消失了」
    return ok(res, {
      questions: attachWhy(questions, conv.mode),
      progress: buildProgress(conv.collected || {}),
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

    const { question_id: questionId, selected, custom_text: customText } = req.body || {};
    const spec = specOf(questionId);
    // 题目一次性全给出去了，所以答哪一题、什么顺序答，由老师决定 ——
    // 唯一要校验的是这个 id 确实是我们出过的题。
    if (!spec) throw badRequest('题目对不上了，刷新一下继续');

    const pendingRow = await queryOne(
      `SELECT payload FROM messages
        WHERE conversation_id = $1 AND role = 'assistant' AND payload->>'id' = $2
        ORDER BY id DESC LIMIT 1`,
      [conv.id, spec.id]
    );
    const pending = pendingRow?.payload || null;
    if (!pending) throw badRequest('题目对不上了，刷新一下继续');

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

    // ---- 落库（必须在调模型之前）----
    // 一次性出题不等于一次性提交：每选一项就存一次，老师被叫走也不丢。
    const collected = { ...(conv.collected || {}) };
    if (value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)) {
      collected[spec.key] = value;
    } else {
      delete collected[spec.key]; // 她把选中的取消了，就当这题没答
    }

    const updated = await withTransaction(async (client) => {
      // 同一题改主意是覆盖，不是追加 —— 否则 qaHistory 里会出现同一题的两个答案
      await client.query(
        `DELETE FROM messages WHERE conversation_id = $1 AND role = 'user'
           AND payload->>'question_id' = $2`,
        [conv.id, spec.id]
      );
      await client.query(
        `INSERT INTO messages (conversation_id, role, content, payload)
         VALUES ($1, 'user', $2, $3)`,
        [
          conv.id,
          text,
          JSON.stringify({ question_id: spec.id, key: spec.key, selected: selected || [], custom_text: customText || null }),
        ]
      );
      const r = await client.query(
        `UPDATE conversations
            SET collected = $1::jsonb,
                age_group = COALESCE($2, age_group),
                updated_at = now()
          WHERE id = $3
          RETURNING *`,
        [JSON.stringify(collected), spec.key === 'age_group' ? value : null, conv.id]
      );
      return r.rows[0];
    });

    // ---- 落库完成，再调模型要那句回应；它失败也不影响已保存的答案 ----
    const memories = await listMemories(req.teacherId);
    const ack = await buildAck({
      teacher: req.teacher, memories, collected,
      seedInput: conv.seed_input, spec, answerText: text,
    });

    await checkAiOutput({ openid: req.teacher.openid, ack });

    logger.info('conv_answer', {
      conversation_id: conv.id,
      teacher_id: req.teacherId,
      question_id: spec.id,
      answered: buildProgress(collected).answered,
    });

    return ok(res, {
      progress: buildProgress(collected),
      ack,
      can_finish: canFinish(collected),
      ready_to_generate: isFinished(collected),
      // 年龄班一变，时长跟着变。前端拿它更新成稿预期，不用自己算。
      ...(spec.key === 'age_group' ? { age_group: value } : {}),
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
        `SELECT role, content, payload, created_at
           FROM messages WHERE conversation_id = $1 ORDER BY id ASC`,
        [conv.id]
      )
    ).rows;

    // 出过的题（排除改稿追问，那些属于另一条线）
    const questions = [];
    const seen = new Set();
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.payload?.id) continue;
      if (m.payload.kind === 'revise_question') continue;
      // 换年龄班会重新出题，同一个 id 可能有多条，取最后一条
      const i = questions.findIndex((q) => q.id === m.payload.id);
      if (i >= 0) questions[i] = m.payload; else questions.push(m.payload);
      seen.add(m.payload.id);
    }

    // 已答的答案，按题目 id 归位
    const answers = {};
    for (const m of messages) {
      if (m.role !== 'user' || !m.payload?.question_id) continue;
      answers[m.payload.question_id] = {
        question_id: m.payload.question_id,
        selected: m.payload.selected || [],
        custom_text: m.payload.custom_text || null,
        answer_text: m.content,
        answered_at: m.created_at,
      };
    }

    const plan = await queryOne(
      `SELECT id, title FROM lesson_plans WHERE conversation_id = $1`,
      [conv.id]
    );

    return ok(res, {
      conversation_id: conv.id,
      status: conv.status,
      // 断点续写要还原的不只是答案，还有**她当时选的模式** ——
      // 不带的话她被叫走一趟回来，学习模式那几句「为什么」就没了
      mode: conv.mode || 'efficient',
      ...(isLearning(conv.mode) ? { learning_lead: LEARNING_LEAD } : {}),
      title: conv.title,
      seed_input: conv.seed_input,
      age_group: conv.age_group,
      collected: conv.collected,
      progress: buildProgress(conv.collected || {}),
      progress_text: progressText(conv),
      // 全部题目 + 各自答没答，前端一次拿到就能把那一屏原样还原出来
      questions: conv.status === 'draft' ? attachWhy(questions, conv.mode) : [],
      answers,
      can_finish: canFinish(conv.collected),
      ready_to_generate: isFinished(conv.collected || {}),
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
