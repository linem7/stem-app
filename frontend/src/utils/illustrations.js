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
