/**
 * 文本模型适配器 —— 原 deepseek.js（2026-08-23 改造）。
 *
 * 用官方 openai 包换 baseURL 接入（ADR-001）：四种文本格式全是 OpenAI 兼容的
 * chat/completions，区别只在「联网」「思考模式」怎么翻译成请求参数，
 * 那部分方言写在 modelRegistry.js 的 TEXT_FORMATS 里，这里按格式取用。
 *
 * 用哪个模型不再读 .env：pickModel('text') 从注册表拿（后台设的默认 > .env 兜底 > 第一个），
 * 后台「设为默认」改完立刻生效，不用重启。
 *
 * 这一层只干四件事：调用、超时、重试、把失败翻译成 api-spec 的错误码。
 * 业务逻辑（提示词、字段校验）不放这里。
 */
import OpenAI from 'openai';
import { config } from '../config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger, startTimer } from '../utils/logger.js';
import { recordModelCall } from './costLedger.js';
import { pickModel, listModels, TEXT_FORMATS } from './modelRegistry.js';

/**
 * 客户端按「地址|密钥」缓存 —— 不能再是单例，后台随时可能换默认模型。
 * 懒加载的理由跟原来一样：OpenAI 构造函数在 apiKey 为空时直接抛英文栈，
 * 而「配置不对」的提示该由启动自检用中文说。
 */
const clients = new Map();
function getClient(account) {
  const id = `${account.baseURL}|${account.apiKey}`;
  let c = clients.get(id);
  if (!c) {
    c = new OpenAI({
      apiKey: account.apiKey,
      baseURL: account.baseURL,
      // 我们自己做重试（要按错误类型区分），所以把 SDK 内置的重试关掉，
      // 否则两层重试叠加，一次超时最多可能等好几分钟。
      maxRetries: 0,
      timeout: account.timeout_ms || 60000,
    });
    clients.set(id, c);
  }
  return c;
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
 * @param {boolean}[o.json]            是否要求返回 JSON（response_format json_object）
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {number} [o.timeoutMs]       覆盖默认超时（生成整份教案要放宽）
 * @param {string} [o.purpose]         标明这次调用是干嘛的：进日志，也进 model_calls
 * @param {number} [o.teacherId]       为谁调的。落进 model_calls，用来算「哪个园花了多少」
 * @param {string} [o.modelKey]        指定用哪个模型。**只给后台的「模型测试」用**，业务调用不传
 * @param {boolean}[o.applyToggles]    这次调用是否吃模型上的「思考/联网」开关。默认 false —— 见下
 * @param {boolean}[o.retryOnTruncate] 输出被 max_tokens 截断时加倍预算重来一次。默认 false —— 见下
 * @returns {Promise<{text:string, reasoning:string|null, tokenIn:number, tokenOut:number, model:string}>}
 *   reasoning 只在该模型开了思考模式时非空 —— 是完整思考链路，别往日志里打
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
  modelKey,
  applyToggles = false,
  retryOnTruncate = false,
}) {
  /* modelKey 只有后台「模型测试」在传：必须**精确命中那一个**（含停用的），
     不许退回默认 —— 测试静默换了一家，「测试通过」就成了假话。
     业务调用不传 modelKey，走 pickModel 的正常取值顺序。 */
  const picked = modelKey
    ? (await listModels({ kind: 'text', includeDisabled: true })).find((m) => m.key === modelKey)
    : await pickModel('text');
  if (!picked) {
    // 启动检查 + 「最后一个文本模型不许删/停」两道闸都守着，走到这里说明库被绕过后台改了
    throw new AppError(ErrorCode.INTERNAL, { detail: { reason: 'no_text_model', wanted: modelKey } });
  }
  const account = picked.account;
  const fmt = TEXT_FORMATS[picked.format] || TEXT_FORMATS.openai_chat;

  /* 🔴 开关只作用于**声明了 applyToggles 的调用**（生成教案、教案解读、后台测试）。
     2026-08-23 真踩过：后台一开「思考模式」，整条链路全挂 ——
     思考 token 计入 max_tokens，「每题一句回应」只给 120 token，
     全被思考吃掉、正文为空；生成那次 4000 也被挤到截断，JSON 解析失败。
     管理员开思考的本意是「教案写得更好」，不是「每句寒暄都思考」——
     胶水调用（出题回应、自检、配图提示词翻译、记忆提取）跟着开只有慢和贵。
     新加的调用点默认拿不到开关，这是安全的那一边。

     另外只有该格式 caps 支持时才落参 —— 界面置灰 + 服务端校验之外的第三道保险：
     库里的行被手改出「不支持却为 true」时，这里不发不认识的参数出去 */
  const search = applyToggles && Boolean(account.search) && fmt.caps.search;
  /* thinkingActive 是 let：思考是**锦上添花，不许挡出稿**。
     实测思考链能吃掉几千 token，被截断时（finish_reason=length、正文为空或 JSON 断在半截）
     下一次尝试自动关掉思考重打 —— 老师必须拿到教案，思考没了只是这份少一段解读素材 */
  let thinkingActive = applyToggles && Boolean(account.thinking) && fmt.caps.thinking;

  const maxAttempts = (account.max_retries ?? config.deepseek.maxRetries ?? 2) + 1;
  let lastErr;
  /* 被截断时下一次尝试**加倍预算**（见循环末尾那个分支）。
     ⚠️ 封顶 16384：各家对 max_tokens 都有上限，超了是 400（参数错，不可重试）。
     DeepSeek 文档在不同页面给的数不一致（8192 / 更高），16384 是实测过 12192
     可行之后留的余量档 —— 别往上调，调了要重新实测。 */
  const OUTPUT_CAP = 16384;
  let budget = maxTokens;
  let bumped = false;   // 加倍只发生一次，见循环里那个分支

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const t = startTimer();
    const thinking = thinkingActive;
    /* 思考 token 计入 max_tokens（实测 DeepSeek：finish_reason=length、
       token_out 顶满、content 为空）。开了思考就给足余量 ——
       实测一次教案生成的思考链就有 ~4500 token，4096 不够，给 8192 */
    const effectiveMaxTokens = Math.min(thinking ? budget + 8192 : budget, OUTPUT_CAP);
    /* 🔴 开了思考就不发 response_format json_object：官方思考示例里 response_format
       全是 text，历史上 reasoner 明确不支持 JSON 模式。提示词里本来就要求 JSON
       并给了示例，解析靠 chatJSON 的 tryParseJSON 兜底 —— 已有机制，不是新赌注 */
    const wantJsonFormat = json && !thinking;
    try {
      const res = await getClient(account).chat.completions.create(
        {
          model: account.model,
          messages: [{ role: 'system', content: system }, ...messages],
          temperature,
          max_tokens: effectiveMaxTokens,
          ...(wantJsonFormat ? { response_format: { type: 'json_object' } } : {}),
          ...fmt.buildToggleParams({ thinking, search }),
        },
        { timeout: timeoutMs ?? account.timeout_ms ?? 60000 }
      );

      const msg = res.choices?.[0]?.message || {};
      const text = msg.content ?? '';
      // 思考模式下各家（DeepSeek / GLM / Qwen 兼容模式）都把思考链路放在
      // reasoning_content。没开思考就是 undefined —— 返回 null，调用方自己决定存不存
      const reasoning = typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()
        ? msg.reasoning_content
        : null;
      const usage = res.usage || {};

      // 日志只记 id/耗时/token/用途，绝不记提示词或返回正文（api-spec 第 10 节）
      logger.info('model_call', {
        provider: picked.key,
        model: account.model,
        purpose,
        attempt,
        ms: t(),
        thinking,
        search,
        token_in: usage.prompt_tokens,
        token_out: usage.completion_tokens,
        finish_reason: res.choices?.[0]?.finish_reason,
      });

      /**
       * 落一笔账。**记在这里，一处覆盖全部调用点**（目前 8 处：引导出题、
       * 每题的一句回应、生成教案、自检、教案解读、改稿追问、配图提示词、记忆提取）。
       *
       * 挂在每个调用点上就一定会漏掉下一个新加的。故意不 await：
       * 记账是旁路，不该让老师多等一次数据库往返（函数内部自己吞异常）。
       *
       * provider 记模型 key（跟 lesson_images.provider 同一套命名空间），
       * 单价从这个模型的 options 里带过去 —— 各家不同价，全局单价算出来的是错账。
       */
      recordModelCall({
        teacherId,
        purpose,
        provider: picked.key,
        model: account.model,
        tokenIn: usage.prompt_tokens ?? null,
        tokenOut: usage.completion_tokens ?? null,
        priceInPerMTok: account.price_in_cents_per_mtok,
        priceOutPerMTok: account.price_out_cents_per_mtok,
      });

      /* 思考把输出预算吃穿的两种样子：正文为空，或要 JSON 时断在半截
         （finish=length 时 JSON 必然不完整）。都发生在**钱已经花了**之后
         （上面 recordModelCall 记过账），所以这里降级重试而不是抛错 ——
         降级后这一单没有思考链，但教案出得来 */
      const finish = res.choices?.[0]?.finish_reason;
      if (thinking && (!text.trim() || (json && finish === 'length'))) {
        logger.warn('thinking_truncated_fallback', {
          provider: picked.key, purpose, attempt,
          reason: !text.trim() ? 'empty_content' : 'json_cut_by_length',
        });
        thinkingActive = false;
        lastErr = new AppError(ErrorCode.MODEL_FAILED, { detail: { reason: 'thinking_truncated' } });
        continue;
      }

      /* 🔴 要 JSON 而输出被 max_tokens 截断：**加倍预算重来一次**。
         `finish_reason=length` + JSON = 必然解析失败，重试同样的预算是白花钱。
         2026-08-23 真撞到：后台把模型换成 deepseek-v4-flash 之后，
         它写整份教案要 4000 以上的输出，而调用方给的正是 4000 ——
         每一次都顶到 3999 截断，而老师看到的是「再试一次通常就好」，
         再试一次也永远不好。**换模型不该让人去改代码里的一个数字。**

         🔴 **只重一次，而且只有明确要求的调用才重**（`retryOnTruncate`）。
         第一版是「加倍到封顶为止」，当天就看出问题：`lesson_self_check` 的预算
         800 对 v4-flash 不够，于是 800 → 1600 → 3200 连打三次全失败，
         **白等 46 秒、白花三次钱**，而自检本来就是 try/catch 的附加信息、
         失败一点都不影响老师拿到教案。
         有兜底的调用（每题回应有中性兜底句、自检和解读失败只记日志）不该
         为了一次可有可无的完整 JSON 让老师多等。 */
      if (json && finish === 'length' && retryOnTruncate && !bumped) {
        bumped = true;
        logger.warn('output_truncated_retry_bigger', {
          provider: picked.key, purpose, attempt, budget, next: Math.min(budget * 2, OUTPUT_CAP),
        });
        budget = Math.min(budget * 2, OUTPUT_CAP);
        lastErr = new AppError(ErrorCode.MODEL_FAILED, { detail: { reason: 'output_truncated' } });
        continue;
      }

      if (!text.trim()) {
        throw new AppError(ErrorCode.MODEL_FAILED, { detail: { reason: 'empty_completion' } });
      }

      return {
        text,
        reasoning,
        tokenIn: usage.prompt_tokens ?? null,
        tokenOut: usage.completion_tokens ?? null,
        model: account.model,
      };
    } catch (err) {
      lastErr = err;
      const retryable = !(err instanceof AppError) && isRetryable(err);
      logger.warn('model_call_failed', {
        provider: picked.key,
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
    detail: { provider: picked.key, purpose, status: lastErr?.status },
    cause: lastErr,
  });
}

/**
 * 要 JSON 的调用。
 *
 * 为什么还要自己兜一层解析：即使开了 json_object，模型偶尔仍会把 JSON 包在 ```json 里，
 * 或在前面加一句"好的，以下是…"。这里做最常见的两种清洗，实在解析不出来才报错。
 * 开了思考模式时 response_format 不发（见 chat 里的注释），这层兜底就是唯一的解析路。
 */
export async function chatJSON(opts) {
  const res = await chat({ ...opts, json: true });
  const parsed = tryParseJSON(res.text);
  if (parsed !== null) return { ...res, data: parsed };

  // 开着思考解析不出来时，关掉思考重打一次（思考模式下不能用 response_format，
  // 全靠提示词约束，偶尔会失守）。教案出得来比这一单带思考链重要
  if (opts.applyToggles) {
    logger.warn('model_json_parse_failed_retry_plain', { purpose: opts.purpose, text_len: res.text.length });
    const res2 = await chat({ ...opts, json: true, applyToggles: false });
    const parsed2 = tryParseJSON(res2.text);
    if (parsed2 !== null) return { ...res2, data: parsed2 };
  }

  logger.warn('model_json_parse_failed', { purpose: opts.purpose, text_len: res.text.length });
  throw new AppError(ErrorCode.MODEL_FAILED, { detail: { reason: 'json_parse_failed' } });
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
