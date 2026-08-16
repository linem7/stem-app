/**
 * 用户记忆 —— api-spec 第 8 节
 *
 *   GET    /memories       列表
 *   POST   /memories       老师手动加一条（自动置顶，不参与自动淘汰）
 *   PATCH  /memories/:id   编辑
 *   DELETE /memories/:id   删除
 *
 * 隐私底线：写入是后端自动的，但**删改权必须完全在老师手里**。
 * 所以这四个接口全部按 teacher_id 过滤，没有任何"后台代改"的口子。
 */
import { Router } from 'express';
import { query, queryOne } from '../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../utils/errors.js';
import { msgSecCheck, contentBlockedError } from '../services/wechat.js';
import { logger } from '../utils/logger.js';

export const memoriesRouter = Router();

const VALID_TYPES = ['教学信息', '教学风格', '约束条件', '材料偏好', '年龄班专长'];

function toDTO(row) {
  return {
    id: row.id,
    fact: row.fact,
    mem_type: row.mem_type,
    is_pinned: row.is_pinned,
    frequency: row.frequency,
    confidence: row.confidence,
    created_at: row.created_at,
  };
}

memoriesRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const rows = (
      await query(
        `SELECT * FROM teacher_memories
          WHERE teacher_id = $1 AND deleted_at IS NULL
          ORDER BY is_pinned DESC, frequency DESC, updated_at DESC`,
        [req.teacherId]
      )
    ).rows;
    return ok(res, { items: rows.map(toDTO) });
  })
);

memoriesRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const fact = String(req.body?.fact || '').trim();
    if (!fact) throw badRequest('写一句你想让我记住的事');
    if (fact.length > 200) throw badRequest('一条记忆写 200 字以内就够了');

    const memType = VALID_TYPES.includes(req.body?.mem_type) ? req.body.mem_type : '教学信息';

    const check = await msgSecCheck({
      content: fact,
      openid: req.teacher.openid,
      scene: 1,
      stage: 'teacher_input',
    });
    if (!check.pass) throw contentBlockedError('teacher_input');

    // 手动添加的自动 is_pinned = true，永不自动淘汰（api-spec 第 8 节）。
    // 如果这句话之前被自动提取过，这里会撞上 md5(fact) 唯一索引 ——
    // 那就把它升格为置顶，而不是报"重复"让老师困惑。
    const row = await queryOne(
      `INSERT INTO teacher_memories (teacher_id, fact, mem_type, confidence, is_pinned)
       VALUES ($1, $2, $3, 1.00, true)
       ON CONFLICT (teacher_id, md5(fact)) WHERE deleted_at IS NULL
       DO UPDATE SET is_pinned = true, confidence = 1.00, mem_type = EXCLUDED.mem_type, updated_at = now()
       RETURNING *`,
      [req.teacherId, fact, memType]
    );

    logger.info('memory_added_manually', { teacher_id: req.teacherId, memory_id: row.id });
    return ok(res, toDTO(row), 201);
  })
);

memoriesRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound('没有找到这条记忆');

    const existing = await queryOne(
      `SELECT * FROM teacher_memories WHERE id = $1 AND teacher_id = $2 AND deleted_at IS NULL`,
      [id, req.teacherId]
    );
    if (!existing) throw notFound('没有找到这条记忆');

    const sets = [];
    const params = [];
    const push = (col, v) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };

    if (req.body?.fact !== undefined) {
      const fact = String(req.body.fact || '').trim();
      if (!fact) throw badRequest('记忆内容不能为空');
      if (fact.length > 200) throw badRequest('一条记忆写 200 字以内就够了');
      const check = await msgSecCheck({
        content: fact,
        openid: req.teacher.openid,
        scene: 1,
        stage: 'teacher_input',
      });
      if (!check.pass) throw contentBlockedError('teacher_input');
      push('fact', fact);
      // 老师亲手改过的，就算是他确认过的，置顶
      push('is_pinned', true);
      push('confidence', 1.0);
    }
    if (req.body?.mem_type !== undefined) {
      if (!VALID_TYPES.includes(req.body.mem_type)) throw badRequest('记忆类型不对');
      push('mem_type', req.body.mem_type);
    }
    if (req.body?.is_pinned !== undefined) {
      push('is_pinned', Boolean(req.body.is_pinned));
    }
    if (!sets.length) return ok(res, toDTO(existing));

    params.push(id);
    const updated = await queryOne(
      `UPDATE teacher_memories SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length} RETURNING *`,
      params
    );
    return ok(res, toDTO(updated));
  })
);

memoriesRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound('没有找到这条记忆');

    // 软删除：30 天后物理清理（db-schema.md 第 8 节）。
    // 注意去重唯一索引带了 WHERE deleted_at IS NULL，
    // 所以删掉之后同一句话还能重新被记住，不会被旧记录挡住。
    const row = await queryOne(
      `UPDATE teacher_memories SET deleted_at = now(), updated_at = now()
        WHERE id = $1 AND teacher_id = $2 AND deleted_at IS NULL
        RETURNING id`,
      [id, req.teacherId]
    );
    if (!row) throw notFound('没有找到这条记忆');

    logger.info('memory_deleted', { teacher_id: req.teacherId, memory_id: id });
    return ok(res, { deleted: true });
  })
);
