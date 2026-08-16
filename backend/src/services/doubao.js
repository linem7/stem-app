/**
 * 豆包（火山引擎）图片生成适配器。
 *
 * ⚠️ 这个文件里有一处**明确的 TODO**：火山引擎的请求签名。
 *
 * 为什么留 TODO 而不是猜着写：
 * 火山引擎用的是自家的「签名机制 V4」（HMAC-SHA256 派生密钥 + 规范化请求串），
 * 各产品线的 Action/Version/请求体字段还不一样。凭记忆写出来的签名 99% 是错的，
 * 而且错了会得到一个语焉不详的 403，比留白更难排查。
 *
 * ---------------------------------------------------------------
 * 拿到 AK/SK 之后，你（或 AI）要补的东西，按这个顺序查：
 *
 * 1. 签名怎么算
 *    火山引擎文档中心 → 「API 参考」→「签名方法」
 *    https://www.volcengine.com/docs/6369/67269
 *    要点：X-Date、X-Content-Sha256、Authorization 三个头，
 *          派生密钥 = HMAC(HMAC(HMAC(HMAC("
 *          SK", date), region), service), "request")
 *    也可以直接用官方 SDK 省掉手写：npm i @volcengine/openapi
 *
 * 2. 图片生成接口的 Action / Version / 请求体
 *    火山引擎控制台 → 视觉智能 / 豆包大模型 → 「图片生成」→ API 文档
 *    https://www.volcengine.com/docs/6791
 *    通常是 POST {endpoint}?Action=CVProcess&Version=2022-08-31
 *    body 形如 { req_key, prompt, width, height, ... }，req_key 就是模型名
 *
 * 3. 返回里图片是 base64 还是 URL
 *    多数接口返回 base64（binary_data_base64 数组），需要自己上传到对象存储
 *
 * 补完之后，把 generateImage 里 THROW_NOT_IMPLEMENTED 那段删掉即可，
 * 上下游（任务队列、轮询接口、每日限额）都已经写好了。
 * ---------------------------------------------------------------
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger, startTimer } from '../utils/logger.js';

/**
 * 生成一张图。
 *
 * @param {object} o
 * @param {string} o.prompt   发给豆包的提示词（英文）
 * @param {number} [o.width]
 * @param {number} [o.height]
 * @returns {Promise<{ buffer: Buffer, width:number, height:number, costCents:number }>}
 */
export async function generateImage({ prompt, width = 1024, height = 768 }) {
  if (!config.doubao.configured) {
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: '配图功能还没开通，先用文字教案吧',
      detail: { reason: 'doubao_not_configured', hint: '在 .env 里填 DOUBAO_ACCESS_KEY_ID / DOUBAO_SECRET_ACCESS_KEY' },
    });
  }

  const t = startTimer();

  // ===================== TODO（拿到 key 后补这一段）=====================
  // const body = JSON.stringify({
  //   req_key: config.doubao.model,
  //   prompt,
  //   width,
  //   height,
  //   return_url: false,
  // });
  // const headers = signRequest({
  //   method: 'POST',
  //   path: '/',
  //   query: 'Action=CVProcess&Version=2022-08-31',
  //   body,
  //   service: 'cv',            // ← 具体 service 名以文档为准
  //   region: config.doubao.region,
  // });
  // const res = await fetch(`${config.doubao.endpoint}/?Action=CVProcess&Version=2022-08-31`, {
  //   method: 'POST',
  //   headers: { ...headers, 'content-type': 'application/json' },
  //   body,
  //   signal: AbortSignal.timeout(60000),
  // });
  // const json = await res.json();
  // const b64 = json?.data?.binary_data_base64?.[0];
  // if (!b64) throw new AppError(ErrorCode.IMAGE_FAILED, { detail: { code: json?.code, message: json?.message } });
  // return { buffer: Buffer.from(b64, 'base64'), width, height, costCents: 3 };
  // ====================================================================

  logger.warn('doubao_not_implemented', { ms: t(), prompt_len: prompt.length });
  throw new AppError(ErrorCode.IMAGE_FAILED, {
    message: '配图功能还在接入中，先用文字教案吧',
    detail: {
      reason: 'not_implemented',
      hint: '按 src/services/doubao.js 顶部注释里的三步补完签名和请求体',
    },
  });
}

/**
 * 火山引擎签名 V4 的骨架。
 *
 * 留着这个骨架是为了让你（或 AI）照着文档往里填的时候有个落点。
 * 四步派生密钥的顺序是固定的，容易错的是「规范化请求串」里
 * query 要按 key 排序、header 名要小写并按字典序、body 要算 SHA256。
 *
 * 官方 SDK 能直接省掉这一段：npm i @volcengine/openapi
 */
export function signRequest({ method, path, query, body, service, region }) {
  const now = new Date();
  const xDate = now.toISOString().replace(/[-:]|\.\d{3}/g, ''); // 20260816T143000Z
  const shortDate = xDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body || '').digest('hex');

  // TODO: 按 https://www.volcengine.com/docs/6369/67269 拼「规范化请求串」
  //   canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  // TODO: 按文档拼「待签字符串」
  //   stringToSign = ['HMAC-SHA256', xDate, `${shortDate}/${region}/${service}/request`, sha256(canonicalRequest)].join('\n')

  const kDate = hmac(`${config.doubao.secretAccessKey}`, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'request');

  // TODO: const signature = hmac(kSigning, stringToSign).toString('hex');
  void kSigning;

  return {
    'X-Date': xDate,
    'X-Content-Sha256': payloadHash,
    // TODO: Authorization: `HMAC-SHA256 Credential=${AK}/${shortDate}/${region}/${service}/request, SignedHeaders=..., Signature=${signature}`
  };
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * 上传到对象存储。
 *
 * TODO（同样等你选定云厂商后补）：
 *   腾讯云 COS：npm i cos-nodejs-sdk-v5   文档 https://cloud.tencent.com/document/product/436/8629
 *   阿里云 OSS：npm i ali-oss             文档 https://help.aliyun.com/zh/oss/developer-reference/nodejs
 *
 * 约定：这个函数只返回 object_key（形如 images/2026/08/16/xxx.png），不返回完整 URL。
 * db-schema.md 明确要求库里只存 key，换域名不用改库；URL 由 buildImageUrl 拼。
 *
 * @returns {Promise<{objectKey:string, bytes:number}>}
 */
export async function uploadImage({ buffer, ext = 'png' }) {
  if (!config.storage.configured) {
    throw new AppError(ErrorCode.IMAGE_FAILED, {
      message: '图片存储还没配置好，稍后再试',
      detail: { reason: 'storage_not_configured', hint: '在 .env 里填 OBJECT_STORAGE_* 那几项' },
    });
  }
  const d = new Date();
  const objectKey = `images/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate()
  ).padStart(2, '0')}/${crypto.randomUUID()}.${ext}`;

  // TODO: 真正上传。伪代码：
  //   const cos = new COS({ SecretId: config.storage.keyId, SecretKey: config.storage.keySecret });
  //   await cos.putObject({ Bucket: config.storage.bucket, Region: config.storage.region, Key: objectKey, Body: buffer });

  void buffer;
  throw new AppError(ErrorCode.IMAGE_FAILED, {
    message: '图片存储还在接入中',
    detail: { reason: 'upload_not_implemented', objectKey },
  });
}

/** object_key → 可访问的 URL。换域名/换云厂商时只改这一个函数。 */
export function buildImageUrl(objectKey) {
  if (!objectKey || !config.storage.baseUrl) return null;
  return `${config.storage.baseUrl.replace(/\/$/, '')}/${objectKey.replace(/^\//, '')}`;
}
