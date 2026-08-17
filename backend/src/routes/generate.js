/**
 * 生成教案 + 轮询状态 —— api-spec 第 4 节
 *
 *   POST /conversations/:id/generate         立刻返回 task_id，真正的活儿交给任务队列
 *   GET  /conversations/:id/generate/status  前端每 2 秒轮一次
 *
 * 为什么必须异步：生成要 15-30 秒，微信小程序的请求会先超时。
 * 为什么不用 WebSocket：小程序里长连接的断线重连和后台挂起处理成本高，
 * 而这里只需要一个 30 秒内的结果（api-spec 第 4 节已给出理由）。
 */
import { Router } from 'express';
import { query, queryOne } from '../db/pool.js';
import { ok, asyncRoute, badRequest } from '../utils/errors.js';
import { limitGenerate } from '../middleware/rateLimit.js';
import { taskQueue, setProgressHint, getProgressHint } from '../services/taskQueue.js';
import { generateLessonPlan, PROGRESS_HINTS } from '../services/lessonGenerator.js';
import { extractAndSaveMemories, listMemories } from '../services/memoryExtractor.js';
import { msgSecCheck, contentBlockedError } from '../services/wechat.js';
import { canFinish } from '../services/guideFlow.js';
import { loadConversation, parseId } from './conversations.js';
import { logger } from '../utils/logger.js';

export const generateRouter = Router();

export const taskIdOf = (conversationId) => `gen_${conversationId}`;

/**
 * 把一次教案生成放进队列。首次生成和改稿重生成走的是同一个函数 ——
 * 两边各写一遍的话，「生成完要顺手做的那几件事」（存稿、把 conversation 标成 completed、
 * 触发记忆提取、失败时标 failed）迟早会漏掉一件，而且是只在改稿路径上漏，最难发现。
 *
 * 调用前请确保 conversation.status 已经置为 'generating'。
 */
export function enqueueLessonGeneration({ conv, teacher, memories, qaHistory }) {
  const taskId = taskIdOf(conv.id);
  setProgressHint(taskId, PROGRESS_HINTS.start);

  taskQueue.enqueue({
    id: taskId,
    kind: 'generate_lesson',
    run: async () => {
      const plan = await generateLessonPlan({
        conversation: conv,
        teacher,
        memories,
        qaHistory,
        onProgress: (key) => setProgressHint(taskId, PROGRESS_HINTS[key] || PROGRESS_HINTS.drafting),
      });

      // AI 输出也要过内容安全（api-spec 第 10 节）
      const check = await msgSecCheck({
        content: plan.content_md,
        openid: teacher.openid,
        scene: 3,
        stage: 'ai_output',
      });
      if (!check.pass) throw contentBlockedError('ai_output');

      // 重新生成时覆盖旧稿并把 version + 1（conversation_id 上有 UNIQUE 约束）
      const saved = await queryOne(
        `INSERT INTO lesson_plans
           (conversation_id, teacher_id, title, age_group, duration_min, content_md, content_json, quality_self)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
         ON CONFLICT (conversation_id) DO UPDATE SET
           title        = EXCLUDED.title,
           age_group    = EXCLUDED.age_group,
           duration_min = EXCLUDED.duration_min,
           content_md   = EXCLUDED.content_md,
           content_json = EXCLUDED.content_json,
           quality_self = EXCLUDED.quality_self,
           version      = lesson_plans.version + 1,
           updated_at   = now()
         RETURNING id, version`,
        [
          conv.id,
          teacher.id,
          plan.title.slice(0, 128),
          plan.age_group,
          plan.duration_min,
          plan.content_md,
          JSON.stringify(plan.content_json),
          JSON.stringify(plan.quality_self),
        ]
      );

      await query(
        `UPDATE conversations
            SET status = 'completed',
                title = $1,
                age_group = COALESCE($2, age_group),
                completed_at = now(),
                updated_at = now()
          WHERE id = $3`,
        [plan.title.slice(0, 128), plan.age_group, conv.id]
      );

      logger.info('lesson_generated', {
        conversation_id: conv.id,
        lesson_plan_id: saved.id,
        version: saved.version,
        age_group: plan.age_group,
        token_in: plan.tokenIn,
        token_out: plan.tokenOut,
        age_band_violations: plan.quality_self?.age_band_violations?.length ?? 0,
      });

      // 记忆提取是另一个独立任务：它失败了不该影响老师已经拿到的教案
      taskQueue.enqueue({
        id: `mem_${conv.id}`,
        kind: 'extract_memory',
        run: async () => {
          const transcript = qaHistory.map((x) => `问：${x.question}\n答：${x.answer}`).join('\n');
          await extractAndSaveMemories({
            teacherId: teacher.id,
            conversationId: conv.id,
            transcript: `${conv.seed_input}\n${transcript}`,
          });
        },
      });
    },
    onError: async (err) => {
      await query(`UPDATE conversations SET status = 'failed', updated_at = now() WHERE id = $1`, [conv.id]);
      logger.error('lesson_generate_failed', {
        conversation_id: conv.id,
        code: err?.code || 'INTERNAL',
      });
    },
  });

  return taskId;
}

// ---------------------------------------------------------------
// POST /conversations/:id/generate
// ---------------------------------------------------------------
generateRouter.post(
  '/:id/generate',
  limitGenerate,
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const conv = await loadConversation(id, req.teacherId);

    if (conv.status === 'generating' || taskQueue.isActive(taskIdOf(id))) {
      // 幂等：老师连点两下不该排两个任务，直接把当前任务返回给他
      return ok(res, { task_id: taskIdOf(id), status: 'generating' });
    }
    if (!canFinish(conv.collected)) {
      throw badRequest('还得先告诉我这是给哪个年龄班的');
    }

    const teacher = req.teacher;
    const memories = await listMemories(req.teacherId);

    // 把引导过程的问答捞出来，作为生成教案的上下文
    const qaHistory = await loadQaHistory(conv.id);

    await query(`UPDATE conversations SET status = 'generating', updated_at = now() WHERE id = $1`, [id]);

    const taskId = enqueueLessonGeneration({ conv, teacher, memories, qaHistory });

    return ok(res, { task_id: taskId, status: 'generating' });
  })
);

// ---------------------------------------------------------------
// GET /conversations/:id/generate/status
// ---------------------------------------------------------------
generateRouter.get(
  '/:id/generate/status',
  asyncRoute(async (req, res) => {
    const id = parseId(req.params.id);
    const conv = await loadConversation(id, req.teacherId);

    const plan = await queryOne(`SELECT id FROM lesson_plans WHERE conversation_id = $1`, [id]);

    // draft 说明压根没提交过生成，按 api-spec 的三态收敛成 failed 更好懂
    const status =
      conv.status === 'completed'
        ? 'completed'
        : conv.status === 'generating'
          ? 'generating'
          : 'failed';

    return ok(res, {
      status,
      progress_hint:
        status === 'generating'
          ? getProgressHint(taskIdOf(id)) || PROGRESS_HINTS.drafting
          : status === 'completed'
            ? '写好了'
            : '这次没生成成功，再试一次通常就好',
      lesson_plan_id: status === 'completed' ? plan?.id ?? null : null,
    });
  })
);

/** 引导过程的问答对，供生成教案时作为上下文。改稿路由也用它，所以导出。 */
export async function loadQaHistory(conversationId) {
  const rows = (
    await query(
      `SELECT role, content, payload FROM messages
        WHERE conversation_id = $1 ORDER BY id ASC`,
      [conversationId]
    )
  ).rows;

  const out = [];
  let q = null;
  for (const m of rows) {
    if (m.role === 'assistant' && m.payload?.title) q = m.payload.title;
    else if (m.role === 'user' && q) {
      out.push({ question: q, answer: m.content });
      q = null;
    }
  }
  return out;
}
