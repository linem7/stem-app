/**
 * Gemini 原生格式出图（nanobanana 系列：gemini-3.1-flash-image-preview 等，经 12ai 中转）。
 *
 * 跟另外两家的差别不是"参数名不同"，是**三处结构性不同**，照抄前两家的写法一定跑不通：
 *   1. 鉴权走 URL 上的 ?key=，不是 Authorization 头
 *   2. 尺寸没有宽高，只有 aspectRatio + imageSize（"1K"/"2K"/"4K"）——
 *      所以我们那套按打印定的宽高要换算成最接近的比例，实际拿到多大由模型定
 *   3. 返回是 candidates[0].content.parts[]，里面**混着** text / thought /
 *      inlineData / functionCall 好几种，要挑出带 inlineData 的那个，不能取 parts[0]
 *
 * 实测（2026-08-18，与服务商给的说明不一致的地方）：
 *   - contents 必须是 [{ parts: [{ text }] }]。说明里写的 [{ text }] 会被拒：
 *     400 "At least one text part is required"
 *   - 返回的 mimeType 是 **image/jpeg**，不是说明里写的 image/png
 *   - 3:4 + 2K 实际给到 1792×2400，比 gpt-image-2 的 1536×2048 还大
 *   - **快**：16.7 秒，gpt-image-2 同一张要 60–71 秒
 */
import { readImageMeta } from './imageStore.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger, startTimer } from '../utils/logger.js';

/** Gemini 支持的比例。我们那套打印宽高要落到最近的一档 */
const RATIOS = [
  { name: '1:1', v: 1 },
  { name: '4:3', v: 4 / 3 },
  { name: '3:4', v: 3 / 4 },
  { name: '16:9', v: 16 / 9 },
  { name: '9:16', v: 9 / 16 },
  { name: '3:2', v: 3 / 2 },
  { name: '2:3', v: 2 / 3 },
  { name: '21:9', v: 21 / 9 },
];

/**
 * 宽高 → 最接近的比例名。
 * 头饰是 2048×1024（2:1），Gemini 没有这一档，会落到 21:9 或 16:9 ——
 * 带子那两条依然画得出来，只是画布没那么扁。这是这套接口的固有限制，不是 bug。
 */
export function nearestRatio(width, height) {
  if (!width || !height) return '1:1';
  const target = width / height;
  return RATIOS.reduce((best, r) =>
    Math.abs(r.v - target) < Math.abs(best.v - target) ? r : best
  ).name;
}

const HTTP_ERR = {
  400: { msg: '这个描述模型没看懂，换个说法试试', retry: false },
  401: { msg: '配图服务的密钥不对，请到管理后台检查这个模型的 key', retry: false },
  402: { msg: '配图账户余额不足了，充值后就能继续用', retry: false },
  403: { msg: '这个描述没通过内容审核，换个说法试试', retry: false },
  404: { msg: '配图模型名或地址不对，请到管理后台检查', retry: false },
  429: { msg: '配图排队的人有点多，等一下再试', retry: true },
  500: { msg: '配图服务出了点问题，再试一次', retry: true },
  502: { msg: '配图服务暂时不可用，稍后再试', retry: true },
  503: { msg: '配图服务暂时不可用，稍后再试', retry: true },
  504: { msg: '配图超时了，再试一次通常就好', retry: true },
};

function apiError(status, extra = {}) {
  const e = HTTP_ERR[status] || { msg: `配图没成功（错误 ${status}）`, retry: status >= 500 };
  return new AppError(ErrorCode.IMAGE_FAILED, {
    message: e.msg,
    detail: { format: 'gemini', status, retryable: e.retry, ...extra },
  });
}

/**
 * 文生图。返回值形状跟另外两家完全一致 —— 调用方不该知道用的是哪一家。
 *
 * @param {object} o
 * @param {object} o.account { baseURL, apiKey, model, timeoutMs, imageSize }
 * @param {string} o.prompt  英文提示词
 * @param {number} [o.width]  按打印定的宽高，这里只用来折算比例
 * @param {number} [o.height]
 */
export async function generateImage({ account, prompt, width, height }) {
  const acc = account || {};
  if (!acc.apiKey) {
    throw new AppError(ErrorCode.NOT_IMPLEMENTED, {
      message: '配图功能还没开通，先用文字教案吧',
      detail: { reason: 'gemini_not_configured' },
    });
  }
  if (!prompt || !String(prompt).trim()) {
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: '还不知道要画什么，先说一句描述',
      detail: { reason: 'empty_prompt' },
    });
  }

  const t = startTimer();
  // key 在 URL 上 —— 记日志时**绝不能**把这个 url 原样打出去
  const url =
    `${String(acc.baseURL).replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(acc.model)}` +
    `:generateContent?key=${encodeURIComponent(acc.apiKey)}`;

  let res;
  let body;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // 必须是 parts 包一层。服务商文档里那种 [{ text }] 会被 400 拒掉
        contents: [{ parts: [{ text: String(prompt).slice(0, 4000) }] }],
        generationConfig: {
          // 只要图。带上 TEXT 的话它会先写一段解说，白花 token
          responseModalities: ['IMAGE'],
          // 驼峰是硬要求，写成 image_size 会被忽略然后给一张小图
          imageConfig: {
            aspectRatio: nearestRatio(width, height),
            imageSize: acc.imageSize || '2K',
          },
        },
      }),
      signal: AbortSignal.timeout(acc.timeoutMs || 150000),
    });
    body = await res.json();
  } catch (err) {
    logger.error('gemini_image_network_failed', { ms: t(), message: err.message });
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: err.name === 'TimeoutError' ? '配图超时了，再试一次通常就好' : '配图服务连不上，稍后再试',
      detail: { format: 'gemini', reason: 'network' },
      cause: err,
    });
  }

  if (!res.ok) {
    logger.error('gemini_image_api_error', {
      ms: t(),
      status: res.status,
      msg: String(body?.error?.message || '').slice(0, 200),
    });
    throw apiError(res.status);
  }

  // parts 里混着 text / thought / inlineData / functionCall，挑出带图的那个
  const parts = body?.candidates?.[0]?.content?.parts || [];
  const b64 = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;
  if (!b64) {
    logger.error('gemini_image_empty_result', {
      ms: t(),
      parts: parts.map((p) => Object.keys(p || {}).join('+')).join('|'),
      finish: body?.candidates?.[0]?.finishReason,
    });
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: '这次没画出来，再试一次',
      detail: { format: 'gemini', reason: 'no_image', finish: body?.candidates?.[0]?.finishReason },
    });
  }

  const buffer = Buffer.from(b64, 'base64');
  // 说明里写 image/png，实际回的是 JPEG —— 一律以字节流里读到的为准
  const meta = readImageMeta(buffer) || { ext: 'jpg', width: 0, height: 0 };

  logger.info('gemini_image_generated', {
    ms: t(),
    bytes: buffer.length,
    width: meta.width,
    height: meta.height,
    ext: meta.ext,
    model: acc.model,
  });

  return {
    buffer,
    width: meta.width || 0,
    height: meta.height || 0,
    ext: meta.ext,
    bytes: buffer.length,
    // 没有公开价目表，也不返回 usage。给一个量级值，不返回 0 ——
    // 0 会让成本统计看起来像免费的，比估不准更糟
    costCents: 3,
  };
}
