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
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
 * @returns {Promise<{buffer:Buffer, width:number, height:number, bytes:number, costCents:number}>}
 */
export async function generateImage({ prompt, aspectRatio = DEFAULT_RATIO }) {
  if (!config.minimax.configured) {
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
    const res = await fetch(`${config.minimax.baseURL.replace(/\/$/, '')}/v1/image_generation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.minimax.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.minimax.model,
        prompt: String(prompt).slice(0, 1500),
        aspect_ratio: aspectRatio,
        n: 1,
        // 让 MiniMax 自己润色提示词。实测对「幼儿园扁平插画」这类描述有明显提升，
        // 而且我们给的英文提示词本来就是文本模型翻的，不是人写的，经得起再润一次。
        prompt_optimizer: true,
        response_format: 'base64',
      }),
      signal: AbortSignal.timeout(config.minimax.timeoutMs),
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
  const { width, height } = readPngSize(buffer) || ratioToSize(aspectRatio);

  logger.info('minimax_image_generated', {
    ms: t(), bytes: buffer.length, width, height, id: body?.id,
  });

  return {
    buffer, width, height,
    bytes: buffer.length,
    // image-01 是 $0.0035/张，按 7.2 汇率折人民币约 2.5 分。
    // 存整数分是为了让「这个月配图花了多少」能直接 SUM，不用担心浮点误差。
    costCents: 3,
  };
}

/** PNG 的宽高就在文件头固定位置，读它比信参数准（模型可能不完全按 aspect_ratio 出图） */
function readPngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function ratioToSize(r) {
  const [w, h] = String(r).split(':').map(Number);
  if (!w || !h) return { width: 1024, height: 768 };
  return w >= h ? { width: 1024, height: Math.round(1024 * h / w) }
                : { width: Math.round(1024 * w / h), height: 1024 };
}

/**
 * 把图片存下来，返回 object_key。
 *
 * 库里只存 key 不存完整 URL（db-schema.md 的要求）—— 换域名、换云厂商都不用动数据。
 *
 * 两种落地方式，按配置自动选：
 *   1. 配了 OBJECT_STORAGE_* → 传对象存储（生产用，TODO 见下）
 *   2. 没配 → 存本地磁盘 backend/.local-images/，由 server.js 挂静态路由提供访问
 *
 * 第 2 种是**开发期方案**，只在单机上成立：多实例部署时各存各的，老师会随机看到图裂。
 * 但没有它，本地就完全验证不了「生成→落地→显示」这条链路，图片功能只能停在纸面上。
 *
 * @returns {Promise<{objectKey:string, bytes:number}>}
 */
export async function uploadImage({ buffer, ext = 'png' }) {
  const d = new Date();
  const objectKey = `images/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate()
  ).padStart(2, '0')}/${crypto.randomUUID()}.${ext}`;

  if (config.storage.configured) {
    // TODO：接对象存储。两家的 SDK 用法：
    //   腾讯云 COS：npm i cos-nodejs-sdk-v5
    //     const cos = new COS({ SecretId: config.storage.keyId, SecretKey: config.storage.keySecret });
    //     await cos.putObject({ Bucket, Region, Key: objectKey, Body: buffer });
    //   阿里云 OSS：npm i ali-oss
    //     await new OSS({...}).put(objectKey, buffer);
    // 接完把下面这个 throw 删掉即可，返回值形状不用变。
    throw new AppError(ErrorCode.NOT_IMPLEMENTED, {
      message: '云端图片存储还在接入中',
      detail: { reason: 'cloud_upload_not_implemented', objectKey },
    });
  }

  const full = path.join(config.localImageDir, objectKey);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
  logger.info('image_saved_local', { objectKey, bytes: buffer.length });
  return { objectKey, bytes: buffer.length };
}

/** object_key → 可访问的 URL。换域名/换云厂商时只改这一个函数。 */
export function buildImageUrl(objectKey) {
  if (!objectKey) return null;
  const base = config.storage.configured
    ? config.storage.baseUrl
    : `${config.publicBaseUrl}/local-images`;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/${objectKey.replace(/^\//, '')}`;
}
