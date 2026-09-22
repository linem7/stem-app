/**
 * 教案 —— api-spec 第 5 节
 *
 *   GET   /lesson-plans/:id          取教案（含配图列表）
 *   PATCH /lesson-plans/:id          局部编辑
 *   POST  /lesson-plans/:id/update   同上，兼容别名
 *   POST  /lesson-plans/:id/export   导出
 */
import { Router } from 'express';
import { query, queryOne } from '../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../utils/errors.js';
import { renderMarkdown } from '../services/lessonGenerator.js';
import { buildImageUrl, readImage } from '../services/imageStore.js';
import { buildLessonDocx } from '../services/lessonDocx.js';
import { PURPOSES } from '../services/imagePurpose.js';
import { checkText, contentBlockedError } from '../services/contentSafety.js';
import { logger } from '../utils/logger.js';

export const lessonPlansRouter = Router();

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
      // prompt_cn 是老师当时选的那样材料的名字。必须带出来 ——
      // 教案改过之后材料清单可能已经变了，图还在（有意的，见 api-spec 6.5），
      // 界面上得靠这个名字说清楚每张图对的是什么，让她自己判断还用不用得上。
      `SELECT id, section_key, purpose, prompt_cn, object_key, status, width, height, created_at
         FROM lesson_images WHERE lesson_plan_id = $1 ORDER BY id ASC`,
      [lessonPlanId]
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    section_key: r.section_key,
    // 打印出来干什么用：material 材料图 | worksheet 记录表 | headwear 头饰 |
    // display 展示图 | backdrop 环创背景。构图完全不同，界面上也要分开标
    purpose: r.purpose || 'material',
    // 老师看到的那句话（材料名或她自己的描述）。教案改过之后材料清单可能
    // 已经不含它了，图仍然留着 —— 靠这个标签说清楚每张图对的是什么
    label: r.prompt_cn || null,
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
      // 一共出到第几版 / 现在显示的是哪一版。回退之后这两个数不一样
      current_version: plan.current_version ?? plan.version,
      images: await loadImages(plan.id),
      updated_at: plan.updated_at,
    });
  })
);

// ---------------------------------------------------------------
// GET /lesson-plans/:id/versions —— api-spec 第 6.5 节
// ---------------------------------------------------------------
lessonPlansRouter.get(
  '/:id/versions',
  asyncRoute(async (req, res) => {
    const plan = await loadPlan(req.params.id, req.teacherId);
    const rows = (
      await query(
        `SELECT version, title, duration_min, revise_note, created_at
           FROM lesson_plan_versions WHERE lesson_plan_id = $1 ORDER BY version ASC`,
        [plan.id]
      )
    ).rows;
    const current = plan.current_version ?? plan.version;
    return ok(res, {
      current_version: current,
      versions: rows.map((r) => ({
        version: r.version,
        title: r.title,
        duration_min: r.duration_min,
        is_current: r.version === current,
        // 产生这一版的那句改稿意见。老师认版本靠这个，不是靠版本号
        note: r.revise_note || null,
        created_at: r.created_at,
      })),
    });
  })
);

// ---------------------------------------------------------------
// POST /lesson-plans/:id/rollback —— api-spec 第 6.5 节
//
// 把某一版的内容写回当前教案。**不新增版本号、不删任何版本**，所以能来回切。
// 不查额度：回退不调模型，而且没有退路本来就是我们造成的，不该让她为此花额度。
// **不动图片**：图挂在 lesson_plan_id 上，跨版本一直在，这是有意的。
// ---------------------------------------------------------------
lessonPlansRouter.post(
  '/:id/rollback',
  asyncRoute(async (req, res) => {
    const plan = await loadPlan(req.params.id, req.teacherId);
    const target = Number(req.body?.version);
    if (!Number.isInteger(target) || target <= 0) throw badRequest('要回到第几版？');

    const snap = await queryOne(
      `SELECT * FROM lesson_plan_versions WHERE lesson_plan_id = $1 AND version = $2`,
      [plan.id, target]
    );
    if (!snap) throw notFound('找不到那一版了');

    const current = plan.current_version ?? plan.version;
    if (current === target) {
      return ok(res, { version: target, title: plan.title, content_json: plan.content_json, unchanged: true });
    }

    const updated = await queryOne(
      `UPDATE lesson_plans
          SET title = $1, age_group = $2, duration_min = $3,
              content_md = $4, content_json = $5::jsonb, quality_self = $6::jsonb,
              current_version = $7, updated_at = now()
        WHERE id = $8
        RETURNING *`,
      [
        snap.title,
        snap.age_group,
        snap.duration_min,
        snap.content_md,
        JSON.stringify(snap.content_json),
        JSON.stringify(snap.quality_self),
        target,
        plan.id,
      ]
    );

    // 教案库里那条也要跟着改标题，否则列表上显示的还是回退前那一版的名字
    await query(`UPDATE conversations SET title = $1, updated_at = now() WHERE id = $2`, [
      snap.title,
      plan.conversation_id,
    ]);

    logger.info('plan_rollback', {
      teacher_id: req.teacherId,
      lesson_plan_id: plan.id,
      from_version: current,
      to_version: target,
    });

    return ok(res, {
      version: target,
      current_version: target,
      title: updated.title,
      duration_min: updated.duration_min,
      content_json: updated.content_json,
    });
  })
);

// ---------------------------------------------------------------
// PATCH /lesson-plans/:id  ＝  POST /lesson-plans/:id/update
//
// **两个方法同一个 handler**，因为 wx.request 发不出 PATCH（同 memories.js）。
//
// 前端**目前没有调用方**，这是有意的（用户 2026-08-21 定）：成稿页不给
// 「自己动手改文字」的入口，老师改教案一律走「改一改」那条 AI 重写的路 ——
// 手打改教案在手机上本来就难用，而 AI 重写是这个产品的核心。
// 别看到「没人调」就把这条路删掉：接口通着，哪天要用不必再动后端。
// ---------------------------------------------------------------
const updateLessonPlan = asyncRoute(async (req, res) => {
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
    const changedText = JSON.stringify(nextJson);
    const check = await checkText({
      content: changedText,
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
  });

lessonPlansRouter.patch('/:id', updateLessonPlan);
lessonPlansRouter.post('/:id/update', updateLessonPlan);

// ---------------------------------------------------------------
// POST /lesson-plans/:id/export
// ---------------------------------------------------------------

/* 配图用途的中文名。**从 PURPOSES 里取，不另写一份** ——
   同一个概念写两处，改一处另一处就会分叉，而分叉的表现是
   「网页上叫记录表、导出来叫配图」，她分不清哪张是给孩子填的。 */
const PURPOSE_LABEL = Object.fromEntries(
  Object.entries(PURPOSES).map(([k, v]) => [k, v.cn])
);

/** 从 object_key 里取扩展名（生成时存的是 jpg 或 png） */
function extOf(key) {
  const m = /\.(\w+)$/.exec(String(key || ''));
  const ext = m ? m[1].toLowerCase() : 'jpg';
  // docx 的 ImageRun 只认这几个；别的当 jpg 试
  return ['jpg', 'jpeg', 'png', 'gif', 'bmp'].includes(ext) ? ext : 'jpg';
}

lessonPlansRouter.post(
  '/:id/export',
  asyncRoute(async (req, res) => {
    const plan = await loadPlan(req.params.id, req.teacherId);
    const format = String(req.body?.format || 'docx');

    /*
      🔴 **导出不带教案解读**（`content_json.commentary`）。用户 2026-08-21 定，
      当天先改成带、又撤回了 —— 撤回的原因值得记下来，免得下次又来一遍：

      他说的「导出的时候解读也导出」，指的是**「设计意图」（`intent`）**——
      那是教案正文的第一节，跟活动目标、活动过程同级，**本来就一直在导出里**。
      而我说的「解读」是学习模式下挂在各板块底下那行折叠的「为什么这样设计」，
      讲的是「我为什么这么写这份教案」，是给她看的旁白、不是教案内容。
      两样东西名字太像，说的时候必须带上字段名。

      所以导出就是 `plan.content_md` —— 落库时渲染好的那一份，不含 commentary。
      不需要重渲染。

      要改回带解读只有一行：把下面 `plan.content_md` 换成
      `renderMarkdown({...plan}, { withCommentary: true })`
      （`renderMarkdown` 那个开关留着没删，就是为了这一行）。
    */

    if (format === 'md') {
      // Markdown 是现成的，直接内联返回，前端可以自己存文件或复制
      return ok(res, {
        format: 'md',
        content: plan.content_md,
        filename: `${plan.title}.md`,
      });
    }

    if (format !== 'docx') throw badRequest('暂时只支持导出 Word 和 Markdown');

    /* ============ 导出 .docx（2026-09-21 做的）============
     *
     * 🔴 **直接回文件流，不用对象存储。**
     * 原来这里那段 TODO 是按对象存储写的（要预签名 URL、要 1 小时过期），
     * 而用户 2026-09-21 定了**不上对象存储** —— 那么「先传上去再给她一个
     * 会过期的链接」这件事就没有存在理由了：**文件当场生成、当场给她**，
     * 少一个外部依赖，也少一类「链接过期了图打不开」的故障。
     *
     * ⚠️ **`POST` 而不是 `GET`，所以前端不能用 `window.open`。**
     * 这是个 POST 接口（`req.body.format`），浏览器直接开链接发不出 POST。
     * 前端那边是用 `fetch` 拿 blob 再触发下载的 —— 见 `s-plan.vue`。
     * 要改成 `window.open` 的话得先把这个接口改成 GET + query 参数，
     * 而那会动 api-spec，所以没动。
     * ==================================================== */

    /* 取配图。
       ⚠️ 只取 `ready` 的 —— 还在画或者画失败的那些没有文件可读，
       硬塞会变成一个空图框，而她打出来才发现（一份 A4 纸就废了）。
       ⚠️ 顺序按 id，跟她在网页上看到的顺序一致。 */
    const imageRows = (await query(
      `SELECT i.id, i.object_key, i.width, i.height, i.purpose
         FROM lesson_images i
        WHERE i.lesson_plan_id = $1 AND i.status = 'ready'
        ORDER BY i.id`,
      [plan.id])).rows;

    const images = [];
    for (const row of imageRows) {
      try {
        const data = await readImage(row.object_key);
        if (!data) continue;
        images.push({
          data,
          width: row.width,
          height: row.height,
          /* 扩展名从 object_key 里取 —— 生成时存的是 jpg / png，
             写死 'jpg' 的话 PNG 那张在 Word 里会解不出来 */
          type: extOf(row.object_key),
          purposeLabel: PURPOSE_LABEL[row.purpose] || '配图',
        });
      } catch (err) {
        /* 一张图读不出来**不能让整份导出失败** ——
           教案正文才是她要的东西，少一张图她还能用，
           而整份导不出来她今天就交不上。记日志，跳过。 */
        logger.warn('export_image_skipped', {
          lesson_plan_id: plan.id, object_key: row.object_key, err: err.message,
        });
      }
    }

    const buf = await buildLessonDocx({
      plan,
      content: plan.content_json || {},
      images,
    });

    /* 文件名。**要带班和年龄班** —— 她一天可能导好几份，
       都叫「教案.docx」的话在下载文件夹里分不出哪个是哪个。
       ⚠️ 中文文件名必须用 `filename*=UTF-8''` 那个形式，
       只写 `filename=` 的话 Chrome 会把它变成一串乱码。 */
    const parts = [plan.title, plan.class_name, plan.age_group].filter(Boolean);
    const filename = `${parts.join('_')}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="jiaogan.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader('Content-Length', buf.length);
    return res.end(buf);
  })
);

/**
 * 按路径写值，支持数组下标：'flow.1.detail'、'steam.S'、'preparation.material.0'
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
