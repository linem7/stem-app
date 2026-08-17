/**
 * 图标。几何形手搓 SVG，路径逐字来自原型 prototype/index.html 的 IC 表。
 *
 * 颜色作参数传进来（currentColor 在 data URI 里不生效），值一律从 COLORS 取，
 * 不在这里写死新的 hex。
 */

import { COLORS } from './colors.js'
import { svgUri, strokePath } from './svg.js'

const wrap = (inner, size = 16, box = 16) =>
  svgUri(inner, { width: size, height: size, viewBox: `0 0 ${box} ${box}` })

/* ============ 通用小图标 ============ */

export const iconBack = (color = COLORS.ink2) => wrap(strokePath('M10 3 L5 8 L10 13', color, 1.8))

export const iconCheck = (color = COLORS.amberDeep, width = 2) =>
  wrap(strokePath('M3.5 8.5 L6.5 11.5 L12.5 4.5', color, width))

export const iconArrow = (color = COLORS.ink) =>
  wrap(strokePath('M3 8 H12 M8.5 4.5 L12 8 L8.5 11.5', color, 1.8))

export const iconChevron = (color = COLORS.amberDeep) =>
  wrap(strokePath('M6 3.5 L10.5 8 L6 12.5', color, 1.7))

export const iconEdit = (color = COLORS.ink3) =>
  wrap(strokePath('M11.2 2.4 L13.6 4.8 L5.4 13 L2.4 13.6 L3 10.6 Z', color, 1.4))

export const iconDelete = (color = COLORS.ink3) =>
  wrap(strokePath('M3 4.5 H13 M6.2 4.5 V3 H9.8 V4.5 M4.5 4.5 L5.1 13.2 H10.9 L11.5 4.5', color, 1.4))

export const iconPlus = (color = COLORS.ink3) =>
  wrap(strokePath('M8 3.5 V12.5 M3.5 8 H12.5', color, 1.7))

/* ============ 底部 tab ============ */
// on 为 true 时线加粗，跟原型一致：选中不只靠颜色，笔画也变 ——
// 颜色不做状态的唯一载体（design-tokens 规则 3）。

const tabWrap = (inner) => svgUri(inner, { width: 21, height: 21, viewBox: '0 0 22 22' })

export const iconHome = (color, on) =>
  tabWrap(
    strokePath('M3.6 9.4 L11 3.6 L18.4 9.4 V18 a1 1 0 0 1-1 1 H4.6 a1 1 0 0 1-1-1 Z', color, on ? 2 : 1.6)
  )

export const iconLibrary = (color, on) =>
  tabWrap(
    `<rect x="3.4" y="3.6" width="15.2" height="14.8" rx="2.4" stroke="${color}" stroke-width="${on ? 2 : 1.6}"/>` +
      strokePath('M8.4 3.6 V18.4', color, on ? 2 : 1.6)
  )

export const iconMe = (color, on) =>
  tabWrap(
    `<circle cx="11" cy="7.6" r="3.5" stroke="${color}" stroke-width="${on ? 2 : 1.6}"/>` +
      strokePath('M4.4 18.4 c0-3.6 2.9-5.6 6.6-5.6 s6.6 2 6.6 5.6', color, on ? 2 : 1.6)
  )
