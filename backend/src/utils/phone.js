/**
 * 手机号的规范化与校验。
 *
 * 它在这个系统里**只是用户名** —— 不用于联系、不进 AI 提示词、不下发前端、不进日志。
 * 但正因为是用户名，它必须**一字不差**：她对的是自己打的那串，
 * 差一位就进不去，而她不会想到是这里出的错。
 *
 * 【为什么宽容地认，严格地存】
 * 她多半是从微信群或报名表上**复制**过来的，带空格带横线很正常；
 * 中文输入法下打出全角数字也很正常（１２３ 和 123 看起来几乎一样）。
 * 认不出来是我们的问题，不是她的 —— 跟兑换码那条同一个立场。
 *
 * 认出来之后统一存成 11 位半角数字，这样「同一个号」只有一种写法，
 * UNIQUE 索引才真的挡得住重复注册。
 */

/** 全角数字 ０-９ → 半角 0-9。输入法下很容易打出来，肉眼几乎分不出 */
function toHalfWidth(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * @param {unknown} raw 老师填的原文
 * @returns {string|null} 11 位数字，或者 null（认不出来）
 */
export function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;

  // 空格、横线、括号、加号都去掉：+86 138-1234-5678 和 13812345678 是同一个号
  const digits = toHalfWidth(String(raw))
    .replace(/[\s\-()（）+]/g, '')
    .replace(/^86(?=1[3-9]\d{9}$)/, ''); // 带国家码的写法

  // 大陆手机号：1 开头，第二位 3-9，共 11 位。
  // 不认 170/171 那种虚拟号段之外的特殊号 —— 认不出来就报错，不猜
  return /^1[3-9]\d{9}$/.test(digits) ? digits : null;
}

/* 打码不在这里 —— 后台那份在 routes/admin/_shared.js 的 maskPhone，
   同一条规则写两份就会对不上。这里只管「认不认得出」和「认出来之后存成什么」。 */
