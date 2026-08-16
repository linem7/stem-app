/**
 * 从对话里提取老师的长期记忆，并与已有记忆去重合并。
 *
 * 触发时机：教案生成完成后，作为一个后台任务跑（不阻塞老师）。
 *
 * 去重是两层的（db-schema.md 第 6 节）：
 *   1. 字面完全相同 → 数据库的 md5(fact) 唯一索引挡住，改成 frequency + 1
 *   2. 说的是同一件事但字不同（"我带中班" vs "我的班级是中班"）→ 把已有记忆一并喂给模型，
 *      要求它输出合并后的那一条。这比上向量检索便宜得多，MVP 够用。
 *
 * 隐私底线（api-spec 第 8 节）：写入是自动的，但删改权完全在老师手里。
 * 所以这里只做「新增/加频次」，永远不自动删老师置顶的记忆。
 */
import { chatJSON } from './deepseek.js';
import { buildMemoryExtractionSystemPrompt } from './promptBuilder.js';
import { query } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/** db-schema 里 mem_type 的合法取值，模型给了别的就归到「教学信息」 */
const VALID_TYPES = ['教学信息', '教学风格', '约束条件', '材料偏好', '年龄班专长'];

/** 单人记忆条数上限，超了淘汰最不重要的（db-schema.md「上限策略」） */
const MAX_MEMORIES = 60;

/**
 * 主入口。
 * @param {object} o
 * @param {number} o.teacherId
 * @param {number} o.conversationId
 * @param {string} o.transcript  引导过程的问答文本（不入日志）
 * @returns {Promise<{inserted:number, merged:number}>}
 */
export async function extractAndSaveMemories({ teacherId, conversationId, transcript }) {
  const existing = (
    await query(
      `SELECT id, fact, mem_type, frequency, is_pinned
         FROM teacher_memories
        WHERE teacher_id = $1 AND deleted_at IS NULL
        ORDER BY is_pinned DESC, frequency DESC, updated_at DESC`,
      [teacherId]
    )
  ).rows;

  const { data } = await chatJSON({
    system: buildMemoryExtractionSystemPrompt(existing),
    messages: [{ role: 'user', content: `对话内容：\n${transcript}` }],
    temperature: 0.3,
    maxTokens: 800,
    purpose: 'memory_extract',
  });

  const candidates = Array.isArray(data?.memories) ? data.memories : [];
  let inserted = 0;
  let merged = 0;

  for (const raw of candidates.slice(0, 5)) {
    const fact = String(raw?.fact || '').trim().slice(0, 200);
    if (fact.length < 4) continue;

    const memType = VALID_TYPES.includes(raw?.type) ? raw.type : '教学信息';
    let confidence = Number(raw?.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.8;
    confidence = Math.min(0.99, Math.max(0.3, confidence));

    // 置信度太低的不进库：宁可少记，记错了老师会觉得这东西不靠谱
    if (confidence < 0.6) continue;

    const res = await upsertMemory({ teacherId, conversationId, fact, memType, confidence });
    if (res === 'inserted') inserted += 1;
    else if (res === 'merged') merged += 1;
  }

  if (inserted > 0) await pruneMemories(teacherId);

  // 日志不记 fact 内容，只记条数
  logger.info('memory_extracted', { teacher_id: teacherId, conversation_id: conversationId, inserted, merged });
  return { inserted, merged };
}

/**
 * 插入一条，字面重复则 frequency + 1。
 *
 * 注意 ON CONFLICT 后面写的是索引表达式 `(teacher_id, md5(fact)) WHERE deleted_at IS NULL`，
 * 必须和 001_init.sql 里 idx_mem_dedupe 的定义**一模一样**，否则 PostgreSQL 匹配不到那个索引会报错。
 */
async function upsertMemory({ teacherId, conversationId, fact, memType, confidence }) {
  const res = await query(
    `INSERT INTO teacher_memories (teacher_id, fact, mem_type, confidence, source_conv)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (teacher_id, md5(fact)) WHERE deleted_at IS NULL
     DO UPDATE SET
       frequency  = teacher_memories.frequency + 1,
       -- 被再次印证，置信度取高的那个
       confidence = GREATEST(teacher_memories.confidence, EXCLUDED.confidence),
       updated_at = now()
     RETURNING id, (xmax = 0) AS is_insert`,
    [teacherId, fact, memType, confidence, conversationId]
  );
  // xmax = 0 是 PostgreSQL 里判断「这行是刚插入的还是被更新的」的标准写法
  return res.rows[0]?.is_insert ? 'inserted' : 'merged';
}

/**
 * 超过上限时淘汰：只淘汰 is_pinned = false 且 frequency = 1 且最久没更新的。
 * 老师手动加的（is_pinned）永不淘汰 —— 那是他明确表达过的意愿。
 */
async function pruneMemories(teacherId) {
  const res = await query(
    `WITH ranked AS (
       SELECT id
         FROM teacher_memories
        WHERE teacher_id = $1 AND deleted_at IS NULL
        ORDER BY is_pinned DESC, frequency DESC, updated_at DESC
       OFFSET $2
     )
     UPDATE teacher_memories
        SET deleted_at = now()
      WHERE id IN (SELECT id FROM ranked)
        AND is_pinned = false
        AND frequency = 1
      RETURNING id`,
    [teacherId, MAX_MEMORIES]
  );
  if (res.rowCount) logger.info('memory_pruned', { teacher_id: teacherId, count: res.rowCount });
}

/** 读某位老师的全部记忆，供拼装提示词用 */
export async function listMemories(teacherId) {
  const res = await query(
    `SELECT id, fact, mem_type, confidence, frequency, is_pinned, created_at
       FROM teacher_memories
      WHERE teacher_id = $1 AND deleted_at IS NULL
      ORDER BY is_pinned DESC, frequency DESC, updated_at DESC`,
    [teacherId]
  );
  return res.rows;
}
