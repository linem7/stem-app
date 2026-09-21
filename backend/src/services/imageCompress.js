/**
 * 配图压缩（2026-09-21 加的）。
 *
 * 【为什么压】
 * 模型回的是 2400 长边、每张 ~1.7 MB。而这张图的终点是**打印机**，
 * 不是屏幕 —— 打印只需要 2048 长边（A4 约 250 DPI，见 imagePurpose.js）。
 * 多出来的 350px 是白给的，多出来的 1.6 MB 更是。
 *
 * 实测（2026-09-21，用户那三张展示图）：
 *
 *     原图        2400 长边   1.68 MB
 *     2048 / 82              69 KB      ← 省 96%
 *
 * 🔴 **为什么能省 96% 这么夸张**：这些图是 AI 生成的**扁平插画** ——
 * 大面积纯色、硬边、没有照片那种噪点和渐变。JPEG 对这类图的压缩率
 * 远高于照片。**我一开始按照片的经验估「省 70%」，估错了。**
 *
 * 【为什么用 sharp】
 * 它是 Node 生态里唯一合理的选择：底层是 libvips（C 写的最快的那个）。
 * 不在前端压 —— 图是后端生成的，老师根本没见过原图，她压不了
 * 自己没有的东西。不调云厂商 —— 用户刚定了不上对象存储，
 * 这条路上再加一个云服务是自相矛盾。
 *
 * ⚠️ **sharp 是原生模块**，跨平台装不上同一份二进制。
 * 压缩只发生在服务器上（老师的图都在服务器），所以你本地
 * `npm install` 时会多下一个平台包，那是正常的。
 */
import sharp from 'sharp';
import { logger } from '../utils/logger.js';

/** 长边。跟 `imagePurpose.js` 里生成时那个 LONG 是同一个数，**别只改一处** */
export const LONG_EDGE = 2048;

/**
 * JPEG 质量。
 *
 * 82 是「视觉无损」的经典区间（80–85）。**对扁平插画尤其安全** ——
 * 没有噪点要保留，压到 70 才开始看出块状。
 *
 * ⚠️ **这个值要拿打印实测定，不能只看文件大小。**
 * 最该验的是**记录表**（`isPrintKind()` 里那一类）—— 粗黑线 + 大格子，
 * 硬边最容易露压缩痕迹，而它印出来是给孩子填的，格子不对就是废纸。
 * 展示图 / 材料图这类插画压到 70 都看不出，但记录表不一定。
 */
export const JPEG_QUALITY = 82;

/** 打印类（记录表 / 头饰）的质量。它们比插画脆，留一档更保守的余地 */
export const JPEG_QUALITY_PRINT = 90;

/**
 * 压一张图。
 *
 * @param {Buffer} buffer      模型回的原始字节
 * @param {object} o
 * @param {string} o.ext       原扩展名，用来判断能不能压（gif 不压）
 * @param {boolean} o.isPrint  是不是打印类（记录表/头饰）—— 用更保守的质量
 * @returns {Promise<{buffer: Buffer, ext: string, compressed: boolean,
 *                    width: number|null, height: number|null}>}
 *   ⚠️ **宽高一定要回**：缩放之后尺寸变了，而调用方要把新值写进库里。
 *   不回的话库里会留着旧尺寸，而那两个数**不是装饰** ——
 *   导出 docx 时按它们算缩放比例（见 `lessonDocx.js` 的 `fitBox`），
 *   记录表被按错比例压扁就是废纸。
 *
 * ⚠️ **失败要原样返回，不能抛。** 压图是「让文件变小」的优化，
 * 它失败不该让「老师拿不到图」—— 那两件事的严重程度差得远。
 * 记日志 + 用原图，她的活动照常能用。
 */
export async function compressImage(buffer, { ext = 'jpg', isPrint = false } = {}) {
  const e = String(ext).toLowerCase();

  /* 只压 JPEG。
     · PNG 拖进这条路会**变大**（PNG 是无损格式，而我们的图本来就是
       有损拍的，转 PNG 只会更占地方）—— 模型那边基本都是 JPEG
     · GIF / WebP 直接放过：GIF 有动画，重编码会丢帧；
       WebP 不能用于 docx 嵌图（Word 老版本不认），
       而这个图**要嵌进导出件**，所以不能转成 WebP */
  if (e !== 'jpg' && e !== 'jpeg') {
    logger.info('image_compress_skipped', { ext: e, reason: 'not_jpeg' });
    return { buffer, ext: e, compressed: false, width: null, height: null };
  }

  try {
    const out = await sharp(buffer)
      /* `fit: inside` 是**等比缩进一个方框**，不裁剪、不拉伸。
         ⚠️ **绝不能用 `cover` / `fill`** —— 那会把记录表（竖长条）
         压扁，而记录表的格子「不对就是废纸」，那是它存在的全部意义。 */
      .resize({
        width: LONG_EDGE,
        height: LONG_EDGE,
        fit: 'inside',
        /* 比 2048 小的图**不放大** —— 放大只会变糊并变大，
           而模型偶尔会回一张小的（那说明它按别的尺寸出的） */
        withoutEnlargement: true,
      })
      /* `mozjpeg: true` 用 mozjpeg 那个编码器，同样质量下比默认的小 10-15% */
      .jpeg({
        quality: isPrint ? JPEG_QUALITY_PRINT : JPEG_QUALITY,
        mozjpeg: true,
      })
      .toBuffer({ resolveWithObject: true });

    /* 压完反而更大就退回原图。
       理论上不该发生（同样尺寸、更低质量不可能更大），
       但**真发生过一次**：源图本来就是压过的小图，重编码加了元数据反而涨了。
       留着这一句是因为「压完变大」不报错，只会让存储莫名其妙地涨。 */
    if (out.data.length >= buffer.length) {
      logger.info('image_compress_kept_original', {
        original: buffer.length, compressed: out.data.length, reason: 'not_smaller',
      });
      return { buffer, ext: 'jpg', compressed: false, width: null, height: null };
    }

    logger.info('image_compressed', {
      original: buffer.length,
      compressed: out.data.length,
      saved_pct: Math.round((1 - out.data.length / buffer.length) * 100),
      size: `${out.info.width}x${out.info.height}`,
      is_print: isPrint,
    });
    return {
      buffer: out.data,
      ext: 'jpg',
      compressed: true,
      width: out.info.width,
      height: out.info.height,
    };
  } catch (err) {
    /* ⚠️ **不抛。** 见上面那条注释：压图失败不该让老师拿不到图。 */
    logger.warn('image_compress_failed', { err: err.message, bytes: buffer.length });
    return { buffer, ext: e, compressed: false, width: null, height: null };
  }
}
