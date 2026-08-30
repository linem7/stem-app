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
import { query, queryOne, withTransaction } from '../db/pool.js';
import { ok, asyncRoute, badRequest } from '../utils/errors.js';
import { limitGenerate } from '../middleware/rateLimit.js';
import { taskQueue, setPhase, setStreamText, resetStream, getProgress } from '../services/taskQueue.js';
import { generateLessonPlan } from '../services/lessonGenerator.js';
import { readablePrefix } from '../services/planStream.js';
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
  setPhase(taskId, 'thinking');

  taskQueue.enqueue({
    id: taskId,
    kind: 'generate_lesson',
    run: async () => {
      /* 模型吐出来的原始 JSON 攒在这个闭包里，**不进队列的进度存储** ——
         那里存的是已经翻成人话的正文（老师看的那份）。
         两份分开的理由：原始 JSON 是给 planStream 吃的中间物，
         摆进接口响应里等于让前端也认识一遍这个结构。 */
      let raw = '';
      const plan = await generateLessonPlan({
        conversation: conv,
        teacher,
        memories,
        qaHistory,
        onPhase: (phase) => setPhase(taskId, phase),
        onStream: (chunk, { restart } = {}) => {
          if (restart) {
            raw = '';
            resetStream(taskId);
            return;
          }
          raw += chunk;
          // 第一个字到了 = 它不是在想，是在写。这一步的判据只能在这里 ——
          // lessonGenerator 那边看不见模型什么时候开的口
          setPhase(taskId, 'writing');
          setStreamText(taskId, readablePrefix(raw));
        },
      });

      // AI 输出也要过内容安全（api-spec 第 10 节）
      const check = await msgSecCheck({
        content: plan.content_md,
        openid: teacher.openid,
        scene: 3,
        stage: 'ai_output',
      });
      if (!check.pass) throw contentBlockedError('ai_output');

      // 产生这一版的那句改稿意见。第一版没有（它不是改出来的）。
      // 存它是因为老师认版本靠的是「我当时说了什么」，不是版本号。
      const revisions = Array.isArray(conv.collected?.revisions) ? conv.collected.revisions : [];
      const reviseNote = revisions.length ? String(revisions[revisions.length - 1]?.feedback || '').slice(0, 500) : null;

      // 覆盖当前稿 + 落一条版本快照，两件事必须同生共死：
      // 只写快照没覆盖，老师看到的还是旧的；只覆盖没写快照，这一版就永远回不去了。
      const saved = await withTransaction(async (client) => {
        const row = (
          await client.query(
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
               updated_at   = now()
             RETURNING id`,
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
          )
        ).rows[0];

        // 版本号取「历史里的最大值 + 1」，不是「当前版本 + 1」。
        // 差别在回退之后：当前指向 v1、历史里已经有 v2，这时再改稿必须出 v3，
        // 用 current + 1 会撞上已经存在的 v2（那条唯一索引会直接报错）。
        const next = (
          await client.query(
            `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM lesson_plan_versions WHERE lesson_plan_id = $1`,
            [row.id]
          )
        ).rows[0].v;

        await client.query(
          `INSERT INTO lesson_plan_versions
             (lesson_plan_id, version, title, age_group, duration_min, content_md, content_json, quality_self, revise_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
          [
            row.id,
            next,
            plan.title.slice(0, 128),
            plan.age_group,
            plan.duration_min,
            plan.content_md,
            JSON.stringify(plan.content_json),
            JSON.stringify(plan.quality_self),
            reviseNote,
          ]
        );

        await client.query(
          `UPDATE lesson_plans SET version = $1, current_version = $1 WHERE id = $2`,
          [next, row.id]
        );

        /* 生成这件事本身也进 messages（2026-08-23 用户提「对话记录没有思考链路」）：
           后台「查看正文」的对话记录由 messages 卷出来，AI 产出了第几版、
           当时的思考链路（模型开了思考模式才有）、**当时那份提示词**
           都记在这条的 payload 里。
           ⚠️ payload 里**不许有 id 字段**：老师端的状态重建（conversations.js）
           只认带 id 的 assistant 消息，没有 id 它天然被跳过 ——
           加了 id 它会混进引导页的题目列表。
           ⚠️ 这里也**不存教案正文**（用户明确说不要）：正文在 lesson_plans
           和版本快照里各有一份，再抄一份进 messages 只是把同一段话存三遍。 */
        await client.query(
          `INSERT INTO messages (conversation_id, role, content, payload)
           VALUES ($1, 'assistant', $2, $3)`,
          [conv.id, plan.title.slice(0, 128), JSON.stringify({
            kind: 'generation',
            version: next,
            round: revisions.length || null,
            reasoning: plan.reasoning || null,
            prompt_system: plan.prompt?.system || null,
            prompt_user: plan.prompt?.user || null,
          })]
        );

        return { id: row.id, version: next };
      });

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

      /* 自检的结果事后回填（2026-08-24）—— **故意不 await**。
         老师这时候已经拿到教案了；自检那 3 秒只服务于我做内测分析
         （8 个维度的打分，成稿页上一个字都不显示）。

         用 jsonb_set 只改 model 和 model_pending 两个键，不整块覆盖 ——
         age_band_violations 那些是出稿时算好的，覆盖会把它们冲掉。

         ⚠️ **只回填 lesson_plans，不回填 lesson_plan_versions 的快照。**
         快照里那一版的 `model` 会一直是 null / pending，这是认下来的代价：
         自检本来就是可失败的附加信息，而「统计 AI 写的教案质量」查当前版足够。
         要历史每一版都有自检，得把这一段挪进事务里 await —— 那就等于没改。 */
      plan.selfCheckTask?.then(async (result) => {
        try {
          await query(
            `UPDATE lesson_plans
                SET quality_self = jsonb_set(
                      jsonb_set(quality_self, '{model}', $1::jsonb, true),
                      '{model_pending}', 'false'::jsonb, true)
              WHERE id = $2`,
            [JSON.stringify(result ?? null), saved.id]
          );
        } catch (err) {
          // 回填失败只影响那份教案的自检字段，老师那边什么都不受影响
          logger.warn('self_check_backfill_failed', { lesson_plan_id: saved.id, message: err.message });
        }
      });

      logger.info('lesson_generated', {
        conversation_id: conv.id,
        lesson_plan_id: saved.id,
        version: saved.version,
        age_group: plan.age_group,
        token_in: plan.tokenIn,
        token_out: plan.tokenOut,
        age_band_violations: plan.quality_self?.age_band_violations?.length ?? 0,
        // 学习模式下解读写成了几个板块（效率模式是 null）。
        // 解读失败完全没有声音 —— 老师只会以为这个模式就是没有解读，
        // 所以它必须在日志里留一行，否则「多少比例真写出来了」以后查不到
        mode: conv.mode || 'efficient',
        commentary_keys: plan.quality_self?.commentary_keys?.length ?? null,
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
      // 走到哪一段了：thinking / writing / checking。生成结束后就没有阶段可言了
      phase: status === 'generating' ? getProgress(taskIdOf(id))?.phase ?? 'thinking' : null,
      // 正文长到哪了。**只回新增的那一段**，见 streamDelta
      stream: status === 'generating' ? streamDelta(getProgress(taskIdOf(id)), req.query) : null,
      lesson_plan_id: status === 'completed' ? plan?.id ?? null : null,
    });
  })
);

/**
 * 增量协议 —— 前端每次把「我已经收到哪儿了」告诉后端，后端只回后面新长出来的那一截。
 *
 * 全量重发一次要几千字，一次生成轮三四十次 = 几十上百 KB，
 * 而老师多半在幼儿园的手机流量上。所以带游标。
 *
 * 两个字段缺一不可：
 *   epoch  第几次尝试。模型被截断会重打一遍，那时候正文要**从头再来** ——
 *          光有 from 的话前端会把两份教案首尾相接拼在一起，而且不报错
 *   from   已经收到的字数
 * 对不上（换了 epoch、或者 from 比后端还多）就 `restart: true` + 回全量，
 * 前端清屏重画。慢一拍，但画面不会花。
 */
export function streamDelta(p, q) {
  if (!p) return null;
  const epoch = Number(q?.epoch) || 0;
  const from = Number(q?.from) || 0;
  const restart = epoch !== p.epoch || from < 0 || from > p.text.length;
  return {
    epoch: p.epoch,
    restart,
    text: p.text.slice(restart ? 0 : from),
    len: p.text.length,
  };
}

/** 引导过程的问答对，供生成教案时作为上下文。改稿路由也用它，所以导出。 */
export async function loadQaHistory(conversationId) {
  const rows = (
    await query(
      `SELECT role, content, payload FROM messages
        WHERE conversation_id = $1 ORDER BY id ASC`,
      [conversationId]
    )
  ).rows;
  return pairQa(rows);
}

/**
 * 配对逻辑单独拎出来，是为了能不起服务、不连库地测它（scripts/context-test.mjs）。
 * @param {Array<{role:string, content:string, payload:object}>} rows 按 id 升序的 messages 行
 */
export function pairQa(rows) {
  /* 🔴 按 id 配对，不按相邻位置。
     题目是**一次性连发 4 条** assistant 消息的（conversations.js 的 insertQuestionMessage），
     答案全排在它们后面 —— 按位置只能配出最后一道题，而且配到的是别题的答案。
     那不是丢信息，是投毒：模型读到的字面意思是「班上的情况 = 大班」，
     丢了它会自己补，读到一条错配的事实它会照着写。
     换年龄班会删掉旧题重插（id 变大），所以同一个 id 后写的覆盖先写的，正好等于「取最新那道题」。
     改稿的追问不收进来 —— buildRevisionBlock 已经把意见和答案都带上了，收两遍是同一段话说两次。 */
  const titleById = new Map();
  for (const m of rows) {
    if (m.role !== 'assistant' || m.payload?.kind === 'revise_question') continue;
    if (m.payload?.id && m.payload?.title) titleById.set(m.payload.id, m.payload.title);
  }

  const out = [];
  for (const m of rows) {
    if (m.role !== 'user' || m.payload?.kind === 'revise_answer') continue;
    // 老数据没有 question_id，跳过就是了 —— 退回按位置配对等于把那个缺陷留一条后路
    const title = titleById.get(m.payload?.question_id);
    if (title) out.push({ question: title, answer: m.content });
  }
  return out;
}
