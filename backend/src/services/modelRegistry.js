/**
 * 模型注册表 —— 文本模型和配图模型都在这里（ai_models 表，kind 分 text / image）。
 *
 * 为什么要能自己加：出图这块换得很勤（豆包 → MiniMax → gpt-image-2 → nanobanana），
 * 而换家的判断标准很朴素——「哪家把记录表的格子画对了」「哪家快」「哪家便宜」，
 * 是试出来的。每试一家就改代码、重启、发版，太慢，也把决定权锁在了会写代码的人手里。
 * 文本侧 2026-08-23 跟进：换 DeepSeek 以外的厂商、开思考模式，同样不该要求改代码。
 *
 * 🔴 **.env 里的模型在启动时一次性播种进 ai_models 表，之后就不再读 .env 了**
 * （2026-08-22 用户定：「不要写死在 .env 中，应该是可以删除或者编辑的」）。
 *
 * 为什么必须彻底搬过去、不能「用到才抄」：只要还会读 .env，
 * 在后台**删掉的模型下次重启就会自己回来** —— 而「删了它还在」
 * 比不给删除按钮更让人困惑。
 *
 * 播种只发生一次，配图和文本各有一个标记（配图 env_models_seeded 早就是 1 了，
 * 升级后文本要能照常首播，所以分开记）。
 * 代价写在这里：**播种之后改 .env 不再生效**，改模型一律走后台。
 * 那正是用户要的 —— 锁在服务器文件里等于锁给会 ssh 的人。
 *
 * 播种之前（全新部署、迁移刚跑完）仍然退回 .env，
 * 否则第一次启动到播种完成之间这一类模型是瘫的。
 */
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { getSetting, setSetting, SETTING_KEYS } from './appSettings.js';
import { generateImage as gptGenerate } from './gptImage.js';
import { generateImage as minimaxGenerate } from './minimax.js';
import { generateImage as geminiGenerate } from './geminiImage.js';
import { logger } from '../utils/logger.js';

/**
 * 配图的三种请求格式。加同格式的新模型 = 填一行配置；
 * 只有冒出新格式时才需要写代码（在这里加一项）。
 */
export const IMAGE_FORMATS = {
  openai_images: {
    cn: 'OpenAI 图片接口',
    hint: 'Bearer 鉴权，size 用「宽x高」。gpt-image-2、dall-e 这类',
    generate: gptGenerate,
  },
  gemini: {
    cn: 'Gemini 原生',
    hint: 'key 走 URL，尺寸用 aspectRatio + imageSize。nanobanana 这类',
    generate: geminiGenerate,
  },
  minimax: {
    cn: 'MiniMax',
    hint: 'Bearer 鉴权，自带提示词润色开关',
    generate: minimaxGenerate,
  },
};

/**
 * 文本的四种请求格式。都走 OpenAI 兼容的 chat/completions（官方 openai 包换 baseURL），
 * 区别只在「联网」「思考模式」两个开关怎么翻译成请求参数 —— 各家的方言不一样。
 *
 * caps 是界面置灰和服务端校验的共同依据：不支持的开关勾了也没有对应参数可发，
 * 与其静默忽略（老师以为开了联网其实没有），不如两头都拦住。
 *
 * buildToggleParams 只收「已经按 caps 过滤过」的布尔值，返回要合进请求体的片段。
 * versions-test 第 10 节对每一家都有纯函数断言钉着 —— 开关真实落参，不是标签。
 *
 * 🔴🔴 **关掉也必须显式发出去，不能「不发参数」**（2026-08-23 当天踩的，代价很大）。
 * DeepSeek V4 系列**思考模式默认打开、effort 默认 high**（官方
 * api-docs.deepseek.com/zh-cn/guides/thinking_mode 原话）。
 * 第一版写的是「开关开了才发 enabled，关了就什么都不发」——
 * 于是「关」等于走默认值，也就是**一直在最高档思考**：
 * 库里 options.thinking=false 的那几次生成，思考链实测 7185 / 7468 字符，
 * 一次生成 59 秒、输出 token 3969（思考 token 计入 completion_tokens）。
 * 而 08-22 之前不慢，是因为那时用的 `deepseek-chat` 别名**映射到非思考模式**，
 * 换成显式模型名之后默认值就翻了个面。
 * 「开关关着 = 不发参数」这种写法在**任何默认开启的能力**上都是同一个坑。
 *
 * 参数写法都是查过官方文档的，别凭感觉改：
 * - deepseek：`thinking:{"type":"enabled"|"disabled"}`。**联网在 chat 接口没有参数**
 *   （只在他家另一套 Responses API 里有内置搜索工具），所以 caps.search=false
 * - glm（智谱 open.bigmodel.cn/api/paas/v4）：`enable_thinking` 布尔（GLM-5 官方
 *   API 文档用的是这个名字，不是 DeepSeek 那种 thinking 对象）；
 *   联网走 tools:[{type:"web_search",web_search:{enable:true}}]
 * - qwen（通义 DashScope compatible-mode）：enable_thinking / enable_search，
 *   非标准参数但 Node SDK 顶层直传（官方示例就这么写）；非流式也可用
 * - openai_chat 是唯一「什么都不发」的：通用兼容端点不认识这些参数，
 *   发过去可能直接 400。所以它的 caps 全 false，两个开关在界面上是灰的
 */
export const TEXT_FORMATS = {
  deepseek: {
    cn: 'DeepSeek',
    hint: '官方 chat 接口。支持思考模式；联网他家 chat 接口没有',
    caps: { thinking: true, search: false },
    // 显式 enabled / disabled —— 不传等于默认开（见上面那段）
    buildToggleParams: ({ thinking }) => ({ thinking: { type: thinking ? 'enabled' : 'disabled' } }),
  },
  glm: {
    cn: '智谱 GLM',
    hint: 'open.bigmodel.cn 的 OpenAI 兼容端点。思考、联网都支持',
    caps: { thinking: true, search: true },
    buildToggleParams: ({ thinking, search }) => ({
      enable_thinking: Boolean(thinking),
      ...(search ? { tools: [{ type: 'web_search', web_search: { enable: true } }] } : {}),
    }),
  },
  qwen: {
    cn: '通义千问',
    hint: 'DashScope 兼容模式。思考、联网都支持',
    caps: { thinking: true, search: true },
    buildToggleParams: ({ thinking, search }) => ({
      enable_thinking: Boolean(thinking),
      ...(search ? { enable_search: true } : {}),
    }),
  },
  openai_chat: {
    cn: '通用 OpenAI 兼容',
    hint: '标准 chat/completions，没有联网和思考开关。月之暗面、自建 vLLM 这类',
    caps: { thinking: false, search: false },
    buildToggleParams: () => ({}),
  },
};

const FORMATS_BY_KIND = { image: IMAGE_FORMATS, text: TEXT_FORMATS };

export const isKnownFormat = (kind, f) => Boolean(FORMATS_BY_KIND[kind]?.[String(f || '')]);

/**
 * 认出这是哪家的接口格式（2026-08-23 用户定：表单里不再让人选「接口模式」）。
 *
 * 为什么能这么干：**模型 id 和地址已经说明了是哪家** —— 填 `api.deepseek.com`
 * 的人不可能想用智谱的参数。而让人在下拉里再选一次，是让他复述一遍已经写着的事，
 * 还多一个选错的机会。
 *
 * 🔴 **先看模型 id，再看地址。** 顺序反过来会把现成的配置认坏：
 * `nanobanana` 走的是 12ai 中转（地址 `cdn.12ai.org`）但用的是 **gemini 原生**
 * 形状（key 走 URL、尺寸用 aspectRatio）—— 而同一个中转下的 `gpt-image-2`
 * 是 openai_images。靠地址分不开这两个，靠模型 id 一眼就能分。
 *
 * 都认不出就退到该类的**通用档**（文本 `openai_chat`、配图 `openai_images`）：
 * 那两档是标准 OpenAI 兼容形状，多数中转和自建都是这个形状。
 * 代价写在这里：**认成通用档的文本模型没有思考/联网开关**（通用档 caps 全 false）——
 * 接了一家新厂商发现开关是灰的，就来这里加一条规则。
 * 这比「猜一个可能不对的格式」好：猜错了发出去的参数对方不认，而且不报错。
 */
const MODEL_RULES = [
  // 配图：模型 id 就写明了是谁家的模型，比地址准（走不走中转都一样）
  [/^(gemini|nanobanana|imagen)/i, 'image', 'gemini'],
  [/^(image-0|minimax)/i, 'image', 'minimax'],
  [/^(gpt-image|dall-e)/i, 'image', 'openai_images'],
  // 文本
  [/^deepseek/i, 'text', 'deepseek'],
  [/^glm/i, 'text', 'glm'],
  [/^(qwen|qwq|tongyi)/i, 'text', 'qwen'],
];

const HOST_RULES = [
  // 文本
  [/(^|\.)deepseek\.com$/i, 'text', 'deepseek'],
  [/bigmodel\.cn$/i, 'text', 'glm'],
  [/(^|\.)zhipuai\.cn$/i, 'text', 'glm'],
  [/aliyuncs\.com$/i, 'text', 'qwen'],
  [/dashscope/i, 'text', 'qwen'],
  // 配图
  [/googleapis\.com$/i, 'image', 'gemini'],
  [/minimax/i, 'image', 'minimax'],
];

export function guessFormat(kind, baseUrl, modelId) {
  const model = String(modelId || '').trim();
  if (model) {
    for (const [re, k, fmt] of MODEL_RULES) {
      if (k === kind && re.test(model)) return fmt;
    }
  }
  let host = '';
  try {
    host = new URL(String(baseUrl || '')).hostname;
  } catch {
    host = '';
  }
  if (host) {
    for (const [re, k, fmt] of HOST_RULES) {
      if (k === kind && re.test(host)) return fmt;
    }
  }
  return kind === 'text' ? 'openai_chat' : 'openai_images';
}

/**
 * 从模型 id 派生一个合法的代号（key）。
 *
 * key 进 `lesson_images.provider` 和 `model_calls.provider`，所以字符集限死、
 * 长度 ≤32。表单里不再让人填它（2026-08-23 用户定：只填地址 / key / 模型 id）——
 * 它是一个内部标识，让人取名只是多一个字段要想。
 *
 * 撞了就加后缀：**同一个模型 id 配两次是合理场景**（两个中转商、两把额度不同的 key），
 * 因为一个内部字段撞了就拒绝，是拿实现细节挡住真实用法。
 */
export function deriveKey(modelId, taken = []) {
  const base = String(modelId || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'model';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const suffixed = `${base.slice(0, 32 - String(i).length - 1)}-${i}`;
    if (!used.has(suffixed)) return suffixed;
  }
  return `${base.slice(0, 26)}-${Date.now() % 100000}`;
}

/** 每类各自的「设为默认」键和 .env 兜底值 */
const KIND_SETTINGS = {
  image: { settingKey: () => SETTING_KEYS.imageProvider, envDefault: () => config.imageProvider },
  text: { settingKey: () => SETTING_KEYS.textProvider, envDefault: () => config.textProvider },
};

const SEED_MARKERS = {
  image: () => SETTING_KEYS.envModelsSeeded,
  text: () => SETTING_KEYS.envTextModelsSeeded,
};

/** .env 里的模型。**只在「这一类还没播种」的时候用**，播种完就再也不读了（见文件头） */
function builtins(kind) {
  const list = [];
  if (kind === 'image') {
    if (config.gptImage.configured) {
      list.push({
        key: 'gpt',
        kind: 'image',
        name_cn: 'GPT 出图',
        hint: '表格线条准，记录表用这个',
        format: 'openai_images',
        builtin: true,
        enabled: true,
        sort_order: 10,
        seed_options: {},
        account: {
          baseURL: config.gptImage.baseURL,
          apiKey: config.gptImage.apiKey,
          model: config.gptImage.model,
          quality: config.gptImage.quality,
          timeoutMs: config.gptImage.timeoutMs,
        },
      });
    }
    if (config.minimax.configured) {
      list.push({
        key: 'minimax',
        kind: 'image',
        name_cn: 'MiniMax 出图',
        hint: '插画更活泼',
        format: 'minimax',
        builtin: true,
        enabled: true,
        sort_order: 20,
        seed_options: {},
        account: {
          baseURL: config.minimax.baseURL,
          apiKey: config.minimax.apiKey,
          model: config.minimax.model,
          timeoutMs: config.minimax.timeoutMs,
        },
      });
    }
    return list;
  }
  // 文本：.env 里只有 DeepSeek 一家。单价、超时、重试次数都进 options ——
  // 播种之后这些旋钮就归后台管了，跟 baseURL/model 一个待遇
  if (config.deepseek.apiKey) {
    const seedOptions = {
      timeout_ms: config.deepseek.timeoutMs,
      max_retries: config.deepseek.maxRetries,
      price_in_cents_per_mtok: config.deepseek.priceInPerMTok,
      price_out_cents_per_mtok: config.deepseek.priceOutPerMTok,
      thinking: false,
      search: false,
    };
    list.push({
      key: 'deepseek',
      kind: 'text',
      name_cn: 'DeepSeek',
      hint: '',
      format: 'deepseek',
      builtin: true,
      enabled: true,
      sort_order: 10,
      seed_options: seedOptions,
      account: {
        baseURL: config.deepseek.baseURL,
        apiKey: config.deepseek.apiKey,
        model: config.deepseek.model,
        ...seedOptions,
      },
    });
  }
  return list;
}

/**
 * 自己加的那些。
 *
 * 这里带 key 的明文，**只能进模型调用那一步**，任何接口都不许把 account 原样回出去
 * （admin 里一律 mask，小程序那边连这张表存在都不知道）。
 */
async function customModels(kind) {
  try {
    const rows = await query(
      `SELECT key, kind, name_cn, hint, format, base_url, api_key, model, options, enabled, sort_order
         FROM ai_models WHERE kind = $1 ORDER BY sort_order, id`,
      [kind]
    );
    return rows.rows.map((r) => ({
      key: r.key,
      kind: r.kind,
      name_cn: r.name_cn,
      hint: r.hint,
      format: r.format,
      builtin: false,
      enabled: r.enabled,
      sort_order: r.sort_order,
      options: r.options || {},
      account: {
        baseURL: r.base_url,
        apiKey: r.api_key,
        model: r.model,
        ...(r.options || {}),
      },
    }));
  } catch (err) {
    // 表还没建 / 021 还没跑（kind 列不存在）时不该让业务整个瘫掉，
    // 内置的照常能用 —— 那正是「播种之前退回 .env」的同一条兜底
    logger.warn('ai_models_load_failed', { kind, message: err.message });
    return [];
  }
}

/**
 * 把 .env 里的模型播种进 ai_models 表 —— **一次，然后永不再读 .env**。
 *
 * 启动时调用（server.js）。已经播过就直接返回，所以重启多少次都只发生一次。
 * 配图和文本各自记一个标记：老库的配图标记早是 1 了，文本要能照常首播。
 *
 * 🔴 **`ON CONFLICT DO NOTHING`**：库里已经有同 key 的行（比如上一版
 * 「用到才抄」抄过去的、或者手动加的）就不动它 —— 那一行是人改过的，
 * 拿 .env 覆盖回去等于把他的修改静默还原。
 *
 * 🔴 **标记要在插完之后才写**：先写标记再插，中间挂掉就成了
 * 「标记说播过了，但库里什么都没有」—— 那时 listModels 返回空，这一类整个瘫，
 * 而且不会自愈。
 */
async function seedKind(kind) {
  const marker = SEED_MARKERS[kind]();
  if (await getSetting(marker, '')) return { seeded: false };
  const envs = builtins(kind);
  const done = [];
  for (const m of envs) {
    try {
      await query(
        `INSERT INTO ai_models
           (key, kind, name_cn, hint, format, base_url, api_key, model, options, enabled, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,true,$10)
         ON CONFLICT (key) DO NOTHING`,
        [m.key, kind, m.name_cn, m.hint || '', m.format,
          m.account?.baseURL || '', m.account?.apiKey || '', m.account?.model || '',
          JSON.stringify(m.seed_options || {}), m.sort_order || 100]
      );
      done.push(m.key);
    } catch (err) {
      // 表还没建 / 021 没跑 ——**不写标记**，下次启动再试
      logger.warn('ai_model_seed_failed', { kind, key: m.key, message: err.message });
      return { seeded: false, error: err.message };
    }
  }
  await setSetting(marker, '1');
  logger.info('ai_models_seeded_from_env', { kind, keys: done });
  return { seeded: true, keys: done };
}

export async function seedEnvModels() {
  return {
    image: await seedKind('image'),
    text: await seedKind('text'),
  };
}

/**
 * 某一类的全部模型，按 sort_order 排。带 account（含明文 key），**不要直接下发**。
 *
 * 播种完之后**只从库里读** —— 这是「内置模型也能删」的前提：
 * 只要还会读 .env，删掉的下次重启就会自己回来。
 *
 * 播种之前（全新部署、或者迁移刚跑完那一瞬）退回 .env，
 * 按 key 去重、库里的胜出 —— 不去重两份会同时在列表里，
 * 而 pickModel 取 find 的第一个，于是「改完了不生效」而界面上显示改过了。
 */
export async function listModels({ kind, includeDisabled = false } = {}) {
  if (!FORMATS_BY_KIND[kind]) throw new Error(`listModels 需要 kind（text|image），收到：${kind}`);
  const custom = await customModels(kind);
  const seeded = Boolean(await getSetting(SEED_MARKERS[kind](), ''));
  const overridden = new Set(custom.map((m) => m.key));
  const all = (seeded ? custom : [...builtins(kind).filter((b) => !overridden.has(b.key)), ...custom])
    .sort((a, b) => (a.sort_order || 100) - (b.sort_order || 100) || a.key.localeCompare(b.key));
  return includeDisabled ? all : all.filter((m) => m.enabled);
}

/** 给界面用的安全形状：没有 key、没有地址 */
export function publicShape(m) {
  return { key: m.key, name_cn: m.name_cn, hint: m.hint, builtin: Boolean(m.builtin) };
}

/**
 * 挑出这次要用的模型。
 *
 * **老师不选模型**（2026-08-18 定）—— 用哪家是我们的技术选型，
 * 摊给老师选，她既没有判断依据，选错了还怪自己。
 * 所以这里正常情况下不接受调用方指定，`wanted` 只留给后台的「测试」用。
 *
 * 默认取值顺序：后台设的（app_settings） > .env（IMAGE_PROVIDER / TEXT_PROVIDER） > 列表第一个。
 * 认不出来、被停用、或那家没配好，一律往下退 —— 老师那边只会看到功能没成，
 * 不该看到「模型选错了」这种她读不懂的话。
 */
export async function pickModel(kind, wanted) {
  const list = await listModels({ kind });
  if (!list.length) return null;
  const want = String(wanted || '').trim();
  if (want) {
    const hit = list.find((m) => m.key === want);
    if (hit) return hit;
  }
  const ks = KIND_SETTINGS[kind];
  const configured = await getSetting(ks.settingKey(), ks.envDefault());
  return list.find((m) => m.key === configured) || list[0];
}

/** 这一类有没有任何一家能用。配图没有只是画不了图；文本没有连教案都生成不了 */
export async function anyModelReady(kind) {
  return (await listModels({ kind })).length > 0;
}

/**
 * 出图。model 是 pickModel('image', ...) 的返回值。
 *
 * optimize 只有 MiniMax 认、quality 只有 OpenAI 那套认、imageSize 只有 Gemini 认，
 * 这里原样透传，各家自己取自己认识的 —— 在这里按格式分支，会随着模型变多变成一团。
 */
export async function generateWith(model, { prompt, width, height, optimize, quality }) {
  const impl = IMAGE_FORMATS[model.format];
  if (!impl) {
    throw new Error(`未知的配图格式：${model.format}`);
  }
  const out = await impl.generate({
    account: model.account,
    prompt,
    width,
    height,
    optimize,
    quality,
  });
  return { ...out, costCents: imageCostCents(model.account, out), provider: model.key };
}

/**
 * 一张图算多少钱。
 *
 * 后台可以填两种价（2026-08-23 用户定：「一种是按次（特别是来自中转的模型），
 * 一种是按百万 token」）—— 中转商多数按张报价，原厂多数按 token。
 *
 * 取值顺序：**按次价 > 按 token 价 > 适配器自己的估值**。
 * 最后那一档是三家写死在代码里的量级值（minimax/gemini 各 3 分、gpt 按 token 粗估），
 * 它们**故意不返回 0** —— 0 会让成本统计看起来像免费的，比估不准更糟。
 * 所以「没填单价」不等于「不记账」，只是那个数是估的。
 */
function imageCostCents(account, out) {
  const perCall = Number(account?.price_per_call_cents);
  if (Number.isFinite(perCall) && perCall >= 0) return perCall;
  const perMTok = Number(account?.price_out_cents_per_mtok);
  const tokenOut = Number(out?.tokenOut);
  if (Number.isFinite(perMTok) && perMTok >= 0 && Number.isFinite(tokenOut) && tokenOut > 0) {
    // `lesson_images.cost_cents` 是整数分（跟文本那张表不同，一张图是分的量级不是 0.1 分）。
    // 算出来不到 1 分的记 1 —— 跟适配器「不返回 0」同一条纪律：
    // 0 会让成本统计看起来像免费的
    return Math.max(1, Math.round((tokenOut / 1e6) * perMTok));
  }
  return out?.costCents ?? null;
}
