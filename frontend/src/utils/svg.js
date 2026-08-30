/**
 * SVG → data URI。
 *
 * 图标走 <img src="data:..."> 而不是内联 <svg>：颜色是参数（选中/未选中、禁用），
 * 内联的话每个图标都得写成一个组件，而现在它们只是几个纯函数。
 *
 * 自己实现 base64 而不用 btoa：这几个函数被 scripts/ 下的 node 脚本 import，
 * 而且它是纯函数、没有平台依赖 —— 图标和插画全是 ASCII，不用处理多字节。
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 只处理 ASCII。SVG 里出现中文会编坏，所以插画里不放文字。 */
export function base64Ascii(str) {
  let out = ''
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i)
    const b = str.charCodeAt(i + 1)
    const c = str.charCodeAt(i + 2)
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)]
    out += Number.isNaN(b) ? '=' : B64[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)]
    out += Number.isNaN(c) ? '=' : B64[c & 63]
  }
  return out
}

/** @param {string} inner 不含 <svg> 外壳的内容 */
export function svgUri(inner, { width, height, viewBox }) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${viewBox}" fill="none">${inner}</svg>`
  return `data:image/svg+xml;base64,${base64Ascii(svg)}`
}

export const strokePath = (d, color, width) =>
  `<path d="${d}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
