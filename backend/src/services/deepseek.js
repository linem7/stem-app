/**
 * DeepSeek 文本模型适配器。
 *
 * 用官方 openai 包换 baseURL 接入（ADR-001）：DeepSeek 的 API 是 OpenAI 兼容格式，
 * 这样做的好处是日后想换成别的兼容厂商（月之暗面、通义、甚至自建 vLLM），
 * 改的只是 .env 里的两行，代码一行不用动。
 *
 * 这一层只干四件事：调用、超时、重试、把失败翻译成 api-spec 的错误码。
 * 业务逻辑（提示词、字段校验）不放这里。
 */
import OpenAI from 'openai';
import { config } from '../config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger, startTimer } from '../utils/logger.js';
import { recordModelCall } from './costLedger.js';

/**
 * 客户端是**懒加载**的，不在模块顶层 new。
 *
 * 原因很实际：ESM 的 import 会在 server.js 的第一行代码之前就执行完，
 * 而 OpenAI 的构造函数在 apiKey 为空时会直接抛错。如果在这里 new，
 * 「没配 key 就启动」得到的会是一段英文栈，而不是 config.js 精心写的中文提示。
 * 启动自检必须先跑完，这是那个体验的前提。
 */
let client = null;
function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: config.deepseek.apiKey,
      baseURL: config.deepseek.baseURL,
      // 我们自己做重试（要按错误类型区分），所以把 SDK 内置的重试关掉，
      // 否则两层重试叠加，一次超时最多可能等好几分钟。
      maxRetries: 0,
      timeout: config.deepseek.timeoutMs,
    });
  }
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 哪些错误值得重试：网络抖动、限流、服务端 5xx、超时。
 * 参数错误（400）、鉴权失败（401）、余额不足（402）重试多少次都是一样的结果，
 * 立刻失败反而能让老师早点看到"再试一次"的提示。
 */
function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (status >= 500) return true;
  if (!status) return true; // 没有 status 一般是连接层错误/超时
  return false;
}

function classify(err) {
  const status = err?.status ?? err?.response?.status;
  const isTimeout =
    err?.name === 'APIConnectionTimeoutError' ||
    err?.code === 'ETIMEDOUT' ||
    /timeout/i.test(String(err?.message));

  if (isTimeout) return ErrorCode.MODEL_TIMEOUT;
  if (status === 401 || status === 403) {
    return ErrorCode.INTERNAL; // key 配错了是我们的问题，不该让老师看到"换个说法再试试"
  }
  if (status === 402) return ErrorCode.INTERNAL; // 余额不足，同上
  return ErrorCode.MODEL_FAILED;
}

/**
 * 调一次对话补全。
 *
 * @param {object} o
 * @param {string} o.system            system prompt
 * @param {Array}  o.messages          [{role:'user'|'assistant', content}]
 * @param {boolean}[o.json]            是否要求返回 JSON（DeepSeek 支持 response_format json_object）
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {number} [o.timeoutMs]       覆盖默认超时（生成整份教案要放宽）
 * @param {string} [o.purpose]         标明这次调用是干嘛的：进日志，也进 model_calls
 * @param {number} [o.teacherId]       为谁调的。落进 model_calls，用来算「哪个园花了多少」
 * @returns {Promise<{text:string, tokenIn:number, tokenOut:number, model:string}>}
 */
export async function chat({
  system,
  messages,
  json = false,
  temperature = 0.7,
  maxTokens = 2048,
  timeoutMs,
  purpose = 'unknown',
  teacherId = null,
}) {
  const maxAttempts = config.deepseek.maxRetries + 1;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const t = startTimer();
    try {
      const res = await getClient().chat.completions.create(
        {
          model: config.deepseek.model,
          messages: [{ role: 'system', content: system }, ...messages],
          temperature,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
        },
        { timeout: timeoutMs ?? config.deepseek.timeoutMs }
      );

      const text = res.choices?.[0]?.message?.content ?? '';
      const usage = res.usage || {};

      // 日志只记 id/耗时/token/用途，绝不记提示词或返回正文（api-spec 第 10 节）
      logger.info('model_call', {
        provider: 'deepseek',
        model: config.deepseek.model,
        purpose,
        attempt,
        ms: t(),
        token_in: usage.prompt_tokens,
        token_out: usage.completion_tokens,
        finish_reason: res.choices?.[0]?.finish_reason,
      });

      /**
       * 落一笔账。**记在这里，一处覆盖全部调用点**（目前 7 处：引导出题、
       * 每题的一句回应、生成教案、自检、改稿追问、配图提示词、记忆提取）。
       *
       * 在这之前 token 数只进了日志，库里一行都没有 —— 于是「这个月花了多少钱」
       * 只能算配图那一半，而生成教案恰恰是最贵的那次调用。
       *
       * 挂在每个调用点上就一定会漏掉下一个新加的。故意不 await：
       * 记账是旁路，不该让老师多等一次数据库往返（函数内部自己吞异常）。
       */
      recordModelCall({
        teacherId,
        purpose,
        provider: 'deepseek',
        model: config.deepseek.model,
        tokenIn: usage.prompt_tokens ?? null,
        tokenOut: usage.completion_tokens ?? null,
      });

      if (!text.trim()) {
        throw new AppError(ErrorCode.MODEL_FAILED, { detail: { reason: 'empty_completion' } });
      }

      return {
        text,
        tokenIn: usage.prompt_tokens ?? null,
        tokenOut: usage.completion_tokens ?? null,
        model: config.deepseek.model,
      };
    } catch (err) {
      lastErr = err;
      const retryable = !(err instanceof AppError) && isRetryable(err);
      logger.warn('model_call_failed', {
        provider: 'deepseek',
        purpose,
        attempt,
        ms: t(),
        status: err?.status ?? err?.response?.status,
        message: String(err?.message).slice(0, 200),
        will_retry: retryable && attempt < maxAttempts,
      });

      if (!retryable || attempt >= maxAttempts) break;
      // 指数退避 + 抖动：1s、2s…… 抖动是为了避免多个任务同时重试再次撞上限流
      await sleep(1000 * 2 ** (attempt - 1) + Math.random() * 300);
    }
  }

  if (lastErr instanceof AppError) throw lastErr;
  throw new AppError(classify(lastErr), {
    detail: { provider: 'deepseek', purpose, status: lastErr?.status },
    cause: lastErr,
  });
}

/**
 * 要 JSON 的调用。
 *
 * 为什么还要自己兜一层解析：即使开了 json_object，模型偶尔仍会把 JSON 包在 ```json 里，
 * 或在前面加一句"好的，以下是…"。这里做最常见的两种清洗，实在解析不出来才报错。
 */
export async function chatJSON(opts) {
  const res = await chat({ ...opts, json: true });
  const parsed = tryParseJSON(res.text);
  if (parsed === null) {
    logger.warn('model_json_parse_failed', { purpose: opts.purpose, text_len: res.text.length });
    throw new AppError(ErrorCode.MODEL_FAILED, { detail: { reason: 'json_parse_failed' } });
  }
  return { ...res, data: parsed };
}

export function tryParseJSON(text) {
  if (!text) return null;
  const candidates = [];
  candidates.push(text.trim());

  // ```json ... ``` 或 ``` ... ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) candidates.push(fence[1].trim());

  // 掐头去尾取第一个 { 到最后一个 }（对付前后有寒暄的情况）
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}
