/**
 * 字号梯子 —— **唯一的源**（人读的那份在 docs/design/design-tokens.md 第 4 节，
 * `npm run test:tokens` 第 4 条逐个对账）。
 *
 * 为什么在 JS 里而不是 SCSS 里：
 *
 * 字号档（标准/大/特大）必须能在运行时切，所以只能走 CSS 变量。而覆盖那几个变量的
 * 办法有两条：给 `s-page` 根节点挂一个类（`.fs-lg`），或者内联 `style` 直接写上去。
 *
 * **类那条路在微信上走不通**：自定义组件默认 `styleIsolation: 'isolated'`，
 * app.wxss 里的**类选择器进不了组件内部**（只有标签选择器能穿透，所以 `page {}` 那层可以）。
 * 而 `s-page` 的根节点正是在组件内部。这条会静默失效 —— 编译不报错、H5 预览还是对的
 * （H5 没有样式隔离），只有微信里「调到特大什么都没变」。
 *
 * 内联 style 不受隔离影响，而 CSS 变量的**继承**跟隔离无关（隔离管的是选择器匹配），
 * 所以子组件里的 `var(--fs-body)` 照样拿得到。代价就是数字得在 JS 里 ——
 * 那就让 JS 成为唯一的源，SCSS 里不再留 `$fs-*`，免得两份数字慢慢飘开。
 */

/**
 * 八级梯子的基准值，单位 rpx（750rpx = 屏宽，1px ≈ 2rpx）。
 *
 * ⚠️ **只有八级，加第九级先去改 design-tokens.md**。收口前页面里有 90 多处硬编码，
 * 25/26/27rpx 这种一像素的区分纯粹是噪音；还有十几处 22rpx = 11px，
 * 低于那份文档自己定的 12px 下限。
 */
export const FS_BASE = {
  hero: 46, // 首页那句问题 23px / 700
  title: 44, // 页面大标题 22px / 700
  question: 40, // 焦点问题标题 20px / 600
  card: 34, // 卡片标题、抽屉标题 17px / 600
  body: 30, // 正文、输入框、选项、按钮 15px / 400
  read: 28, // 长段落阅读（教案流程、协议条目）14px —— 正文下限
  sub: 26, // 次级说明、小按钮 13px
  tag: 24, // 标签/徽标 12px —— 辅助文字下限，不许再小
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

/**
 * 乘上倍率、落到**最近的偶数 rpx**。
 * rpx 转 px 是除以 2，奇数 rpx 落在半像素上，各端凑整方式不一样 ——
 * 同一段文字在开发者工具和真机上差半个像素，看着像发虚。
 */
const step = (base, k) => Math.round((base / 2) * k) * 2

/** 给 s-page 根节点用的内联 style 对象。 */
export function fontVars(scaleKey) {
  const k = FONT_SCALES.find((s) => s.key === scaleKey)?.k ?? 1
  const out = {}
  for (const [name, base] of Object.entries(FS_BASE)) out[`--fs-${name}`] = `${step(base, k)}rpx`
  return out
}
