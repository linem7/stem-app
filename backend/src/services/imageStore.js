/**
 * 图片落地与取址 —— 跟「哪个模型画的」无关的那一半。
 *
 * 2026-08-18 从 minimax.js 拆出来。原因是配图现在有两个供应商（MiniMax 和 gpt-image-2），
 * 存储、URL 拼接、以及「从字节流本身认格式和宽高」这三件事两边一模一样，
 * 留在其中一家的文件里，另一家要么 import 一个名字不对的模块，要么把解析器抄一遍。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { compressImage } from './imageCompress.js';

/**
 * 从字节流本身认格式和宽高，**不信参数也不信扩展名**。
 * 模型不一定完全按我们给的尺寸出图，返回格式也可能随版本变
 * —— MiniMax 的 image-01 就是说好 png 实际回 JPEG。
 */
export function readImageMeta(buf) {
  // PNG：89 50 4E 47，宽高在固定偏移
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG：FFD8 开头，宽高在 SOF 段里，得顺着段长跳过去找
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o += 1; continue; }
      const marker = buf[o + 1];
      // SOF0-SOF15，跳过 DHT(C4)/RSTn(C8)/DAC(CC) 这几个不是尺寸段的
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { ext: 'jpg', height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
    return { ext: 'jpg', width: 0, height: 0 };
  }
  return null;
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
 * 🔴 **压缩在这里做，而且在这里是唯一正确的位置**（2026-09-21 加）：
 * 这是**所有图的唯一落地点**（配图生成、后台模型测试两条路都走它），
 * 所以在这儿压一次，两条路都受益，也不会有「哪条路忘了压」的可能。
 * 「生成时压」而不是「存原图再压」—— 存进去的就是最终那份，少一层状态。
 *
 * @param {object} o
 * @param {Buffer} o.buffer
 * @param {string} o.ext           模型回的格式
 * @param {boolean} o.isPrint      打印类（记录表/头饰）用更保守的压缩质量
 * @returns {Promise<{objectKey:string, bytes:number}>}
 */
export async function uploadImage({ buffer: raw, ext = 'png', isPrint = false }) {
  const got = await compressImage(raw, { ext, isPrint });
  const buffer = got.buffer;
  const finalExt = got.ext;

  const d = new Date();
  const objectKey = `images/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(
    d.getDate()
  ).padStart(2, '0')}/${crypto.randomUUID()}.${finalExt}`;

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
  /* 🔴 **宽高也回给调用方。**
     原来是「调用方自己拿模型要求的尺寸去写库」，而压缩之后**实际尺寸变了**
     （2048 而不是要的 2400）—— 那样库里记的就是错的。
     错的尺寸不是装饰：导出 docx 时按它算缩放比例（`lessonDocx.js` 的
     `fitBox`），记录表被按错比例压扁就是废纸。
     ⚠️ 没压的那些（PNG / 压完更大）回 `null`，调用方就沿用模型给的值。 */
  return {
    objectKey,
    bytes: buffer.length,
    width: got.width,
    height: got.height,
  };
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

/**
 * object_key → 文件字节。**导出 .docx 要嵌图，所以需要把图读回来**（2026-09-21）。
 *
 * ⚠️ **跟 `buildImageUrl` 是两条路，别混**：那个给的是「前端怎么取到图」
 * （拼 URL，浏览器自己去拿），这个给的是「服务端自己要把图塞进 docx」
 * （必须拿到字节）。前者将来接对象存储时要改成签名 URL，
 * 后者要改成 SDK 的下载方法 —— 但**调用方不用知道**，这正是包在这一层的原因。
 *
 * @returns {Promise<Buffer|null>} 读不到返回 null（**不抛**）——
 *   调用方拿到 null 就跳过这张图。一张图没了不该让整份导出失败，
 *   教案正文才是她要的东西。
 */
export async function readImage(objectKey) {
  if (!objectKey) return null;

  if (config.storage.configured) {
    // TODO：接对象存储时在这里改成 SDK 的下载（`cos.getObject` / `oss.get`）
    logger.warn('cloud_read_not_implemented', { objectKey });
    return null;
  }

  const full = path.join(config.localImageDir, objectKey);
  try {
    return await fs.readFile(full);
  } catch (err) {
    /* 文件不在（换过机器、被清过、object_key 是旧的）—— 记下来但不抛。
       ⚠️ **这条日志要留着**：它是「库里有记录、硬盘上没文件」的唯一线索，
       而那正是「刷新之后图不见了」那类问题的成因之一。 */
    logger.warn('image_file_missing', { objectKey, err: err.code || err.message });
    return null;
  }
}
