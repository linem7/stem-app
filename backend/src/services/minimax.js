/**
 * MiniMax 图片生成（image-01）+ 图片落地。
 *
 * 2026-08-17 从字节豆包换过来。换的原因很实际：豆包走火山引擎的签名机制 V4，
 * 要自己实现 HMAC 四步派生签名，调不通时几乎没法排查；MiniMax 是一个 Bearer token
 * 加一次 POST，当场就能用 curl 验证。ADR-001 已同步。
 *
 * 端点分大陆和海外两套，本项目的老师都在大陆，默认走 api.minimaxi.com。
 * 官方文档：https://platform.minimax.io/docs/guides/image-generation
 *
 * 关键取舍：response_format 用 base64 而不是 url。
 * MiniMax 返回的 URL **24 小时后失效** —— 老师今天生成的教案明天图就没了，
 * 这种失败还不会报错，只是图裂掉，最难查。所以一律取 base64 当场落地。
 */
import { readImageMeta } from './imageStore.js';
import { config } from '../config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger, startTimer } from '../utils/logger.js';

/** 教案配图用 4:3 —— 成稿页的图位是横的，竖图会被裁掉半张 */
const DEFAULT_RATIO = '4:3';

/**
 * MiniMax 的业务错误码。HTTP 一律 200，成败看 base_resp.status_code，
 * 只看 res.ok 会把「余额不足」当成功处理。
 * 文案直接写给老师看，所以不出现「status_code」这类词。
 */
const ERR_MSG = {
  1000: { msg: '配图服务出了点问题，再试一次', retry: true },
  1001: { msg: '配图超时了，再试一次通常就好', retry: true },
  1002: { msg: '配图排队的人有点多，等一下再试', retry: true },
  1004: { msg: '配图服务的密钥不对，请联系管理员检查 MINIMAX_API_KEY', retry: false },
  1008: { msg: '配图账户余额不足了，充值后就能继续用', retry: false },
  1013: { msg: '配图服务暂时不可用，稍后再试', retry: true },
  1026: { msg: '这个描述没通过内容审核，换个说法试试', retry: false },
  1027: { msg: '生成的图片没通过内容审核，换个描述试试', retry: false },
  2013: { msg: '配图参数不对，请联系管理员', retry: false },
};

function apiError(code, extra = {}) {
  const e = ERR_MSG[code] || { msg: `配图没成功（错误码 ${code}）`, retry: true };
  return new AppError(ErrorCode.IMAGE_FAILED, {
    message: e.msg,
    detail: { provider: 'minimax', status_code: code, retryable: e.retry, ...extra },
  });
}

/**
 * 文生图。
 *
 * @param {object} o
 * @param {string} o.prompt        英文提示词（由 buildImagePrompt 让文本模型翻好）
 * @param {string} [o.aspectRatio] 1:1 | 16:9 | 4:3 | 3:2 | 2:3 | 3:4 | 9:16 | 21:9
 * @param {number} [o.width]       给了宽高就按宽高出（512-2048，8 的倍数），优先于 aspectRatio
 * @param {number} [o.height]
 * @param {boolean} [o.optimize] 要不要让 MiniMax 再润一次提示词。文档类图要关掉，见下方注释
 * @returns {Promise<{buffer:Buffer, width:number, height:number, bytes:number, costCents:number}>}
 */
export async function generateImage({ account, prompt, aspectRatio = DEFAULT_RATIO, width, height, optimize }) {
  // account 由调度层给（内置那家来自 .env，后台加的来自 image_models 表）——
  // 这个文件不再自己读 config，否则"同一种格式、不同账号"就没法支持
  const acc = account || config.minimax;
  if (!acc?.apiKey) {
    throw new AppError(ErrorCode.NOT_IMPLEMENTED, {
      message: '配图功能还没开通，先用文字教案吧',
      detail: { reason: 'minimax_not_configured', hint: '在 .env 里填 MINIMAX_API_KEY' },
    });
  }
  if (!prompt || !String(prompt).trim()) {
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: '还不知道要画什么，先说一句描述',
      detail: { reason: 'empty_prompt' },
    });
  }

  const t = startTimer();
  let body;
  try {
    const res = await fetch(`${String(acc.baseURL).replace(/\/$/, '')}/v1/image_generation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${acc.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: acc.model,
        prompt: String(prompt).slice(0, 1500),
        // 给了具体尺寸就用尺寸，没给才退回比例。
        // 为什么要具体尺寸：这些图的终点是打印机不是屏幕 —— 1152x864 印在 A4 上
        // 只有约 140 DPI，线条发虚；2048 长边约 250 DPI 才够。代价是一张从 30 秒变成约 47 秒。
        ...(width && height ? { width, height } : { aspect_ratio: aspectRatio }),
        n: 1,
        // 润色开关按用途给。
        //
        // 对插画类（材料图、背景墙）它确实有提升，我们给的英文本来就是文本模型翻的，
        // 经得起再润一次。但对**文档类**（记录表）它是有害的：
        // 「可复印的练习纸」这个视觉套路里天然带标题栏和出版社水印，
        // 润色器会把这些补回来，把我们写死的「一个字都不许有」直接盖掉。
        // 实测记录表开着润色会画出 "Table" 标题和一个假水印 "Nehproeds"。
        ...(optimize === undefined ? { prompt_optimizer: true } : { prompt_optimizer: optimize }),
        response_format: 'base64',
      }),
      signal: AbortSignal.timeout(acc.timeoutMs || config.minimax.timeoutMs),
    });
    body = await res.json();
  } catch (err) {
    logger.error('minimax_network_failed', { ms: t(), message: err.message });
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: err.name === 'TimeoutError' ? '配图超时了，再试一次通常就好' : '配图服务连不上，稍后再试',
      detail: { provider: 'minimax', reason: 'network' },
      cause: err,
    });
  }

  const code = body?.base_resp?.status_code ?? 0;
  if (code !== 0) {
    logger.error('minimax_api_error', { ms: t(), status_code: code, msg: body?.base_resp?.status_msg });
    throw apiError(code);
  }

  // 官方文档提醒要看 success_count，不能假设请求了 n 张就回 n 张
  const b64list = body?.data?.image_base64;
  const b64 = Array.isArray(b64list) ? b64list[0] : b64list;
  if (!b64) {
    logger.error('minimax_empty_result', { ms: t(), success: body?.metadata?.success_count });
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: '这次没画出来，再试一次',
      detail: { provider: 'minimax', reason: 'no_image', success_count: body?.metadata?.success_count },
    });
  }

  const buffer = Buffer.from(b64, 'base64');
  // image-01 实际返回的是 **JPEG**（魔数 FFD8），不是 PNG。
  // 按 PNG 存会得到一个扩展名是 .png 的 JPEG 文件 —— 浏览器多半能显示，
  // 但对象存储的 Content-Type 会标错，某些客户端就不认了。
  // 参数名跟入参的 width/height 撞了，这里换个名 —— 实际尺寸以图片头里读到的为准，
  // 模型不保证完全照着我们给的尺寸出
  const meta = readImageMeta(buffer) || { ext: 'jpg', ...ratioToSize(aspectRatio) };
  const { ext } = meta;
  const outWidth = meta.width || width || 0;
  const outHeight = meta.height || height || 0;

  logger.info('minimax_image_generated', {
    ms: t(), bytes: buffer.length, width: outWidth, height: outHeight, ext, id: body?.id,
  });

  return {
    buffer, width: outWidth, height: outHeight, ext,
    bytes: buffer.length,
    // image-01 是 $0.0035/张，按 7.2 汇率折人民币约 2.5 分。
    // 存整数分是为了让「这个月配图花了多少」能直接 SUM，不用担心浮点误差。
    costCents: 3,
  };
}

/** 只有按比例出图时才用得上，具体尺寸优先 */
function ratioToSize(r) {
  const [w, h] = String(r).split(':').map(Number);
  if (!w || !h) return { width: 1024, height: 768 };
  return w >= h ? { width: 1024, height: Math.round(1024 * h / w) }
                : { width: Math.round(1024 * w / h), height: 1024 };
}

