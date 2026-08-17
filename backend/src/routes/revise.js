/**
 * 改稿 —— api-spec 第 5 节
 *
 *   POST /lesson-plans/:id/revise         老师说哪里不对 → 返回 3 道追问
 *   POST /lesson-plans/:id/revise/answer  答完追问 → 重新生成（复用首次生成那条异步链路）
 *
 * 为什么改稿要再问三个问题，而不是拿她那句话直接重生成：
 * "孩子人数写多了" 这种话信息量不够 —— 到底是分组要改、材料要减，还是干脆拆成两次活动？
 * 模型自己猜一个方向，猜错了她还得再改一轮。问三个具体的、能点选的问题，比猜快。
 *
 * 但有一条底线：**这三题必须是引导阶段没问过的**。
 * 她已经答过一轮了，把同样的问题端回她面前，等于告诉她「你的反馈我没读懂」，
 * 提意见这件事会立刻变得不值得做。约束写在 buildReviseSystemPrompt 里。
 */
import { Router } from 'express';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../utils/errors.js';
import { chatJSON } from '../services/deepseek.js';
import { buildReviseSystemPrompt } from '../services/promptBuilder.js';
import { listMemories } from '../services/memoryExtractor.js';
import { msgSecCheck, contentBlockedError } from '../services/wechat.js';
import { QUESTION_PLAN } from '../services/guideFlow.js';
import { enqueueLessonGeneration, loadQaHistory, taskIdOf } from './generate.js';
import { taskQueue } from '../services/taskQueue.js';
import { assertReviseQuota } from '../services/quota.js';
import { logger } from '../utils/logger.js';

export const reviseRouter = Router();

const OPTION_KEYS = ['A', 'B', 'C', 'D'];
const REVISE_QUESTION_COUNT = 3;

async function loadPlanAndConv(id, teacherId) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw notFound('没有找到这份教案');
  const plan = await queryOne(
    `SELECT * FROM lesson_plans WHERE id = $1 AND teacher_id = $2`,
    [n, teacherId]
  );
  if (!plan) throw notFound('没有找到这份教案');
  const conv = await queryOne(
    `SELECT * FROM conversations WHERE id = $1 AND deleted_at IS NULL`,
    [plan.conversation_id]
  );
  if (!conv) throw notFound('没有找到这份教案');
  return { plan, conv };
}

/** 引导阶段 + 往轮改稿已经问过的题目，用来告诉模型「这些别再问了」 */
function askedTitlesOf(conv) {
  const guide = QUESTION_PLAN.map((q) => q.title);
  const revised = (conv.collected?.revisions || []).flatMap((r) =>
    (r.questions || []).map((q) => q.title)
  );
  return [...guide, ...revised];
}

// ---------------------------------------------------------------
// POST /lesson-plans/:id/revise
// ---------------------------------------------------------------
reviseRouter.post(
  '/:id/revise',
  asyncRoute(async (req, res) => {
    const { plan, conv } = await loadPlanAndConv(req.params.id, req.teacherId);

    const feedback = String(req.body?.feedback || '').trim();
    if (!feedback) throw badRequest('说说哪里不对，我来改');
    if (feedback.length > 300) throw badRequest('说得有点长了，精简到 300 字以内');

    if (conv.status === 'generating' || taskQueue.isActive(taskIdOf(conv.id))) {
      throw badRequest('这份教案正在生成中，等它写完再改');
    }

    const check = await msgSecCheck({
      content: feedback,
      openid: req.teacher.openid,
      scene: 3,
      stage: 'teacher_input',
    });
    if (!check.pass) throw contentBlockedError('teacher_input');

    // 前两次改稿免费（初稿 v1 → 改到 v3）。第三次起才查额度，
    // 而且要在**提问之前**查 —— 问完三个问题再说没额度，等于白问
    await assertReviseQuota(req.teacherId, plan.version);

    const revisions = Array.isArray(conv.collected?.revisions) ? conv.collected.revisions : [];
    const round = revisions.length + 1;
    const memories = await listMemories(req.teacherId);

    const system = buildReviseSystemPrompt({
      teacher: req.teacher,
      memories,
      collected: conv.collected || {},
      seedInput: conv.seed_input,
      feedback,
      plan: { ...(plan.content_json || {}), title: plan.title, duration_min: plan.duration_min },
      askedTitles: askedTitlesOf(conv),
      pastRevisions: revisions,
    });

    let ack = '';
    let questions = [];
    try {
      const { data } = await chatJSON({
        system,
        messages: [{ role: 'user', content: `老师说：${feedback}` }],
        temperature: 0.7,
        maxTokens: 1200,
        purpose: `revise_ask_r${round}`,
      });
      ack = typeof data.ack === 'string' ? data.ack.trim().slice(0, 60) : '';
      questions = normalizeQuestions(data.questions, round);
    } catch (err) {
      logger.warn('revise_model_failed', { code: err?.code, lesson_plan_id: plan.id });
    }

    // 模型挂了也要让老师能继续改 —— 给一组通用但不废话的追问
    if (questions.length < REVISE_QUESTION_COUNT) questions = fallbackQuestions(round);

    await checkAiOutput({ openid: req.teacher.openid, ack, questions });

    const nextCollected = {
      ...(conv.collected || {}),
      revisions: [...revisions, { round, feedback, questions, answers: null, at: new Date().toISOString() }],
    };

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO messages (conversation_id, role, content, payload)
         VALUES ($1, 'user', $2, $3)`,
        [conv.id, feedback, JSON.stringify({ kind: 'revise_feedback', round })]
      );
      for (const q of questions) {
        await client.query(
          `INSERT INTO messages (conversation_id, role, content, payload)
           VALUES ($1, 'assistant', $2, $3)`,
          [conv.id, q.title, JSON.stringify({ ...q, kind: 'revise_question', round })]
        );
      }
      await client.query(
        `UPDATE conversations SET collected = $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(nextCollected), conv.id]
      );
    });

    logger.info('revise_asked', { lesson_plan_id: plan.id, conversation_id: conv.id, round });

    return ok(res, { revise_round: round, ack: ack || '明白了，我再问你三个问题就动手改。', questions });
  })
);

// ---------------------------------------------------------------
// POST /lesson-plans/:id/revise/answer
// ---------------------------------------------------------------
reviseRouter.post(
  '/:id/revise/answer',
  asyncRoute(async (req, res) => {
    const { plan, conv } = await loadPlanAndConv(req.params.id, req.teacherId);

    if (conv.status === 'generating' || taskQueue.isActive(taskIdOf(conv.id))) {
      return ok(res, { task_id: taskIdOf(conv.id), status: 'generating' });
    }

    const revisions = Array.isArray(conv.collected?.revisions) ? conv.collected.revisions : [];
    const round = Number(req.body?.revise_round) || revisions.length;
    const current = revisions[round - 1];
    if (!current) throw badRequest('先说说哪里不对，我再问你几个问题');
    if (current.answers) throw badRequest('这几题已经答过了，教案正在按你说的改');

    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const resolved = [];
    for (const q of current.questions) {
      const a = answers.find((x) => x.question_id === q.id) || {};
      const selected = Array.isArray(a.selected) ? a.selected : [];
      const custom = typeof a.custom_text === 'string' ? a.custom_text.trim().slice(0, 300) : '';

      const labels = selected.map((k) => q.options.find((o) => o.key === k)?.label).filter(Boolean);
      if (selected.length && labels.length !== selected.length) {
        throw badRequest('有个选项没找到，刷新一下再试');
      }
      if (!q.multi && labels.length > 1) throw badRequest('这题只能选一个');

      if (custom) {
        const c = await msgSecCheck({
          content: custom, openid: req.teacher.openid, scene: 3, stage: 'teacher_input',
        });
        if (!c.pass) throw contentBlockedError('teacher_input');
      }

      const all = custom ? [...labels, custom] : labels;
      resolved.push({ question_id: q.id, title: q.title, text: all.length ? all.join('；') : '（跳过）' });
    }

    const nextRevisions = revisions.map((r, i) => (i === round - 1 ? { ...r, answers: resolved } : r));
    const nextCollected = { ...(conv.collected || {}), revisions: nextRevisions };

    await withTransaction(async (client) => {
      for (const r of resolved) {
        await client.query(
          `INSERT INTO messages (conversation_id, role, content, payload)
           VALUES ($1, 'user', $2, $3)`,
          [conv.id, r.text, JSON.stringify({ kind: 'revise_answer', round, question_id: r.question_id })]
        );
      }
      await client.query(
        `UPDATE conversations
            SET collected = $1::jsonb, status = 'generating', updated_at = now()
          WHERE id = $2`,
        [JSON.stringify(nextCollected), conv.id]
      );
    });

    const memories = await listMemories(req.teacherId);
    const qaHistory = await loadQaHistory(conv.id);
    const freshConv = { ...conv, collected: nextCollected, status: 'generating' };

    const taskId = enqueueLessonGeneration({
      conv: freshConv,
      teacher: req.teacher,
      memories,
      qaHistory,
    });

    logger.info('revise_regenerating', { lesson_plan_id: plan.id, conversation_id: conv.id, round });

    return ok(res, { task_id: taskId, status: 'generating' });
  })
);

// ---------------------------------------------------------------
// 工具
// ---------------------------------------------------------------

/** 模型给的题目要收敛成前端能直接渲染的形状，题号带轮次避免跨轮撞 id */
function normalizeQuestions(raw, round) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q) => q && typeof q.title === 'string' && q.title.trim())
    .slice(0, REVISE_QUESTION_COUNT)
    .map((q, i) => ({
      id: `r${round}_${i + 1}`,
      title: q.title.trim().slice(0, 60),
      hint: typeof q.hint === 'string' ? q.hint.trim().slice(0, 40) : '',
      multi: Boolean(q.multi),
      allow_custom: true,
      required: false,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o) => o && typeof o.label === 'string' && o.label.trim())
        .slice(0, 4)
        .map((o, j) => ({
          key: OPTION_KEYS[j],
          label: o.label.trim().slice(0, 30),
          ...(o.sub ? { sub: String(o.sub).trim().slice(0, 24) } : {}),
        })),
    }))
    .filter((q) => q.options.length >= 2);
}

/** 模型挂掉时的兜底。问得比较泛，但每一题都指向一个具体改法，不是废话。 */
function fallbackQuestions(round) {
  const raw = [
    {
      title: '这次主要想改哪一块？',
      hint: '选最要紧的那个',
      options: [
        { label: '教学流程', sub: '环节顺序或时间分配' },
        { label: '材料清单', sub: '换掉或减少材料' },
        { label: '难度深浅', sub: '整体太难或太浅' },
      ],
    },
    {
      title: '改完之后，时长还照原来的吗？',
      hint: '改流程通常会连带影响时长',
      options: [
        { label: '照原来的', sub: '总时长不变' },
        { label: '缩短一些', sub: '砍掉一部分内容' },
        { label: '拆成两次活动', sub: '一次做不完就分两天' },
      ],
    },
    {
      title: '其余部分要保留吗？',
      hint: '没提到的地方我就不动',
      options: [
        { label: '其余都保留', sub: '只改我说的那块' },
        { label: '整份重写', sub: '按新思路从头来' },
        { label: '顺便再润色一遍', sub: '保留结构，文字重写' },
      ],
    },
  ];
  return raw.map((q, i) => ({
    id: `r${round}_${i + 1}`,
    title: q.title,
    hint: q.hint,
    multi: false,
    allow_custom: true,
    required: false,
    options: q.options.map((o, j) => ({ key: OPTION_KEYS[j], label: o.label, sub: o.sub })),
  }));
}

/** AI 生成的追问也是要展示给老师的内容，同样过内容安全 */
async function checkAiOutput({ openid, ack, questions }) {
  const text = [ack, ...questions.flatMap((q) => [q.title, ...q.options.map((o) => `${o.label} ${o.sub || ''}`)])]
    .filter(Boolean)
    .join(' ');
  if (!text.trim()) return;
  const check = await msgSecCheck({ content: text, openid, scene: 3, stage: 'ai_output' });
  if (!check.pass) throw contentBlockedError('ai_output');
}
