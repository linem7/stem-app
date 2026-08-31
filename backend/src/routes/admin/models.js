import { Router } from 'express';
import { query, queryOne } from '../../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../../utils/errors.js';
import { logAction } from '../../services/admins.js';
import { listModels, pickModel, generateWith, IMAGE_FORMATS, TEXT_FORMATS, guessFormat, deriveKey } from '../../services/modelRegistry.js';
import { chat as textModelChat } from '../../services/textChat.js';
import { uploadImage, buildImageUrl } from '../../services/imageStore.js';
import { setSetting, SETTING_KEYS } from '../../services/appSettings.js';
import { logger } from '../../utils/logger.js';
import { requireSuper } from './_shared.js';

export const modelsRouter = Router();

// ---------------------------------------------------------------
// 模型管理（文本 + 配图）—— **超管专属**
//
// 为什么不在小程序设置页里加：那一屏是给老师看的。加一个模型要填地址和 API key，
// 而「API key 只在服务端、任何情况不下发到小程序」是这个项目的铁律
// （CLAUDE.md）。让老师在手机上敲 key，等于把钥匙串挂在门上，
// 而且任何一个老师都能改所有人用的模型。老师那边连这张表存在都不知道。
// ---------------------------------------------------------------

/** key 一律遮住再下发。sk-abcd…wxyz 这种形状足够认出是哪一把，又拼不回原文 */
function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 12) return s ? '****' : '';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * 模型 options 的校验 —— create 和 update **两条路同一套**
 * （「两条路只守了一条」在配图 update 上真出过事，别重演）。
 *
 * 文本的两个开关按格式的 caps 拒：界面上置灰不算校验，请求是可以手发的 ——
 * 存一个「不支持却为 true」的开关，老师以为开了联网其实什么都没发生。
 */
function checkModelOptions(kind, format, options) {
  const o = options || {};
  if (kind === 'text') {
    const caps = TEXT_FORMATS[format]?.caps || { thinking: false, search: false };
    if (o.thinking && !caps.thinking) throw badRequest('这家的接口不支持思考模式');
    if (o.search && !caps.search) throw badRequest('这家的接口不支持联网');
  }
  for (const k of ['price_in_cents_per_mtok', 'price_out_cents_per_mtok',
    'price_per_call_cents', 'timeout_ms', 'max_retries']) {
    if (o[k] !== undefined && o[k] !== null && (!Number.isFinite(Number(o[k])) || Number(o[k]) < 0)) {
      throw badRequest('单价、超时、重试次数要是不小于 0 的数字');
    }
  }
}

/**
 * 🔴 最后一个启用的文本模型不许删、不许停用。
 *
 * 「没有可用的文本模型就不启动」（server.js）×「加模型的唯一入口是后台」= 死锁：
 * 删光了之后服务起不来，而救它的那个页面也跟着起不来。配图没有这条 ——
 * 没配图模型只是画不了图，服务照常。
 */
async function assertNotLastEnabledText(key, doing) {
  const others = await queryOne(
    `SELECT COUNT(*)::int AS n FROM ai_models WHERE kind = 'text' AND enabled AND key <> $1`,
    [key]
  );
  if (!others.n) throw badRequest(`这是最后一个启用的文本模型，不能${doing}。先启用或新增另一个文本模型`);
}

modelsRouter.get('/models', requireSuper, asyncRoute(async (req, res) => {
  const [imageAll, textAll] = await Promise.all([
    listModels({ kind: 'image', includeDisabled: true }),
    listModels({ kind: 'text', includeDisabled: true }),
  ]);
  const shape = (m) => ({
    key: m.key,
    kind: m.kind,
    name_cn: m.name_cn,
    hint: m.hint,
    format: m.format,
    // 「识别为哪一家」那一列显示的中文名。格式是从地址推断的，
    // 认错了只有这一列看得出来（表现是开关变灰、或者参数发出去对方不认，都不报错）
    format_cn: (m.kind === 'text' ? TEXT_FORMATS[m.format]?.cn : IMAGE_FORMATS[m.format]?.cn) || m.format,
    // 这个格式支不支持思考 / 联网。表单里那两个开关按它置灰 ——
    // 前端不再自己维护一份格式表（那是两份，迟早对不上）
    caps: (m.kind === 'text' ? TEXT_FORMATS[m.format]?.caps : null) || { thinking: false, search: false },
    // `builtin` 播种之后**恒为 false**，字段留着只是给「播种之前那一瞬」用
    builtin: Boolean(m.builtin),
    enabled: m.enabled,
    sort_order: m.sort_order,
    model: m.account?.model || '',
    // 🔴 地址照实回，文本模型也一样 —— 回空串的话编辑表单那一格是空的，
    // 保存一下就把地址清空了（08-22 在配图上真发生过，全程不报错）
    base_url: m.account?.baseURL || '',
    api_key_masked: maskKey(m.account?.apiKey),
    // options 里没有密钥（开关 / 单价 / 超时这类旋钮），可以原样回
    options: m.options || m.seed_options || {},
  });
  return ok(res, {
    items: [...textAll.map(shape), ...imageAll.map(shape)],
    /* formats 仍然下发，但**界面上不再有「接口格式」那个下拉**（2026-08-23）——
       格式从地址推断（见 guessFormat）。留着这份清单是给两件事用的：
       ① 列表里那一列显示「认成了哪家」，认错了看得出来；
       ② 新增表单里那句「按地址自动识别」旁边要能说出识别得出哪几家。 */
    formats: {
      text: Object.entries(TEXT_FORMATS).map(([k, v]) => ({ key: k, cn: v.cn, hint: v.hint, caps: v.caps })),
      image: Object.entries(IMAGE_FORMATS).map(([k, v]) => ({ key: k, cn: v.cn, hint: v.hint })),
    },
    // 显示的默认直接问 pickModel —— 它才是业务真正用的那一个。
    // 自己再读一遍 setting 拼取值顺序，等于同一条规则写两份：
    // app_settings 里躺一个空串行（回归还原会留下）时，两份就对不上了
    defaults: {
      text: (await pickModel('text'))?.key || '',
      image: (await pickModel('image'))?.key || '',
    },
  });
}));

/**
 * 加一个模型。
 *
 * 🔴 表单只有**三样东西**：接口地址、API key、模型 id（2026-08-23 用户定：
 * 「新增部分只需要提供接口地址，api，模型id 就好……接口模式应该也是不需要的」）。
 * 其余全部由后端定：
 *   · `format` 从地址推断（`guessFormat`）—— 地址里已经写着是哪家了
 *   · `key` 从模型 id 派生（`deriveKey`）—— 它是内部标识，让人取名只是多一个字段要想
 *   · `name_cn` 就用模型 id（那一列 NOT NULL），列表里显示的也是模型 id
 *   · `enabled` / `sort_order` 走默认值
 * 单价（文本两档、配图按次/按 token）在 options 里，可以留空。
 */
modelsRouter.post('/models', requireSuper, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '').trim();
  if (kind !== 'text' && kind !== 'image') throw badRequest('kind 只能是 text 或 image');
  const baseUrl = String(b.base_url || '').trim();
  const modelId = String(b.model || '').trim();
  if (!baseUrl.startsWith('http')) throw badRequest('接口地址要以 http 开头');
  if (!String(b.api_key || '').trim()) throw badRequest('填一下 API key');
  if (!modelId) throw badRequest('填一下模型 id（可以点「获取列表」从服务商那边取）');
  if (modelId.length > 80) throw badRequest('模型 id 太长了');

  const format = guessFormat(kind, baseUrl, modelId);
  checkModelOptions(kind, format, b.options);

  // key 跨 kind 全局唯一（两类共用 provider 那个命名空间），所以派生时要避开**全部**已用的
  const taken = (await query(`SELECT key FROM ai_models`)).rows.map((r) => r.key);
  const key = deriveKey(modelId, taken);

  const row = await queryOne(
    `INSERT INTO ai_models (key, kind, name_cn, hint, format, base_url, api_key, model, options, enabled, sort_order)
     VALUES ($1,$2,$3,'',$4,$5,$6,$7,$8::jsonb,true,100) RETURNING id, key`,
    [
      key,
      kind,
      modelId.slice(0, 40),
      format,
      baseUrl,
      String(b.api_key).trim(),
      modelId,
      JSON.stringify(b.options || {}),
    ]
  );
  // detail 里**不放 key**。审计表是给人翻的，密钥进去就等于多一个明文副本
  await logAction({
    adminId: req.adminId, action: 'create_model',
    target: `model:${key}`, detail: { kind, format, model: modelId },
  });
  logger.info('model_created', { by: req.adminId, key, kind, format });
  return ok(res, { id: row.id, key: row.key, format });
}));

modelsRouter.post('/models/:key/update', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const b = req.body || {};
  // .env 里的模型启动时就被播种进这张表了（见 modelRegistry.js 文件头），
  // 所以这里不再有「内置模型改不了」这回事 —— 每个模型都是库里的一行。
  // kind 不许改（换类型等于换一个模型）；format 跟着地址走，见下
  const cur = await queryOne(`SELECT * FROM ai_models WHERE key = $1`, [key]);
  if (!cur) throw notFound('没有这个模型');

  // api_key 留空 = 不改。否则每次改个名字都要把密钥重新敲一遍，
  // 而界面上显示的是遮住的那串，敲回去只会把 sk-abcd…wxyz 存成真 key
  const nextKey = String(b.api_key || '').trim();

  /* 🔴 **接口地址和模型名不许被改成空**（2026-08-22 修，真出事了才加的）。
     create 校验了这两项，而 update 曾经**一直没校验** ——
     典型的「两条路只有一条守着」。
     出事经过：那时列表接口对内置模型一律回 `base_url: ''`，
     于是编辑表单里那一格是空的；用户打开 gpt 和 minimax 各按了一次保存，
     空串就写进库了 —— **两个模型从此画不出图，而全程没有任何报错**。
     （地址回空串那个毛病同一轮已经修掉，但校验这道也得有：
      下一次让它变空的可能是别的原因。） */
  const nextBase = String(b.base_url ?? cur.base_url).trim();
  const nextModel = String(b.model ?? cur.model).trim();
  if (!nextBase.startsWith('http')) throw badRequest('接口地址要以 http 开头，不能留空');
  if (!nextModel) throw badRequest('模型 id 不能留空');

  /* `format` 跟着模型 id 和地址重新推断（2026-08-23）。
     以前它是人在下拉里选的、且不许改；现在没有那个下拉了。
     锁着旧格式会出现「模型 id 换成了 deepseek、格式还是 glm」这种
     发出去对方不认、而且不报错的状态。

     🔴 **认不出来（退到通用档）时保持原格式，不覆盖。**
     `nanobanana` 那一行就是这个情况：它是 gemini 原生格式，但走 12ai 中转，
     模型 id 改动一下就可能认不出来 —— 那时候把它降级成通用档，
     配图立刻画不出来而且不报错（跟 08-22 那次「保存一下地址清空了」同一类事故）。
     认出明确一家才覆盖，是「宁可不动，也不要动错」。 */
  const guessed = guessFormat(cur.kind, nextBase, nextModel);
  const generic = cur.kind === 'text' ? 'openai_chat' : 'openai_images';
  const nextFormat = (guessed === generic && cur.format) ? cur.format : guessed;
  const nextOptions = b.options ?? cur.options ?? {};
  checkModelOptions(cur.kind, nextFormat, nextOptions);
  if (cur.kind === 'text' && b.enabled === false && cur.enabled) {
    await assertNotLastEnabledText(key, '停用');
  }

  const row = await queryOne(
    `UPDATE ai_models
        SET name_cn = $2, format = $3, base_url = $4, model = $5,
            options = $6::jsonb, enabled = $7,
            api_key = COALESCE(NULLIF($8, ''), api_key), updated_at = now()
      WHERE key = $1 RETURNING key, enabled, format`,
    [
      key,
      // 名称跟着模型 id 走（表单里不再有「名称」这一格）。老行原来那个名字
      // （「DeepSeek」「GPT 出图」）只在没改过模型 id 时保留下来
      (b.model !== undefined ? nextModel : String(cur.name_cn || nextModel)).slice(0, 40),
      nextFormat,
      nextBase,
      nextModel,
      JSON.stringify(nextOptions),
      b.enabled === undefined ? cur.enabled : Boolean(b.enabled),
      nextKey,
    ]
  );
  await logAction({
    adminId: req.adminId, action: 'update_model',
    target: `model:${key}`, detail: { kind: cur.kind, enabled: row.enabled, key_changed: Boolean(nextKey) },
  });
  return ok(res, { key: row.key, enabled: row.enabled, format: row.format });
}));

modelsRouter.post('/models/:key/delete', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const cur = await queryOne(`SELECT key, kind, enabled FROM ai_models WHERE key = $1`, [key]);
  if (!cur) throw notFound('没有这个模型');
  // 删一个启用着的文本模型之前，先确认它不是最后一个（红线，见 assertNotLastEnabledText）
  if (cur.kind === 'text' && cur.enabled) await assertNotLastEnabledText(key, '删除');
  // 2026-08-22 起**每个模型都删得掉**（用户定：「不要写死在 .env 中，
  // 应该是可以删除或者编辑的」）。.env 里的启动时已经播种进这张表，
  // 而播种只发生一次 —— 所以删掉之后不会在下次重启时自己回来
  await query(`DELETE FROM ai_models WHERE key = $1`, [key]);
  // 已经用它画出来的图、记下的账不动 —— provider 只是一条历史记录，
  // 删模型不该让老师的图消失、不该让账目断链
  await logAction({
    adminId: req.adminId, action: 'delete_model',
    target: `model:${key}`, detail: { kind: cur.kind },
  });
  logger.info('model_deleted', { by: req.adminId, key, kind: cur.kind });
  return ok(res, { deleted: true });
}));

/**
 * 测试。加完一个模型最想知道的就是「它到底通不通」，
 * 而不是回到小程序、开一份教案、等一分钟才发现地址填错了。
 * 配图试画一张；文本发一条极小消息，回耗时和回复片段。
 */
modelsRouter.post('/models/:key/test', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const all = [
    ...(await listModels({ kind: 'text', includeDisabled: true })),
    ...(await listModels({ kind: 'image', includeDisabled: true })),
  ];
  const model = all.find((m) => m.key === key);
  if (!model) throw notFound('没有这个模型');
  const t = Date.now();

  if (model.kind === 'text') {
    /* maxTokens 给到 512，**不能给 50**：开了思考模式的模型推理 token 计入输出，
       给小了正文还没开始就被截断，空回复会被误报成「连不通」。 */
    const r = await textModelChat({
      system: '你是幼儿园教研助手。回答要简短。',
      messages: [{ role: 'user', content: '用一句话说明「浮与沉」小实验适合哪个年龄班。' }],
      maxTokens: 512,
      purpose: 'admin_model_test',
      modelKey: key,
      // 测试就是要按这个模型的真实配置打一次 —— 开了思考就带思考测
      applyToggles: true,
    });
    await logAction({ adminId: req.adminId, action: 'test_model', target: `model:${key}`, detail: { kind: 'text' } });
    return ok(res, {
      ok: true,
      ms: Date.now() - t,
      reply: r.text.slice(0, 200),
      token_in: r.tokenIn,
      token_out: r.tokenOut,
    });
  }

  const prompt =
    String(req.body?.prompt || '').trim() ||
    'Black and white line drawing on pure white paper, thick solid black outlines. ' +
      'An empty printable chart: one plain table, 3 columns and 4 rows, every cell empty. ' +
      'Absolutely no text of any kind.';
  const img = await generateWith(model, { prompt, width: 1536, height: 2048, optimize: false });
  const { objectKey } = await uploadImage({ buffer: img.buffer, ext: img.ext || 'jpg' });
  await logAction({ adminId: req.adminId, action: 'test_model', target: `model:${key}`, detail: { kind: 'image' } });
  return ok(res, {
    ok: true,
    ms: Date.now() - t,
    width: img.width,
    height: img.height,
    bytes: img.bytes,
    url: buildImageUrl(objectKey),
  });
}));

/**
 * 设为默认 —— 按这一行的 kind 写对应的键：文本写 text_provider，配图写 image_provider。
 *
 * 存进 app_settings 而不是改 .env：改完**立刻生效，不用重启**。
 * 这个选择要经常改（哪家把记录表画对了、哪家快、哪家便宜，都是试出来的），
 * 锁在服务器文件里等于锁给会 ssh 的人。
 */
modelsRouter.post('/models/:key/default', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const enabled = [
    ...(await listModels({ kind: 'text' })),
    ...(await listModels({ kind: 'image' })),
  ];
  const model = enabled.find((m) => m.key === key);
  // 只能把**启用着且配好了**的设成默认。设一个停用的等于让所有老师立刻用不了
  if (!model) throw badRequest('这个模型不存在，或者已停用 / 没配好，不能设成默认');

  const settingKey = model.kind === 'text' ? SETTING_KEYS.textProvider : SETTING_KEYS.imageProvider;
  await setSetting(settingKey, key, req.adminId);
  await logAction({
    adminId: req.adminId, action: 'set_default_model',
    target: `model:${key}`, detail: { kind: model.kind },
  });
  logger.info('default_model_changed', { by: req.adminId, key, kind: model.kind });
  return ok(res, { kind: model.kind, default_provider: key });
}));

/**
 * 向服务商要模型清单（2026-08-23 用户提「应该允许获取模型列表，例如 deepseek
 * 还有 pro 跟 flash」）—— 填模型名不用去翻文档抄，取回来从列表里挑。
 *
 * 走 OpenAI 兼容的 `GET {base}/models`：deepseek / glm / qwen / openai_chat /
 * openai_images 都是这个形状。gemini 和 minimax 没有标准清单接口，直接报错让人手填 ——
 * 做一个「有时灵有时不灵」的按钮比不做更糟。
 *
 * 编辑已有模型时表单里的 api_key 恒为空（「留空 = 不改」那条规矩），
 * 所以带上 `key`，地址和密钥缺哪样就用库里那样。**清单原样回，不落库不记日志**：
 * 这是一次只读探测，连对方有哪些模型都算不上我们的数据。
 */
modelsRouter.post('/models/remote-list', requireSuper, asyncRoute(async (req, res) => {
  const b = req.body || {};
  let baseURL = String(b.base_url || '').trim();
  let apiKey = String(b.api_key || '').trim();
  if (b.key && (!apiKey || !baseURL)) {
    const cur = await queryOne(
      `SELECT base_url, api_key FROM ai_models WHERE key = $1`,
      [String(b.key).toLowerCase()]
    );
    if (cur) {
      baseURL = baseURL || cur.base_url;
      apiKey = apiKey || cur.api_key;
    }
  }
  if (!baseURL.startsWith('http')) throw badRequest('先填接口地址');
  if (!apiKey) throw badRequest('先填 API key');
  // 认出这是哪家（表单里已经没有「接口格式」那个下拉了）。
  // gemini 原生和 minimax 没有标准清单接口 —— 明确说出来，别让人等一个 404。
  // 这里只有地址可用（模型 id 正是要去取回来的东西）
  const kind = b.kind === 'image' ? 'image' : 'text';
  const format = guessFormat(kind, baseURL);
  if (format === 'gemini' || format === 'minimax') {
    throw badRequest('这一家没有标准的模型清单接口，模型 id 要手填');
  }

  let r;
  try {
    r = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw badRequest(`连不上对方接口：${String(err?.message || err).slice(0, 120)}`);
  }
  if (!r.ok) throw badRequest(`对方接口回了 ${r.status}，检查接口地址和 API key`);
  const j = await r.json().catch(() => null);
  // OpenAI 兼容的清单是 { data: [{ id }] }；有些家用 models / name，一并兜住
  const ids = [...new Set((j?.data || j?.models || [])
    .map((m) => (typeof m === 'string' ? m : m?.id || m?.model || m?.name))
    .filter(Boolean))];
  if (!ids.length) throw badRequest('对方返回里没有模型清单，只能手填模型名');
  return ok(res, { models: ids.sort() });
}));
