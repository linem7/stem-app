/**
 * gpt-image-2 图片生成（经 12ai 中转，OpenAI images 接口的形状）。
 *
 * 2026-08-18 接进来，和 MiniMax 并存，默认走这家。换的理由只有一个，但很硬：
 * **记录表**。MiniMax 画表格画了五次，五种不同的错法（7列2行带手写体乱码、3×3、
 * 2×3 顶着一行 "Name ______"、5列没有横线…），而这张图的用途就是印出来给孩子填，
 * 格子不对就是废纸。gpt-image-2 第一次就给了干净的 3×4、粗黑线、一个字都没有。
 *
 * 实测记下来的几件事（官方说明里没有的）：
 *
 * 1. **路径不是文档里写的那个**。base_url 本身已经带 /v1，再拼 /v1/images/generations
 *    会变成 /v1/v1/...。正确的是 base_url + /images/generations
 * 2. **尺寸不限于文档列的那三档**。文档给的是 1248x1248 / 1792x1008 / 1008x1792，
 *    实测 1536x2048 照收，返回的就是 1536x2048 —— 所以打印用的尺寸（长边 2048、
 *    约 A4 250 DPI）能原样保留。照抄那三档等于把打印分辨率砍掉一半
 * 3. **只用 b64_json，不用 url**。url 指向 fileview.site，不知道能活多久；
 *    MiniMax 那边的 URL 就是 24 小时失效，老师今天生成明天图裂。一律当场落地存字节
 * 4. **慢**。low/1248 用了 61 秒，medium/1536×2048 用了 71 秒，比 MiniMax 还慢一截。
 *    超时给到 150 秒，不然十次里有几次白花钱（IMG_TIMEOUT_MS）
 */
import { readImageMeta } from './imageStore.js';
import { config } from '../config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger, startTimer } from '../utils/logger.js';

/**
 * HTTP 状态码 → 给老师看的中文。
 *
 * 这里的文案是**直接显示在小程序上**的，所以不出现「401」「rate limit」这类词；
 * 需要开发者处理的（密钥、余额）才点名环境变量，因为那句是给管理员看的。
 */
const HTTP_ERR = {
  400: { msg: '这个描述模型没看懂，换个说法试试', retry: false },
  401: { msg: '配图服务的密钥不对，请联系管理员检查 IMG_API_KEY', retry: false },
  402: { msg: '配图账户余额不足了，充值后就能继续用', retry: false },
  403: { msg: '这个描述没通过内容审核，换个说法试试', retry: false },
  404: { msg: '配图服务地址不对，请联系管理员', retry: false },
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
    detail: { provider: 'gpt', status, retryable: e.retry, ...extra },
  });
}

/**
 * 文生图。返回值形状跟 minimax.js 的 generateImage 完全一致 ——
 * 两家要能互相顶替，调用方（routes/images.js）不该知道用的是哪家。
 *
 * @param {object} o
 * @param {string} o.prompt   英文提示词
 * @param {number} [o.width]  给了宽高就按宽高出
 * @param {number} [o.height]
 * @param {string} [o.quality] low | medium | high | auto
 * @returns {Promise<{buffer:Buffer, width:number, height:number, bytes:number, ext:string, costCents:number}>}
 */
export async function generateImage({ account, prompt, width, height, quality }) {
  // account 由调度层给：内置那家来自 .env，后台加的来自 image_models 表
  const acc = account || config.gptImage;
  if (!acc?.apiKey) {
    throw new AppError(ErrorCode.NOT_IMPLEMENTED, {
      message: '配图功能还没开通，先用文字教案吧',
      detail: { reason: 'gpt_image_not_configured', hint: '在 .env 里填 IMG_API_KEY' },
    });
  }
  if (!prompt || !String(prompt).trim()) {
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: '还不知道要画什么，先说一句描述',
      detail: { reason: 'empty_prompt' },
    });
  }

  const size = width && height ? `${width}x${height}` : '1248x1248';
  const t = startTimer();
  let res;
  let body;
  try {
    res = await fetch(`${String(acc.baseURL).replace(/\/$/, '')}/images/generations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${acc.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: acc.model,
        prompt: String(prompt).slice(0, 1500),
        n: 1,
        size,
        quality: quality || acc.quality || config.gptImage.quality,
        response_format: 'b64_json',
      }),
      signal: AbortSignal.timeout(acc.timeoutMs || config.gptImage.timeoutMs),
    });
    body = await res.json();
  } catch (err) {
    logger.error('gpt_image_network_failed', { ms: t(), message: err.message });
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: err.name === 'TimeoutError' ? '配图超时了，再试一次通常就好' : '配图服务连不上，稍后再试',
      detail: { provider: 'gpt', reason: 'network' },
      cause: err,
    });
  }

  if (!res.ok) {
    // 出错时的机器可读信息只进日志，不下发 —— 里面可能带上游的账号信息
    logger.error('gpt_image_api_error', {
      ms: t(),
      status: res.status,
      code: body?.error?.code,
      msg: String(body?.error?.message || '').slice(0, 200),
    });
    throw apiError(res.status, { code: body?.error?.code });
  }

  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) {
    logger.error('gpt_image_empty_result', { ms: t(), keys: Object.keys(body?.data?.[0] || {}) });
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: '这次没画出来，再试一次',
      detail: { provider: 'gpt', reason: 'no_image' },
    });
  }

  const buffer = Buffer.from(b64, 'base64');
  // 同样不信参数：以图片头里读到的为准
  const meta = readImageMeta(buffer) || { ext: 'png', width: 0, height: 0 };
  const outWidth = meta.width || width || 0;
  const outHeight = meta.height || height || 0;

  logger.info('gpt_image_generated', {
    ms: t(),
    bytes: buffer.length,
    width: outWidth,
    height: outHeight,
    ext: meta.ext,
    tokens: body?.usage?.total_tokens,
  });

  return {
    buffer,
    width: outWidth,
    height: outHeight,
    ext: meta.ext,
    bytes: buffer.length,
    costCents: estimateCostCents(body?.usage),
  };
}

/**
 * 折成整数分记账。
 *
 * 12ai 没给公开价目表，这里按返回的 output_tokens 粗估，只用于「这个月配图花了多少」
 * 这种量级判断，不当账单。估不出来就退回一个保守值，**不要返回 0** ——
 * 0 会让成本统计看起来像免费的，比估得不准更糟。
 */
function estimateCostCents(usage) {
  const out = Number(usage?.output_tokens) || 0;
  if (!out) return 5;
  // 约 2000 output tokens 一张，按一张 5 分的量级折算
  return Math.max(1, Math.round((out / 2000) * 5));
}
