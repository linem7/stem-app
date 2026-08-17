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
import { ok, asyncRoute, notFound, badRequest, AppError, ErrorCode } from '../utils/errors.js';
import { assertImageQuota } from '../middleware/rateLimit.js';
import { assertQuota } from '../services/quota.js';
import { taskQueue } from '../services/taskQueue.js';
import { generateImage, uploadImage, buildImageUrl } from '../services/minimax.js';
import { buildImagePrompt } from '../services/lessonGenerator.js';
import { buildPurposeSystem, purposeSpec, resolvePurpose } from '../services/imagePurpose.js';
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

/**
 * 一份教案最多几张材料图。
 *
 * 这是内容判断不是成本判断：三张以上老师就不看了，而且材料图越多越像商品目录、
 * 离教案越远。跟每天 10 张那道闸管的是两件事（那个是防刷）。
 */
const MAX_IMAGES_PER_PLAN = 3;

/**
 * section_key 形如 'material.3'，找出它指的那样材料。
 *
 * 下标是**提交那一刻**材料清单里的位置。教案改过之后清单可能变了，
 * 所以真正可靠的是 note（老师点的时候那样材料的名字），下标只作兜底。
 */
function materialName(contentJson, sectionKey, note) {
  if (note) return note;
  const m = /^material\.(\d+)$/.exec(String(sectionKey || ''));
  if (m) {
    const item = contentJson?.materials?.[Number(m[1])];
    if (item) return String(item);
  }
  return '活动材料';
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
    // 用途决定构图规则和画布比例。不认识的值一律当材料图 ——
    // 老师那边不该出现「用途填错了」这种事
    const purpose = resolvePurpose(req.body?.purpose);
    const spec = purposeSpec(purpose);

    // 自由描述时没有 section_key，那 note 就是唯一的信息来源，必须有
    if (!sectionKey && !note) throw badRequest('说说要画什么？');

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

    // 每份教案 3 张的上限。查在最前面 ——
    // 让她挑完材料、等 30 秒，最后才说超了，是最糟的时机。
    // 失败的那些不算（她没拿到图，不该占名额）。
    const used = Number(
      (
        await queryOne(
          `SELECT count(*)::int AS n FROM lesson_images
            WHERE lesson_plan_id = $1 AND status <> 'failed'`,
          [plan.id]
        )
      )?.n || 0
    );
    if (used >= MAX_IMAGES_PER_PLAN) {
      throw new AppError(ErrorCode.IMAGE_LIMIT_EXCEEDED, {
        message: `这份教案已经有 ${used} 张材料图了，最多 3 张`,
        detail: { lesson_plan_id: plan.id, used },
      });
    }

    // 另外两道闸并存，管的是另外两件事：
    //   assertImageQuota —— 每天 10 张的防刷上限（成本保护）
    //   assertQuota      —— 她这个月还剩几张的运营额度
    await assertImageQuota(req.teacherId);
    await assertQuota(req.teacherId, 'image');

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
      `INSERT INTO lesson_images (lesson_plan_id, section_key, purpose, prompt_cn, object_key, status)
       VALUES ($1, $2, $3, $4, '', 'pending')
       RETURNING id`,
      [plan.id, sectionKey, purpose, note || null]
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
          sectionName: materialName(plan.content_json, sectionKey, note),
          note,
          system: buildPurposeSystem(purpose),
        });

        // 第二步：调 MiniMax image-01 出图，拿 base64 当场解成 buffer。
        // 尺寸按用途给：记录表竖版、头饰横长条、背景墙通景，长边一律 2048 ——
        // 这图的终点是打印机，屏幕上根本不需要这么大
        const img = await generateImage({
          prompt, width: spec.width, height: spec.height, optimize: spec.optimize,
        });

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

    return ok(res, { image_id: row.id, status: 'pending', purpose });
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
      purpose: img.purpose,
      // 老师看到的那句话（材料名或她自己的描述），界面上拿它当这张图的标签
      label: img.prompt_cn || null,
      status: img.status,
      url: img.status === 'ready' ? buildImageUrl(img.object_key) : null,
      width: img.width,
      height: img.height,
      // 失败原因给前端显示用；这里是我们自己写的中文，不是模型返回的原文
      error: img.status === 'failed' ? img.error_msg || '配图没生成出来，可以重试' : null,
    });
  })
);
