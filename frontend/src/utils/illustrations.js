/**
 * 插画。规范见 design-tokens.md 第 5 节：
 * 纯几何形（圆、弧、三角、圆角矩形）、只用本色板、不画人物面孔、不用 AI 生图。
 * 出现位置克制 —— 目前只有首页顶部和几个空状态。
 *
 * 图形逐字来自原型 prototype/index.html，色值换成 COLORS：原型里写的是 CSS 变量，
 * 而 data URI 里 var() 取不到值，必须是实色。
 */

import { COLORS as C } from './colors.js'
import { svgUri } from './svg.js'

/**
 * 首页顶部：扁平几何风景（太阳 / 云 / 小山 / 树 / 房子）。
 * 用户参考图里就有这一幅，采纳。只用几何形，不画人物面孔。
 */
export const illoHero = () =>
  svgUri(
    `<rect x="0" y="0" width="326" height="126" fill="${C.skySoft}"/>` +
      `<circle cx="266" cy="36" r="19" fill="${C.amber}"/>` +
      `<g fill="${C.white}"><rect x="44" y="32" width="66" height="20" rx="10"/><circle cx="66" cy="32" r="13"/><circle cx="89" cy="29" r="16"/></g>` +
      `<g fill="${C.white}"><rect x="166" y="20" width="46" height="14" rx="7"/><circle cx="181" cy="20" r="10"/><circle cx="197" cy="18" r="12"/></g>` +
      `<g fill="${C.mintSoft}" stroke="${C.mint}" stroke-width="2"><circle cx="52" cy="126" r="48"/><circle cx="150" cy="132" r="58"/><circle cx="268" cy="128" r="44"/></g>` +
      `<rect x="0" y="98" width="326" height="28" fill="${C.mint}"/>` +
      `<rect x="140" y="70" width="52" height="28" rx="4" fill="${C.paper}"/>` +
      `<path d="M166 47 L200 72 L132 72 Z" fill="${C.coral}"/>` +
      `<rect x="159" y="82" width="14" height="16" rx="3" fill="${C.amber}"/>` +
      `<rect x="145" y="78" width="10" height="10" rx="2" fill="${C.sky}"/>` +
      `<g fill="${C.amberDeep}"><rect x="41.5" y="90" width="5" height="14" rx="2"/><rect x="245.5" y="92" width="5" height="12" rx="2"/><rect x="286" y="94" width="4" height="10" rx="2"/></g>` +
      `<g fill="${C.mintDeep}"><path d="M44 58 L60 98 L28 98 Z"/><path d="M248 68 L261 98 L235 98 Z"/><path d="M288 76 L298 98 L278 98 Z"/></g>`,
    { width: 326, height: 126, viewBox: '0 0 326 126' }
  )

/** 待激活页：一张「码」的示意 —— 卡片上四段短横，右上一个太阳，左下一座小山 */
export const illoRedeem = () =>
  svgUri(
    `<rect width="300" height="150" rx="16" fill="${C.amberSoft}"/>` +
      `<rect x="86" y="52" width="128" height="58" rx="9" fill="${C.paper}" stroke="${C.amberLine}" stroke-width="2"/>` +
      `<g stroke="${C.amberLine}" stroke-width="3" stroke-linecap="round">` +
      `<path d="M104 74 H126"/><path d="M138 74 H160"/><path d="M172 74 H194"/><path d="M104 92 H150"/></g>` +
      `<circle cx="240" cy="44" r="14" fill="${C.amber}"/>` +
      `<path d="M52 110 L64 84 L76 110 Z" fill="${C.mintDeep}"/>`,
    { width: 300, height: 150, viewBox: '0 0 300 150' }
  )
