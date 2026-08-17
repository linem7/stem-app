/**
 * 结构化日志。
 *
 * 硬约束（api-spec 第 10 节）：不记录完整对话正文，只记 id、耗时、token 数、错误码。
 * 所以这里没有「打印任意对象」的口子 —— 想记什么必须显式传字段名，
 * 并且下面的 SENSITIVE_KEYS 会把常见的正文字段直接替换成长度，防手滑。
 */
import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/**
 * 一旦出现这些 key，只记长度不记内容。
 * 名字是按本项目实际会流经日志的字段起的：老师输入、模型输出、题干、教案正文。
 */
const SENSITIVE_KEYS = new Set([
  'content',
  'content_md',
  'content_json',
  'seed_input',
  'custom_text',
  'fact',
  'prompt',
  'prompt_cn',
  'prompt_sent',
  'messages',
  'text',   // ⚠️ 撞名注意：任何叫 text 的字段都只记长度。记数量用 delta_text 这类名字
  'answer',
  'title',
]);

function scrub(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined) continue;
    if (SENSITIVE_KEYS.has(k)) {
      const len = typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length;
      out[`${k}_len`] = len; // 只留长度，够排查「是不是空的/是不是太长了」
      continue;
    }
    if (v instanceof Error) {
      out[k] = v.message;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function emit(level, event, fields) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    event, // 事件名用下划线短语，如 'model_call' 'conv_answer'，方便日后 grep
    ...scrub(fields),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};

/** 计时器：const t = startTimer(); ... logger.info('x', { ms: t() }) */
export function startTimer() {
  const t0 = process.hrtime.bigint();
  return () => Number((process.hrtime.bigint() - t0) / 1000000n);
}
