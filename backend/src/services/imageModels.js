/**
 * 配图模型注册表 —— 内置两家（来自 .env）+ 后台自己加的（来自 image_models 表）。
 *
 * 为什么要能自己加：出图这块换得很勤（豆包 → MiniMax → gpt-image-2 → nanobanana），
 * 而换家的判断标准很朴素——「哪家把记录表的格子画对了」「哪家快」「哪家便宜」，
 * 是试出来的。每试一家就改代码、重启、发版，太慢，也把决定权锁在了会写代码的人手里。
 *
 * 内置那两家**不搬进数据库**：它们的 key 现在好好地待在 .env 里，
 * 搬进去等于凭空多一份明文密钥，只为了统一形状。不值得。
 */
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { getSetting, SETTING_KEYS } from './appSettings.js';
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

/** 内置两家。key 与 .env 绑定，不能在后台删——删了老师会突然少两个选项 */
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

/** 全部模型，内置在前。带 account（含明文 key），**不要直接下发** */
export async function listModels({ includeDisabled = false } = {}) {
  const all = [...builtins(), ...(await customModels())];
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
