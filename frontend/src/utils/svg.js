/**
 * SVG → data URI。
 *
 * 小程序的 wxml 里放不了 <svg> 标签，只能走 <image src="data:..."> 或 wxss 的
 * background-image。两者对「原样 utf8 的 svg data URI」支持时好时坏，base64 是稳的，
 * 而小程序里没有 btoa，所以这里自己实现一个 —— 图标和插画全是 ASCII，不用处理多字节。
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
