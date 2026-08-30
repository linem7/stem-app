/**
 * 色值的 JS 副本。
 *
 * 为什么要有第二份：图标是 data URI SVG，颜色得在 JS 里拼进字符串，而 SCSS 变量
 * 在 <script> 块里取不到。小程序构建里也没有「把 scss 变量导出给 js」这条路。
 *
 * ⚠️ 这份是**副本不是源**。改色的顺序永远是：
 *   docs/design/design-tokens.md → src/uni.scss → 这里
 * 三处不一致时 `npm run test:tokens` 会红（它逐行比 uni.scss 和这个文件）。
 */

export const COLORS = {
  canvas: '#F9F5E3',
  paper: '#FFFDF8',
  paper2: '#FBF7EC',

  amber: '#F5C63D',
  amberSoft: '#FDF6DE',
  amberLine: '#E8B62A',
  amberDeep: '#8A6410',

  mint: '#6FBF8B',
  mintDeep: '#327648',
  mintSoft: '#EAF6EE',
  mintLine: '#C3E0CE',

  sky: '#8FC7E8',
  skySoft: '#EAF3FA',
  skyLine: '#D2E1EA',
  skyDeep: '#2E6E96',
  coral: '#EE8069',
  coralDeep: '#B44B33',

  ink: '#3A3630',
  ink2: '#6B655C',
  ink3: '#736D62',
  rule: '#EBE5D6',
  rule2: '#DDD9CC',
  white: '#FFFFFF',

  amberShadow: '#E8B62A',
  mintShadow: '#27593A',
  disabledBg: '#EFEADE',
  disabledInk: '#948D81',
}

/** uni.scss 里的变量名 → COLORS 的键。test:tokens 靠这张表对账。 */
export const SCSS_NAME_MAP = {
  canvas: 'canvas',
  paper: 'paper',
  'paper-2': 'paper2',
  amber: 'amber',
  'amber-soft': 'amberSoft',
  'amber-line': 'amberLine',
  'amber-deep': 'amberDeep',
  mint: 'mint',
  'mint-deep': 'mintDeep',
  'mint-soft': 'mintSoft',
  'mint-line': 'mintLine',
  sky: 'sky',
  'sky-soft': 'skySoft',
  'sky-line': 'skyLine',
  'sky-deep': 'skyDeep',
  coral: 'coral',
  'coral-deep': 'coralDeep',
  ink: 'ink',
  'ink-2': 'ink2',
  'ink-3': 'ink3',
  rule: 'rule',
  'rule-2': 'rule2',
  white: 'white',
  'amber-shadow': 'amberShadow',
  'mint-shadow': 'mintShadow',
  'disabled-bg': 'disabledBg',
  'disabled-ink': 'disabledInk',
}
