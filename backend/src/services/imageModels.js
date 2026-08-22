/**
 * 配图模型注册表 —— 内置两家（来自 .env）+ 后台自己加的（来自 image_models 表）。
 *
 * 为什么要能自己加：出图这块换得很勤（豆包 → MiniMax → gpt-image-2 → nanobanana），
 * 而换家的判断标准很朴素——「哪家把记录表的格子画对了」「哪家快」「哪家便宜」，
 * 是试出来的。每试一家就改代码、重启、发版，太慢，也把决定权锁在了会写代码的人手里。
 *
 * 🔴 **.env 里那两家在启动时一次性播种进 image_models 表，之后就不再读 .env 了**
 * （2026-08-22 用户定：「不要写死在 .env 中，应该是可以删除或者编辑的」）。
 *
 * 为什么必须彻底搬过去、不能「用到才抄」：只要还会读 .env，
 * 在后台**删掉的模型下次重启就会自己回来** —— 而「删了它还在」
 * 比不给删除按钮更让人困惑。
 *
 * 播种只发生一次，靠 app_settings 里 `env_models_seeded` 这个标记记住。
 * 代价写在这里：**播种之后改 .env 不再生效**，改模型一律走后台。
 * 那正是用户要的 —— 锁在服务器文件里等于锁给会 ssh 的人。
 *
 * 播种之前（全新部署、迁移刚跑完）仍然退回 .env 那两家，
 * 否则第一次启动到播种完成之间配图是瘫的。
 */
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { getSetting, setSetting, SETTING_KEYS } from './appSettings.js';
import { generateImage as gptGenerate } from './gptImage.js';
import { generateImage as minimaxGenerate } from './minimax.js';
import { generateImage as geminiGenerate } from './geminiImage.js';
import { logger } from '../utils/logger.js';

/**
 * 三种请求格式。加同格式的新模型 = 填一行配置；
 * 只有冒出第四种格式时才需要写代码（在这里加一项）。
 */
export const FORMATS = {
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

export const isKnownFormat = (f) => Boolean(FORMATS[String(f || '')]);

/** .env 里那两家。**只在「还没播种」的时候用**，播种完就再也不读了（见文件头） */
function builtins() {
  const list = [];
  if (config.gptImage.configured) {
    list.push({
      key: 'gpt',
      name_cn: 'GPT 出图',
      hint: '表格线条准，记录表用这个',
      format: 'openai_images',
      builtin: true,
      enabled: true,
      sort_order: 10,
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
      name_cn: 'MiniMax 出图',
      hint: '插画更活泼',
      format: 'minimax',
      builtin: true,
      enabled: true,
      sort_order: 20,
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

/**
 * 自己加的那些。
 *
 * 这里带 key 的明文，**只能进出图那一步**，任何接口都不许把 account 原样回出去
 * （admin 里一律 mask，小程序那边连这张表存在都不知道）。
 */
async function customModels() {
  try {
    const rows = await query(
      `SELECT key, name_cn, hint, format, base_url, api_key, model, options, enabled, sort_order
         FROM image_models ORDER BY sort_order, id`
    );
    return rows.rows.map((r) => ({
      key: r.key,
      name_cn: r.name_cn,
      hint: r.hint,
      format: r.format,
      builtin: false,
      enabled: r.enabled,
      sort_order: r.sort_order,
      account: {
        baseURL: r.base_url,
        apiKey: r.api_key,
        model: r.model,
        ...(r.options || {}),
      },
    }));
  } catch (err) {
    // 表还没建（迁移没跑）时不该让配图整个瘫掉，内置那两家照常能用
    logger.warn('image_models_load_failed', { message: err.message });
    return [];
  }
}

/**
 * 把 .env 里那两家播种进 image_models 表 —— **一次，然后永不再读 .env**。
 *
 * 启动时调用（server.js）。已经播过就直接返回，所以重启多少次都只发生一次。
 *
 * 🔴 **`ON CONFLICT DO NOTHING`**：库里已经有同 key 的行（比如上一版
 * 「用到才抄」抄过去的、或者手动加的）就不动它 —— 那一行是人改过的，
 * 拿 .env 覆盖回去等于把他的修改静默还原。
 *
 * 🔴 **标记要在插完之后才写**：先写标记再插，中间挂掉就成了
 * 「标记说播过了，但库里什么都没有」—— 那时 listModels 返回空，配图整个瘫，
 * 而且不会自愈。
 */
export async function seedEnvModels() {
  if (await getSetting(SETTING_KEYS.envModelsSeeded, '')) return { seeded: false };
  const envs = builtins();
  const done = [];
  for (const m of envs) {
    try {
      await query(
        `INSERT INTO image_models
           (key, name_cn, hint, format, base_url, api_key, model, options, enabled, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,true,$8)
         ON CONFLICT (key) DO NOTHING`,
        [m.key, m.name_cn, m.hint || '', m.format,
          m.account?.baseURL || '', m.account?.apiKey || '', m.account?.model || '',
          m.sort_order || 100]
      );
      done.push(m.key);
    } catch (err) {
      // 表还没建（迁移没跑）——**不写标记**，下次启动再试
      logger.warn('image_model_seed_failed', { key: m.key, message: err.message });
      return { seeded: false, error: err.message };
    }
  }
  await setSetting(SETTING_KEYS.envModelsSeeded, '1');
  logger.info('image_models_seeded_from_env', { keys: done });
  return { seeded: true, keys: done };
}

/**
 * 全部模型，按 sort_order 排。带 account（含明文 key），**不要直接下发**。
 *
 * 播种完之后**只从库里读** —— 这是「内置模型也能删」的前提：
 * 只要还会读 .env，删掉的下次重启就会自己回来。
 *
 * 播种之前（全新部署、或者迁移刚跑完那一瞬）退回 .env 那两家，
 * 按 key 去重、库里的胜出 —— 不去重两份会同时在列表里，
 * 而 pickModel 取 find 的第一个，于是「改完了不生效」而界面上显示改过了。
 */
export async function listModels({ includeDisabled = false } = {}) {
  const custom = await customModels();
  const seeded = Boolean(await getSetting(SETTING_KEYS.envModelsSeeded, ''));
  const overridden = new Set(custom.map((m) => m.key));
  const all = (seeded ? custom : [...builtins().filter((b) => !overridden.has(b.key)), ...custom])
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
 * 把「GPT 出图 / MiniMax 出图」摊给老师选，她既没有判断依据，选错了还怪自己。
 * 所以这里正常情况下不接受调用方指定，`wanted` 只留给后台的「试一张」用。
 *
 * 默认取值顺序：后台设的（app_settings） > .env 的 IMAGE_PROVIDER > 列表第一个。
 * 认不出来、被停用、或那家没配好，一律往下退 —— 老师那边只会看到图没画出来，
 * 不该看到「模型选错了」这种她读不懂的话。
 */
export async function pickModel(wanted) {
  const list = await listModels();
  if (!list.length) return null;
  const want = String(wanted || '').trim();
  if (want) {
    const hit = list.find((m) => m.key === want);
    if (hit) return hit;
  }
  const configured = await getSetting(SETTING_KEYS.imageProvider, config.imageProvider);
  return list.find((m) => m.key === configured) || list[0];
}

/** 有没有任何一家能出图。没有就别往下走，白花一次 DeepSeek 翻译的钱 */
export async function anyModelReady() {
  return (await listModels()).length > 0;
}

/**
 * 出图。model 是 pickModel 的返回值。
 *
 * optimize 只有 MiniMax 认、quality 只有 OpenAI 那套认、imageSize 只有 Gemini 认，
 * 这里原样透传，各家自己取自己认识的 —— 在这里按格式分支，会随着模型变多变成一团。
 */
export async function generateWith(model, { prompt, width, height, optimize, quality }) {
  const impl = FORMATS[model.format];
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
  return { ...out, provider: model.key };
}
