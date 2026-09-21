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
import { generateImage, resolveImageProvider, anyModelReady } from '../services/imageGen.js';
import { uploadImage, buildImageUrl } from '../services/imageStore.js';
import { buildImagePrompt } from '../services/lessonGenerator.js';
import { buildPurposeSystem, countSubjects, purposeSpec, resolvePurpose, isPrintKind } from '../services/imagePurpose.js';
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
 * section_key 形如 'material.3' 或 'illustrable.1'，找出它指的那一样。
 *
 * 下标是**提交那一刻**那个清单里的位置。教案改过之后清单可能变了，
 * 所以真正可靠的是 note（老师点的时候那样东西的名字），下标只作兜底。
 *
 * ⚠️ **两种前缀是两代结构，别混**：
 *    `material.N`    —— 从前端「材料清单」那条路来的（旧教案、以及
 *                       没有 `illustrable` 的教案走这条）
 *    `illustrable.N` —— 2026-09-21 之后新教案的「画什么」那一栏
 *                       来自 `content_json.illustrable`，**不是 material**
 *
 * 🔴 **认错了不会报错，只会兜出一个错的默认名**。而 `note` 一有就直接返回
 * （前端每次都传），所以这个函数**平时根本走不到下标那一段** ——
 * 正因如此，写错了也看不出来，只在 note 缺了那天才露出来。
 * 两种前缀都认，是为了那时候兜底还是对的。
 *
 * 2026-08-20 改版把材料清单从 `materials` 搬进了 `preparation.material`。
 * 旧图的 section_key 一律不动（「图片永不跟着版本走」是定死的规则），
 * 所以库里还有指向旧路径的图，它们的兜底得继续能用。
 */
function materialName(contentJson, sectionKey, note) {
  if (note) return note;
  const key = String(sectionKey || '');

  const ill = /^illustrable\.(\d+)$/.exec(key);
  if (ill) {
    const item = contentJson?.illustrable?.[Number(ill[1])];
    if (item?.what) return String(item.what);
  }

  const m = /^(?:preparation\.)?material\.(\d+)$/.exec(key);
  if (m) {
    const list = contentJson?.preparation?.material ?? contentJson?.materials;
    const item = list?.[Number(m[1])];
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
    /* 黑白还是彩色（2026-09-21 加的）。
     * `true` 彩色 / `false` 黑白 / 没传 → `null`（**按用途自带的 kind 判，行为跟改之前一样**）。
     * ⚠️ 用 `typeof === 'boolean'` 判，不用 `Boolean(...)` ——
     * `Boolean(undefined)` 是 `false`，那会把「没传」当成「她要黑白」，
     * 于是材料图会莫名其妙变成黑白线稿。 */
    const color = typeof req.body?.color === 'boolean' ? req.body.color : null;
    // 用途决定构图规则和画布比例。不认识的值一律当材料图 ——
    // 老师那边不该出现「用途填错了」这种事
    const purpose = resolvePurpose(req.body?.purpose);
    /* 🔴 **两条路的构图规则完全不同，不能都用 `countSubjects`**（2026-09-21 修）。
     *
     * 【路 A：她自己描述 / 方案卡片填的内容】（`note` 是一段完整的描述）
     *   这种情况下**她自己已经说清了这张纸怎么排** ——
     *   「上半张是记录表，下半张是材料图卡」这种。我们**不该再插一手**。
     *   而原来这里会用 `countSubjects` 按顿号逗号数出「几样」，
     *   再按样数排成裁切网格 —— 结果把她的描述**覆盖**成一张九宫格。
     *
     *   用户报的那张图就是这么来的：他写了一段「上半记录表 + 下半材料图卡」，
     *   而那句话里有 8 个逗号 2 个分号，`countSubjects` 数出 9 样，
     *   于是排成 3×3，**记录表那半张被格子挤掉了**。
     *
     * 【路 B：从材料清单里勾了几样】（`note` 是「磁铁、回形针、小石头」）
     *   这条路上 `countSubjects` 是对的 —— 那是**列举**，不是叙述。
     *
     * 判据用 `plan: true` 这个标记（前端在「有方案」时发），
     * 不靠猜 note 的长短 —— 猜不准，而且「猜错」的表现是她拿到一张
     * 完全不是她要的图，还不知道为什么。
     */
    const isPlan = req.body?.plan === true;
    const subjects = isPlan ? 1 : countSubjects(note);
    const spec = purposeSpec(purpose, subjects);
    // 用哪家模型**由后台定**，不看请求里传了什么（2026-08-18 定：老师不选模型）。
    // 这里刻意不读 req.body.provider —— 读了就等于把技术选型的开关交到客户端手上，
    // 而客户端是可以被随便改的；老师也没有判断依据去选。
    const provider = await resolveImageProvider();

    // 自由描述时没有 section_key，那 note 就是唯一的信息来源，必须有
    if (!sectionKey && !note) throw badRequest('说说要画什么？');

    // 两家模型一家都没配就在这里挡掉，别往下走。
    // 往下走的代价是实打实的：会先调一次 DeepSeek 把中文描述翻成英文提示词
    // （每次约 250 token），再到出图那步必然失败；而且 assertImageQuota 在下面，
    // 老师每天 10 张的额度会被这些注定失败的请求白白吃掉。
    //
    // 这里不查对象存储：没配对象存储时 uploadImage 会存到本地磁盘，
    // 单机开发照样能把「生成→落地→显示」跑通（见 imageStore.js 的 uploadImage）。
    if (!(await anyModelReady())) {
      throw new AppError(ErrorCode.NOT_IMPLEMENTED, {
        message: '配图功能还没开通，先用文字教案吧',
        detail: {
          reason: 'no_image_provider_configured',
          hint: '在 .env 里填 IMG_API_KEY（gpt-image-2）或 MINIMAX_API_KEY',
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
      `INSERT INTO lesson_images (lesson_plan_id, section_key, purpose, provider, prompt_cn, object_key, status)
       VALUES ($1, $2, $3, $4, $5, '', 'pending')
       RETURNING id`,
      [plan.id, sectionKey, purpose, provider, note || null]
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
          system: buildPurposeSystem(purpose, subjects, { color }),
          teacherId: req.teacherId,
        });

        // 第二步：调出图模型（gpt-image-2 或 MiniMax，看 provider），拿 base64 当场解成 buffer。
        // 尺寸按用途给：记录表竖版、头饰横长条、背景墙通景，长边一律 2048 ——
        // 这图的终点是打印机，屏幕上根本不需要这么大
        const img = await generateImage({
          provider,
          prompt,
          width: spec.width,
          height: spec.height,
          // optimize 只有 MiniMax 认，quality 只有 gpt-image-2 认，各取所需
          optimize: spec.optimize,
          quality: spec.quality,
        });

        // 第三步：落地。**压缩在 uploadImage 里做** —— 在那里是唯一正确的位置，
        // 因为它是所有图的唯一落地点（配图生成、后台模型测试两条路都走它）。
        // 这里只告诉它「这张是不是打印类」：记录表/头饰是粗黑线硬边，
        // 压缩痕迹比插画容易露，所以用更保守的质量。
        // 扩展名跟着真实格式走（image-01 返回的是 JPEG），别写死 png
        const { objectKey, bytes, width, height } = await uploadImage({
          buffer: img.buffer,
          ext: img.ext || 'jpg',
          isPrint: isPrintKind(purpose),
        });

        /* 🔴 **宽高要写压缩之后的实际尺寸，不是模型要求的那个。**
           原来是 `img.width` / `img.height` —— 那是我们**请求**的尺寸，
           而模型回的有时候不一样（要 2048 回了 2400），压缩之后又变一次。
           库里记错尺寸不是小事：导出 docx 时按它算缩放比例
           （`lessonDocx.js` 的 `fitBox`），记录表被按错比例压扁就是废纸。
           ⚠️ `uploadImage` 在「没压」时回 `null`（PNG、或压完更大），
           那时候沿用模型给的值才对。 */
        await query(
          `UPDATE lesson_images
              SET object_key = $1, prompt_sent = $2, width = $3, height = $4,
                  bytes = $5, cost_cents = $6, status = 'ready', error_msg = NULL
            WHERE id = $7`,
          [objectKey, prompt,
            width ?? img.width, height ?? img.height,
            bytes, img.costCents ?? null, row.id]
        );

        // 教案库列表要显示"有配图"的标记
        await query(`UPDATE conversations SET has_image = true, updated_at = now() WHERE id = $1`, [
          plan.conversation_id,
        ]);

        logger.info('image_generated', {
          image_id: row.id,
          lesson_plan_id: plan.id,
          teacher_id: teacher.id,
          provider: img.provider,
          purpose,
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

    return ok(res, { image_id: row.id, status: 'pending', purpose, provider });
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
      provider: img.provider,
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
