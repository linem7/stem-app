/**
 * 配图 —— api-spec 第 6 节
 *
 *   POST /lesson-plans/:id/images                创建配图任务，立刻返回 pending
 *   GET  /lesson-plans/:id/images/:image_id      轮询取结果
 *
 * 每日上限是硬要求：图片是主要成本项，没有闸门会被刷（api-spec 第 6 节）。
 * 这个闸门查的是数据库而不是内存，进程重启不会重置（见 middleware/rateLimit.js）。
 */
import { Router } from 'express';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { ok, asyncRoute, notFound, AppError, ErrorCode } from '../utils/errors.js';
import { assertImageQuota } from '../middleware/rateLimit.js';
import { taskQueue } from '../services/taskQueue.js';
import { generateImage, uploadImage, buildImageUrl } from '../services/minimax.js';
import { buildImagePrompt } from '../services/lessonGenerator.js';
import { IMAGE_PROMPT_SYSTEM } from '../services/promptBuilder.js';
import { msgSecCheck, contentBlockedError } from '../services/wechat.js';
import { logger } from '../utils/logger.js';

export const imagesRouter = Router();

async function loadPlan(id, teacherId) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw notFound('没有找到这份教案');
  const plan = await queryOne(`SELECT * FROM lesson_plans WHERE id = $1 AND teacher_id = $2`, [n, teacherId]);
  if (!plan) throw notFound('没有找到这份教案');
  return plan;
}

/** section_key 形如 'flow.1'，找出它对应的环节名，让图片提示词更贴题 */
function sectionName(contentJson, sectionKey) {
  if (!sectionKey) return '活动过程';
  const m = /^flow\.(\d+)$/.exec(sectionKey);
  if (m) {
    const idx = Number(m[1]);
    return contentJson?.flow?.[idx]?.stage || contentJson?.flow?.[idx - 1]?.stage || '活动过程';
  }
  return { materials: '材料准备', extension: '延伸活动' }[sectionKey] || '活动过程';
}

// ---------------------------------------------------------------
// POST /lesson-plans/:id/images
// ---------------------------------------------------------------
imagesRouter.post(
  '/:id/images',
  asyncRoute(async (req, res) => {
    const plan = await loadPlan(req.params.id, req.teacherId);
    const sectionKey = req.body?.section_key ? String(req.body.section_key).slice(0, 32) : null;
    const note = req.body?.note ? String(req.body.note).slice(0, 200) : '';

    // 没配 MiniMax 就在这里挡掉，别往下走。
    // 往下走的代价是实打实的：会先调一次 DeepSeek 把中文描述翻成英文提示词
    // （每次约 250 token），再到出图那步必然失败；而且 assertImageQuota 在下面，
    // 老师每天 10 张的额度会被这些注定失败的请求白白吃掉。
    //
    // 这里只查 MiniMax，不查对象存储：没配对象存储时 uploadImage 会存到本地磁盘，
    // 单机开发照样能把「生成→落地→显示」跑通（见 minimax.js 的 uploadImage）。
    if (!config.minimax.configured) {
      throw new AppError(ErrorCode.NOT_IMPLEMENTED, {
        message: '配图功能还没开通，先用文字教案吧',
        detail: {
          reason: 'minimax_not_configured',
          hint: '在 .env 里填 MINIMAX_API_KEY',
        },
      });
    }

    await assertImageQuota(req.teacherId);

    if (note) {
      const check = await msgSecCheck({
        content: note,
        openid: req.teacher.openid,
        scene: 3,
        stage: 'teacher_input',
      });
      if (!check.pass) throw contentBlockedError('teacher_input');
    }

    // object_key 先落空串：这一列是 NOT NULL（db-schema.md），
    // 而 key 要等图片真生成出来、上传成功才知道。用空串占位比改表结构划算。
    const row = await queryOne(
      `INSERT INTO lesson_images (lesson_plan_id, section_key, prompt_cn, object_key, status)
       VALUES ($1, $2, $3, '', 'pending')
       RETURNING id`,
      [plan.id, sectionKey, note || null]
    );

    const teacher = req.teacher;
    taskQueue.enqueue({
      id: `img_${row.id}`,
      kind: 'generate_image',
      run: async () => {
        // 第一步：让文本模型把老师的中文描述翻成适合图片模型的英文提示词
        const prompt = await buildImagePrompt({
          lessonTitle: plan.title,
          ageGroup: plan.age_group,
          sectionName: sectionName(plan.content_json, sectionKey),
          note,
          system: IMAGE_PROMPT_SYSTEM,
        });

        // 第二步：调 MiniMax image-01 出图，拿 base64 当场解成 buffer
        const img = await generateImage({ prompt });

        // 第三步：落地。配了对象存储就传云上，没配就存本地磁盘；两种都只回 object_key
        // 扩展名跟着真实格式走（image-01 返回的是 JPEG），别写死 png
        const { objectKey, bytes } = await uploadImage({ buffer: img.buffer, ext: img.ext || 'jpg' });

        await query(
          `UPDATE lesson_images
              SET object_key = $1, prompt_sent = $2, width = $3, height = $4,
                  bytes = $5, cost_cents = $6, status = 'ready', error_msg = NULL
            WHERE id = $7`,
          [objectKey, prompt, img.width, img.height, bytes, img.costCents ?? null, row.id]
        );

        // 教案库列表要显示"有配图"的标记
        await query(`UPDATE conversations SET has_image = true, updated_at = now() WHERE id = $1`, [
          plan.conversation_id,
        ]);

        logger.info('image_generated', {
          image_id: row.id,
          lesson_plan_id: plan.id,
          teacher_id: teacher.id,
          bytes,
          cost_cents: img.costCents,
        });
      },
      onError: async (err) => {
        await query(`UPDATE lesson_images SET status = 'failed', error_msg = $1 WHERE id = $2`, [
          String(err?.message || '生成失败').slice(0, 200),
          row.id,
        ]);
      },
    });

    return ok(res, { image_id: row.id, status: 'pending' });
  })
);

// ---------------------------------------------------------------
// GET /lesson-plans/:id/images/:image_id
// ---------------------------------------------------------------
imagesRouter.get(
  '/:id/images/:image_id',
  asyncRoute(async (req, res) => {
    const plan = await loadPlan(req.params.id, req.teacherId);
    const imageId = Number(req.params.image_id);
    if (!Number.isInteger(imageId) || imageId <= 0) throw notFound('没有找到这张配图');

    const img = await queryOne(
      `SELECT * FROM lesson_images WHERE id = $1 AND lesson_plan_id = $2`,
      [imageId, plan.id]
    );
    if (!img) throw notFound('没有找到这张配图');

    return ok(res, {
      image_id: img.id,
      section_key: img.section_key,
      status: img.status,
      url: img.status === 'ready' ? buildImageUrl(img.object_key) : null,
      width: img.width,
      height: img.height,
      // 失败原因给前端显示用；这里是我们自己写的中文，不是模型返回的原文
      error: img.status === 'failed' ? img.error_msg || '配图没生成出来，可以重试' : null,
    });
  })
);
