/**
 * 字号梯子 —— **唯一的源**（人读的那份在 docs/design/design-tokens.md 第 4 节，
 * `npm run test:tokens` 第 4 条逐个对账）。
 *
 * 为什么在 JS 里而不是 SCSS 里：字号档（标准/大/特大）必须能在运行时切，
 * 所以只能走 CSS 变量，由 `s-page` 内联到根节点上。SCSS 变量在编译期就写死了，
 * 切不动。那就让 JS 成为唯一的源，SCSS 里不再留 `$fs-*`，免得两份数字慢慢飘开。
 */

/**
 * 八级梯子的基准值，单位 **px**（design-tokens.md 第 4 节那张表的 px 那一列）。
 *
 * ⚠️ **只有八级，加第九级先去改 design-tokens.md**。收口前页面里有 90 多处硬编码，
 * 25/26/27rpx 这种一像素的区分纯粹是噪音；还有十几处 11px，
 * 低于那份文档自己定的 12px 下限。
 */
export const FS_BASE = {
  hero: 23, // 首页那句问题 / 700
  title: 22, // 页面大标题 / 700
  question: 20, // 焦点问题标题 / 600
  card: 17, // 卡片标题、抽屉标题 / 600
  body: 15, // 正文、输入框、选项、按钮 / 400
  read: 14, // 长段落阅读（教案流程、协议条目）—— 正文下限
  sub: 13, // 次级说明、小按钮
  tag: 12, // 标签/徽标 —— 辅助文字下限，不许再小
}

/**
 * 三档。倍率对应正文 15 / 17 / 20px。
 *
 * 「特大」为什么到 20px 就停：再大一档，教案成稿页的流程段落会长到滚不完，
 * 她要找「第三环节」得翻四屏 —— 那时候字大反而更难用。
 */
export const FONT_SCALES = [
  { key: 'std', label: '标准', k: 1 },
  { key: 'lg', label: '大', k: 1.15 },
  { key: 'xl', label: '特大', k: 1.32 },
]

const step = (base, k) => Math.round(base * k)

/** 给 s-page 根节点用的内联 style 对象。 */
export function fontVars(scaleKey) {
  const k = FONT_SCALES.find((s) => s.key === scaleKey)?.k ?? 1
  const out = {}
  for (const [name, base] of Object.entries(FS_BASE)) out[`--fs-${name}`] = `${step(base, k)}px`
  return out
}
