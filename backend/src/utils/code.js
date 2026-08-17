/**
 * 兑换码生成与规范化。
 *
 * 码会通过微信文字发给老师，她手动敲进小程序。所以两件事很要紧：
 *   1. **字符集里不能有会看错的字**。0/O、1/I/l、2/Z、5/S、8/B 这些成对出现时，
 *      老师照着微信消息敲，敲错了只会觉得"这破东西不好使"，不会想到是自己看岔了。
 *   2. **输入要宽容**。她可能全用小写、可能把分隔符敲成空格、可能前后带了空格。
 *      这些都该认，而不是甩她一个「兑换码错误」。
 */
import crypto from 'node:crypto';

/** 去掉了 0 O 1 I L 2 Z 5 S 8 B —— 全是手写/屏显容易看混的 */
const ALPHABET = '34679ACDEFGHJKMNPQRTUVWXY';

/** 生成形如 STEM-4K7P-QX3M 的码 */
export function generateCode() {
  const pick = (n) =>
    Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  return `STEM-${pick(4)}-${pick(4)}`;
}

/**
 * 把老师敲进来的东西收敛成标准形。
 * 大小写、空格、下划线、中文破折号统统接受 —— 认不出来是我们的问题，不是她的。
 */
export function normalizeCode(raw) {
  const s = String(raw || '')
    .toUpperCase()
    .replace(/[\s_—–]+/g, '-')     // 空格和各种横线一律当分隔符
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
  return s.slice(0, 32);
}
