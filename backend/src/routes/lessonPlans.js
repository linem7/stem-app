/**
 * 教案 —— api-spec 第 5 节
 *
 *   GET   /lesson-plans/:id          取教案（含配图列表）
 *   PATCH /lesson-plans/:id          局部编辑
 *   POST  /lesson-plans/:id/export   导出
 */
import { Router } from 'express';
import { query, queryOne } from '../db/pool.js';
import { ok, asyncRoute, badRequest, notFound, AppError, ErrorCode } from '../utils/errors.js';
import { renderMarkdown } from '../services/lessonGenerator.js';
import { buildImageUrl } from '../services/minimax.js';
import { msgSecCheck, contentBlockedError } from '../services/wechat.js';
import { rateHandler } from './feedback.js';
import { logger } from '../utils/logger.js';

export const lessonPlansRouter = Router();

// 教案评价。实现在 feedback.js（跟产品建议共用一张表和一套内容安全），
// 但路径归 lesson-plans 管，所以挂在这里。
lessonPlansRouter.post('/:id/rate', rateHandler);

async function loadPlan(id, teacherId) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw notFound('没有找到这份教案');
  const plan = await queryOne(`SELECT * FROM lesson_plans WHERE id = $1 AND teacher_id = $2`, [n, teacherId]);
  if (!plan) throw notFound('没有找到这份教案');
  return plan;
}

async function loadImages(lessonPlanId) {
  const rows = (
    await query(
      `SELECT id, section_key, object_key, status, width, height, created_at
         FROM lesson_images WHERE lesson_plan_id = $1 ORDER BY id ASC`,
      [lessonPlanId]
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    section_key: r.section_key,
    status: r.status,
    // url 是拼出来的，不入库：换域名或换云厂商时只改 buildImageUrl 一处
    url: r.status === 'ready' ? buildImageUrl(r.object_key) : null,
    width: r.width,
    height: r.height,
  }));
}

// ---------------------------------------------------------------
// GET /lesson-plans/:id
// ---------------------------------------------------------------
lessonPlansRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const plan = await loadPlan(req.params.id, req.teacherId);
    return ok(res, {
      id: plan.id,
      conversation_id: plan.conversation_id,
      title: plan.title,
      age_group: plan.age_group,
      duration_min: plan.duration_min,
      content_json: plan.content_json,
      content_md: plan.content_md,
      version: plan.version,
      // quality_self 是内测分析用的，前端不展示，但返回出来方便你自己看模型自检结果
      quality_self: plan.quality_self,
      images: await loadImages(plan.id),
      updated_at: plan.updated_at,
    });
  })
);

// ---------------------------------------------------------------
// PATCH /lesson-plans/:id
// ---------------------------------------------------------------
lessonPlansRouter.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const plan = await loadPlan(req.params.id, req.teacherId);
    const body = req.body || {};

    // 支持两种改法：
    //   1. { path: "flow.1.detail", value: "..." }  改一个点（api-spec 说的「传 content_json 的某个路径」）
    //   2. { content_json: { ... } }                整段覆盖某几个顶层字段
    let nextJson = structuredClone(plan.content_json || {});

    if (typeof body.path === 'string' && body.path.trim()) {
      if (body.value === undefined) throw badRequest('要改成什么内容？');
      setByPath(nextJson, body.path.trim(), body.value);
    } else if (body.content_json && typeof body.content_json === 'object') {
      nextJson = { ...nextJson, ...body.content_json };
    } else if (body.title === undefined) {
      throw badRequest('没有要修改的内容');
    }

    if (body.title !== undefined) {
      const t = String(body.title || '').trim().slice(0, 128);
      if (!t) throw badRequest('标题不能为空');
      nextJson.title = t;
    }

    // 老师改的内容也是 UGC，要过内容安全
    const changedText = JSON.stringify(body).slice(0, 2000);
    const check = await msgSecCheck({
      content: changedText,
      openid: req.teacher.openid,
      scene: 3,
      stage: 'teacher_input',
    });
    if (!check.pass) throw contentBlockedError('teacher_input');

    const title = String(nextJson.title || plan.title).slice(0, 128);
    const durationMin = Number.isFinite(Number(nextJson.duration_min))
      ? Number(nextJson.duration_min)
      : plan.duration_min;

    // md 由 json 重新渲染 —— db-schema.md 要求两份不许各自漂移
    const contentMd = renderMarkdown({
      title,
      age_group: plan.age_group,
      duration_min: durationMin,
      content_json: nextJson,
    });

    const updated = await queryOne(
      `UPDATE lesson_plans
          SET title = $1, duration_min = $2, content_json = $3::jsonb, content_md = $4, updated_at = now()
        WHERE id = $5
        RETURNING *`,
      [title, durationMin, JSON.stringify(nextJson), contentMd, plan.id]
    );

    // 教案库列表读的是 conversations.title，改了标题要同步过去
    await query(`UPDATE conversations SET title = $1, updated_at = now() WHERE id = $2`, [
      title,
      plan.conversation_id,
    ]);

    logger.info('lesson_edited', { lesson_plan_id: plan.id, teacher_id: req.teacherId, path: body.path });

    return ok(res, {
      id: updated.id,
      title: updated.title,
      age_group: updated.age_group,
      duration_min: updated.duration_min,
      content_json: updated.content_json,
      content_md: updated.content_md,
      version: updated.version,
      images: await loadImages(updated.id),
      updated_at: updated.updated_at,
    });
  })
);

// ---------------------------------------------------------------
// POST /lesson-plans/:id/export
// ---------------------------------------------------------------
lessonPlansRouter.post(
  '/:id/export',
  asyncRoute(async (req, res) => {
    const plan = await loadPlan(req.params.id, req.teacherId);
    const format = String(req.body?.format || 'docx');

    if (format === 'md') {
      // Markdown 是现成的，直接内联返回，前端可以自己存文件或复制
      return ok(res, {
        format: 'md',
        content: plan.content_md,
        filename: `${plan.title}.md`,
      });
    }

    if (format !== 'docx') throw badRequest('暂时只支持导出 Word 和 Markdown');

    // ============ TODO：导出 docx ============
    // 待补的三步（拿到对象存储之后做）：
    //   1. npm i docx          —— 纯 JS 生成 .docx，不需要装 Office
    //      文档：https://docx.js.org/  按 content_json 的结构逐段建 Paragraph
    //      注意教案里有表格（STEAM 知识概念），用 docx 的 Table 组件
    //   2. 用 services/minimax.js 里的 uploadImage 同款方式传到对象存储
    //   3. 生成 1 小时有效的**预签名 URL**（不能给公开永久链接，教案是老师的私有内容）
    //      腾讯云 COS: cos.getObjectUrl({ Sign: true, Expires: 3600 })
    //      阿里云 OSS: client.signatureUrl(key, { expires: 3600 })
    // 上面三步做完，把下面这个 throw 换成返回 { url, expires_at } 即可，
    // 接口形状（api-spec 第 5 节）已经定死了，前端不用改。
    // =========================================
    logger.warn('export_not_implemented', { lesson_plan_id: plan.id, format });
    throw new AppError(ErrorCode.NOT_IMPLEMENTED, {
      message: '导出 Word 还在做，先用「复制全文」把教案带走吧',
      detail: { reason: 'export_docx_not_implemented' },
    });
  })
);

/**
 * 按路径写值，支持数组下标：'flow.1.detail'、'steam.S'、'materials.0'
 * 路径中间缺失的层不自动创建 —— 教案的结构是生成时定好的，
 * 允许凭空造出新结构只会让 md 渲染出奇怪的东西。
 */
function setByPath(obj, path, value) {
  const parts = path.split('.').filter(Boolean);
  if (!parts.length) throw badRequest('要改哪一段？');
  if (parts.length > 5) throw badRequest('路径太深了');

  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = Array.isArray(cur) ? Number(parts[i]) : parts[i];
    if (cur[key] === undefined || cur[key] === null || typeof cur[key] !== 'object') {
      throw badRequest('这段内容不存在，刷新一下再改');
    }
    cur = cur[key];
  }
  const last = Array.isArray(cur) ? Number(parts[parts.length - 1]) : parts[parts.length - 1];
  if (Array.isArray(cur) && !Number.isInteger(last)) throw badRequest('路径格式不对');
  cur[last] = value;
}
