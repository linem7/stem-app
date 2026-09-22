/**
 * 内容安全 —— 阿里云内容安全（Green）的 `TextModerationPlus`。
 *
 * 老师输入和 AI 输出都要过这里。**这不是可选项**：使用协议里对老师承诺过，
 * 而且它是「不存幼儿信息」之外另一条合规底线（见 operations.md）。
 *
 * 【替掉微信那一套】（2026-09-22）
 * 原来走 `services/wechat.js` 的 `msgSecCheck`，那是小程序时代的遗留 ——
 * 转 web 之后「微信审核要求」那条依据没了，而它还要求传 openid（web 端没有）。
 * 现在这个模块是唯一的内容安全入口，`wechat.js` 切换完就整个删掉。
 *
 * 【两个 service，跟两个调用点一一对应】
 *
 * | 调用点 | service | 单次上限 |
 * |---|---|---|
 * | 老师输入 | `llm_query_moderation` | **2000 字** |
 * | AI 输出（教案正文） | `llm_response_moderation` | **5000 字** |
 *
 * 🔴 **超长必须分段送审，不许静默截断。**
 * 截断 = 后半截没审，而它看起来跟审过完全一样。
 * 实测：3600 字送 `llm_query_moderation` 会被服务端拒
 * （`Code=400 · content is too long(>2,000)`），不会静默放过 —— 这一条是运气好。
 * 这里仍然自己分段，因为**依赖服务端替我们兜底不是设计**。
 * ⚠️ 一份教案改稿几版之后可能顶破 5000，所以要分。
 *
 * 【为什么不用官方 SDK】
 * `@alicloud/green20220302` 会拖进来 7 个以上的间接依赖
 * （openapi-core / gateway-pop / darabonba-typescript / httpx …），
 * 而这个项目后端一共 8 个直接依赖，为了一个 HTTP POST 不值。
 * POP 签名（HMAC-SHA1）用 Node 自带的 `crypto` 十几行就写完了，下面是手写的。
 * ⚠️ **签名是这套东西唯一容易写错的地方**，改的时候照下面 `sign()` 的路子来。
 *
 * 【接口事实（2026-09-22 用真 key 实测，不是照文档抄的）】
 * - 端点：`green-cip.{region}.aliyuncs.com`，**必须 POST**
 *   （GET 会回 `UnsupportedHTTPMethod`，那个报错跟权限无关）
 * - 版本：`2022-03-02`
 * - **业务错误也回 HTTP 200**：`Code` 在 body 里，不是 HTTP 状态码。
 *   所以「HTTP 通了」不等于「审过了」
 * - 参数要放在 **query string**，不是 body（POP 风格）
 *
 * 【响应的形状：过了和没过不一样，这是最容易写错的一处】
 *
 * 通过：`Data.Result = [{ Description: '未检测出风险', Label: 'nonLabel' }]`
 * 命中：`Data.Result = [{ RiskWords, Confidence: 100, Label: 'contraband_act',
 *                        Description: '疑似违禁行为', RiskPositions: [...] }]`
 *
 * 🔴 **没有 `suggest` 字段**（微信那套有 `pass`/`review`/`risky`）。
 * 判据只有一个：**`Label === 'nonLabel'` 才算过**，别的 Label 一律拦。
 * ⚠️ 别写成「有 RiskWords 才拦」—— 那是拿字段存在与否当判据，
 * 而 `nonLabel` 那条正着读反着读都像「没有风险」，很容易把逻辑写反。
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger, startTimer } from '../utils/logger.js';

/** 两个 service 的单次上限。**别把这两个数当装饰** —— 超了服务端直接拒。 */
const LIMITS = { query: 2000, response: 5000 };

/** 调用点 → service 名。stage 是本项目内部的叫法（见调用点），这里只负责映射。 */
function serviceFor(stage) {
  // 老师的输入（提问、改稿意见、反馈、档案、配图描述）
  if (stage === 'teacher_input' || stage === 'profile') return { name: 'llm_query_moderation', max: LIMITS.query };
  // AI 的输出（教案正文）
  if (stage === 'ai_output') return { name: 'llm_response_moderation', max: LIMITS.response };
  // 新的调用点忘了归类会走这里。**默认按最严的来**（老师输入那档），
  // 因为它上限更小、分段更密 —— 漏审的代价比多切几段大得多。
  logger.warn('content_safety_unknown_stage', { stage });
  return { name: 'llm_query_moderation', max: LIMITS.query };
}

// ---------------------------------------------------------------
// POP 签名（HMAC-SHA1）
// ---------------------------------------------------------------

/**
 * 阿里云 POP 的百分号编码规则 —— **跟 `encodeURIComponent` 有三处不一样**。
 * 照抄 `encodeURIComponent` 会得到 `SignatureDoesNotMatch`，
 * 而那个报错会把「服务端算的串」打出来，看起来像别的问题。三处：
 *   1. 空格编成 `%20`，不是 `+`
 *   2. 星号 `*` 要编成 `%2A`（`encodeURIComponent` 不编它）
 *   3. 波浪号 `~` **不编**（`encodeURIComponent` 在部分实现里会编）
 */
function pct(s) {
  return encodeURIComponent(String(s))
    .replace(/[!'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/**
 * 组装出带签名的完整 URL。
 *
 * 签名算法（POP 标准，别自己发明）：
 *   1. 参数按 **key 的字典序** 排序，拼成 `k=v&k=v`（都做 pct 编码）
 *   2. 待签串 = `POST` + `&` + `%2F`（就是 `/`）+ `&` + pct(第 1 步那串)
 *   3. HMAC-SHA1，**密钥是 `secret + '&'`**（最后那个 `&` 不能少），结果 base64
 *   4. `Signature` 也放进 query
 */
function signedUrl({ action, version, region, params }) {
  const all = {
    Action: action,
    Version: version,
    Format: 'JSON',
    AccessKeyId: config.contentSafety.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    // ⚠️ 必须是没有毫秒的 ISO8601，形如 2026-09-22T05:32:37Z
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: region,
    ...params,
  };
  const qs = Object.keys(all).sort().map((k) => `${pct(k)}=${pct(all[k])}`).join('&');
  const stringToSign = `POST&%2F&${pct(qs)}`;
  const sig = crypto
    .createHmac('sha1', `${config.contentSafety.accessKeySecret}&`)
    .update(stringToSign)
    .digest('base64');
  return `https://green-cip.${region}.aliyuncs.com/?${qs}&Signature=${pct(sig)}`;
}

// ---------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------

/**
 * 检查一段文本。
 *
 * @param {object} o
 * @param {string} o.content 待检文本
 * @param {string} [o.stage] `'teacher_input'` | `'ai_output'` | `'profile'`
 * @returns {Promise<{pass:boolean, suggest:string, label:string|null, detail?:object}>}
 */
export async function checkText({ content, stage = 'unknown' }) {
  if (!config.contentSafety.enabled) {
    // 关掉时明确记一条日志，免得上线后忘了开还以为在检查
    logger.debug('content_check_skipped', { stage });
    return { pass: true, suggest: 'skipped', label: null };
  }

  if (!config.contentSafety.configured) {
    logger.error('content_check_misconfigured', { stage });
    throw new AppError(ErrorCode.CONTENT_CHECK_UNAVAILABLE);
  }

  const text = String(content || '').trim();
  // 空文本不送审：服务端会回 `Code=400 · content is blank`，
  // 而那是正常输入（老师没填昵称之类），不该当成错误。
  if (!text) return { pass: true, suggest: 'pass', label: null };

  const { name, max } = serviceFor(stage);
  const chunks = splitByLength(text, max);
  const t = startTimer();

  try {
    for (let i = 0; i < chunks.length; i++) {
      const body = await post(name, chunks[i]);
      const r = interpret(body, stage, { ms: t(), chunk: i + 1, chunks: chunks.length });
      if (!r.pass) return r;
    }
    logger.info('content_check', { stage, service: name, ms: t(), suggest: 'pass', chunks: chunks.length });
    return { pass: true, suggest: 'pass', label: null };
  } catch (err) {
    // 不记录异常原文：供应商错误可能回显签名串或待审正文。
    logger.error('content_check_unavailable', { stage, service: name, ms: t(), type: err.name });
    throw new AppError(ErrorCode.CONTENT_CHECK_UNAVAILABLE);
  }
}

async function post(service, content) {
  const url = signedUrl({
    action: 'TextModerationPlus',
    version: '2022-03-02',
    region: config.contentSafety.region,
    params: { Service: service, ServiceParameters: JSON.stringify({ content }) },
  });
  // 🔴 必须 POST。GET 会回 `UnsupportedHTTPMethod` —— 那个报错跟权限无关，
  // 2026-09-01 被它误导过一次。
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('Moderation HTTP failure');
  return res.json();
}

/**
 * 把响应翻成 `{pass, suggest, label}`。
 *
 * 🔴 **业务错误也是 HTTP 200**，所以这里先看 `Code` 再看 `Data.Result`。
 */
function interpret(body, stage, ctx) {
  if (String(body?.Code) !== '200') {
    logger.warn('content_check_provider_error', { stage, ...ctx });
    throw new Error('Moderation business failure');
  }
  const result = body.Data?.Result;
  const risk = body.Data?.RiskLevel;
  if (!Array.isArray(result) || result.some((r) => !r || typeof r.Label !== 'string' || !r.Label)) {
    throw new Error('Malformed moderation response');
  }
  const suspicious = result.find((r) => r.Label !== 'nonLabel');
  if (suspicious || ['low', 'medium', 'high'].includes(risk)) {
    logger.warn('content_check_blocked', { stage, label: suspicious?.Label, risk, ...ctx });
    return { pass: false, suggest: 'risky', label: suspicious?.Label || risk };
  }
  if ((risk !== undefined && risk !== 'none') || (!result.length && risk !== 'none')) {
    throw new Error('Uncertain moderation result');
  }
  return { pass: true, suggest: 'pass', label: 'nonLabel' };
}

/** 按**字符数**切片（不是字节）。中文一个字算一个，跟服务端口径一致。 */
function splitByLength(text, size) {
  // 按 UTF-16 上限计数，避开代理对；重叠 100 字，减少边界截断词句。
  const out = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    out.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - 100;
    if (/[\uDC00-\uDFFF]/.test(text[start])) start--;
  }
  return out;
}

/**
 * 检查不通过时统一抛这个，保证前后端拿到一致的文案。
 *
 * 文案刻意**不说**「你写的东西违规了」：内容安全会误判，而老师这时候
 * 最需要的是知道「换个说法还能继续」，不是被指控。
 * detail.stage 用来区分是她的输入还是 AI 的输出 —— 后者不是她的错。
 *
 * @param {string} stage 'teacher_input' | 'ai_output'
 */
export function contentBlockedError(stage) {
  return new AppError(ErrorCode.VALIDATION_FAILED, {
    message:
      stage === 'ai_output'
        ? '生成的内容没通过安全检查，换个说法再试试'
        : '这段内容没通过安全检查，换个说法试试',
    detail: { stage },
  });
}
