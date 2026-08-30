/**
 * 对比度对账。
 *
 * design-tokens.md 第 2 节写了四条色彩规则，但那四条规则一直只是文字 ——
 * 没有任何东西在检查它们。这个脚本把其中两条变成断言：
 *
 *   规则 1「亮色只做底，深色只做字」→ 扫全部 vue，`color:` 后面不许出现四个亮色本体
 *   任何文字 ≥ 4.5:1（design-tokens 第 4 节的下限）→ 逐对算 WCAG 对比度
 *
 * 第二条需要知道「这个字压在什么底上」，而那件事没法从 CSS 里可靠地推出来
 * （底色常常在祖先节点上，跨文件、跨组件）。所以用一张**显式的配对表**：
 * 界面上真实出现的每一个「字色 × 底色」写在 PAIRS 里，逐对算。
 * 好处是改动一个令牌值，这里立刻会红；代价是新写一屏得自己往表里加一行。
 *
 *   node scripts/contrast-test.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const { COLORS } = await import('../src/utils/colors.js')

let failed = 0
const L = console.log
const chk = (cond, msg) => {
  L(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failed++
}

/* ============ WCAG 相对亮度与对比度 ============ */

function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function luminance(hex) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function ratio(fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const r2 = (x) => Math.round(x * 100) / 100

/* ============ 1. 亮色不许做文字色 ============ */
//
// 四个亮色明度都在 0.72–0.85，做文字在奶油底上只有 1.5–3:1。
// 这条是**绝对规则**，所以可以直接扫源码，不会误报：
// 需要彩色文字时一律用 -deep 档。

L('=== 1. 亮色不许做文字色（design-tokens 规则 1）===')

const BRIGHT = ['amber', 'mint', 'sky', 'coral']

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.vue$/.test(full)) out.push(full)
  }
  return out
}

const brightText = []
for (const file of walk(join(root, 'src'))) {
  const rel = relative(root, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  text.split('\n').forEach((line, i) => {
    // 只看 `color:`，不看 `background`/`border-color`/`box-shadow`
    const m = line.match(/(?<!-)\bcolor:\s*\$([a-z0-9-]+)\s*;/)
    if (m && BRIGHT.includes(m[1])) brightText.push(`${rel}:${i + 1} color: $${m[1]}`)
  })
}
brightText.forEach((o) => L(`    ✗ ${o}`))
chk(brightText.length === 0, '没有把 $amber/$mint/$sky/$coral 本体当文字色用')

/* ============ 2. 每一对「字 × 底」都要 ≥ 4.5:1 ============ */
//
// 表里每一行是界面上真实存在的一对。where 写清楚它在哪，
// 红了才知道该去改哪一屏 —— 只报「ink3 on paper2 不够」是没法动手的。

L('\n=== 2. 文字对比度 ≥ 4.5:1（design-tokens 第 4 节下限）===')

const C = COLORS
const PAIRS = [
  // ---- 正文与次级文字，压在三档底上 ----
  ['ink', 'paper', '正文 · 主底'],
  ['ink', 'paper2', '正文 · 次级分区底'],
  ['ink', 'white', '正文 · 白卡片'],
  ['ink2', 'paper', '次级文字 · 主底'],
  ['ink2', 'paper2', '次级文字 · 次级底'],
  ['ink2', 'white', '次级文字 · 白卡片'],
  ['ink3', 'paper', '最浅文字 · 主底'],
  ['ink3', 'paper2', '最浅文字 · 次级底'],
  ['ink3', 'white', '最浅文字 · 白卡片'],
  ['ink2', 'mintSoft', '次级文字 · 浅绿底（成稿页「为什么这样设计」展开后的正文）'],

  // ---- 彩色文字一律用 deep 档 ----
  ['amberDeep', 'paper', '黄字 · 主底（「兑换」「复制链接」）'],
  ['amberDeep', 'amberSoft', '黄字 · 浅黄底（额度块、复制链接按钮）'],
  ['mintDeep', 'paper', '绿字 · 主底（「已完成」「做完给…」）'],
  ['mintDeep', 'mintSoft', '绿字 · 浅绿底（已完成徽标、存到相册）'],
  ['mintDeep', 'white', '绿字 · 白卡片（教案库卡片「打开看看」）'],
  ['skyDeep', 'paper', '蓝字 · 主底（对话「老师」、有配图）'],
  ['skyDeep', 'skySoft', '蓝字 · 浅蓝底（版本条、正在画）'],
  ['skyDeep', 'white', '蓝字 · 白卡片（回退按钮）'],
  ['coralDeep', 'paper', '珊瑚字 · 主底（删除、快到期）'],
  ['coralDeep', 'paper2', '珊瑚字 · 次级底（这一题没存上、生成失败）'],
  ['coralDeep', 'white', '珊瑚字 · 白卡片'],

  // ---- 亮色做底、深墨做字 ----
  ['ink', 'amber', '墨字 · 黄底（主按钮、必答胶囊、选中筛选）'],
  ['ink', 'mint', '墨字 · 绿底（STEAM 的 S/M 色块）'],
  ['ink', 'sky', '墨字 · 蓝底（STEAM 的 T 色块）'],
  ['ink', 'coral', '墨字 · 珊瑚底（STEAM 的 A 色块）'],
  ['white', 'mintDeep', '白字 · 深绿底（次级按钮、生成完成的勾）'],
]

const LIMIT = 4.5
const rows = []
let bad = 0
for (const [fg, bg, where] of PAIRS) {
  const v = ratio(C[fg], C[bg])
  const ok = v >= LIMIT
  if (!ok) bad++
  rows.push({ fg, bg, v: r2(v), ok, where })
}

// 按对比度升序打印，最险的排最上面 —— 这份输出本身就是收口时的工作清单
rows.sort((a, b) => a.v - b.v)
for (const r of rows) {
  L(`    ${r.ok ? '·' : '✗'} ${String(r.v).padEnd(6)} ${r.fg} on ${r.bg}  ${r.where}`)
}
chk(bad === 0, `${PAIRS.length} 对文字/底色全部 ≥ ${LIMIT}:1`)

/* ============ 3. 承载信息的图形 ≥ 3:1 ============ */
//
// ⚠️ 这一节**只查真正承载信息的图形**，不查装饰性描边。
//
// 第一版把所有描边都塞进来了，结果八对全红 —— $rule-2 压在主底上只有 1.39:1。
// 但那是这张表写错了，不是设计错了：3:1 那条门槛管的是「不看它就读不懂内容」的构件，
// 而卡片是靠白底压在奶油底上区分出来的，描边只是收个边。
// 真把每条发丝线提到 3:1，整套设计会变成一张硬灰格子 —— 方向 B 是用户定死的核心资产。
//
// 判据：**这个图形消失了，她会不会读错信息？**
// 会 → 进这张表。只是没那么好看 → 不进。
// 目前只有一样过得了这个判据：进度条的已完成段，因为那一格里没有任何文字。

L('\n=== 3. 承载信息的图形 ≥ 3:1 ===')

const UI_PAIRS = [
  ['amberDeep', 'rule2', '进度条已完成段 vs 未完成段（格子里没有字，形状是唯一载体）'],
]

let uiBad = 0
for (const [fg, bg, where] of UI_PAIRS) {
  const v = ratio(C[fg], C[bg])
  const ok = v >= 3
  if (!ok) uiBad++
  L(`    ${ok ? '·' : '✗'} ${String(r2(v)).padEnd(6)} ${fg} on ${bg}  ${where}`)
}
chk(uiBad === 0, `${UI_PAIRS.length} 对承载信息的图形 ≥ 3:1`)

/* ============ 4. 选中态不许只靠颜色 ============ */
//
// 选中的胶囊底色从 $paper-2 换成 $amber，两者亮度差只有 1.51:1 ——
// 「哪个被选中了」几乎全靠**色相**，而色相正是色觉障碍者拿不到的那一维。
// 原来只有一个 font-weight:600 兜着，太薄。规则 3 要求「颜色之外必须同时有文字或图形」。
//
// 这一节不做自动扫描（「这个类名有没有配一个打勾」没法从 CSS 可靠地判断，
// 硬写正则只会得到一堆误报，而红两次之后整份脚本就没人看了 —— 见交接文档第 2 条）。
// 改成把**亮度差本身**打出来：它一旦够 3:1，下面那句人工清单就可以撤掉。

L('\n=== 4. 选中态的底色亮度差（够 3:1 才能只靠颜色）===')

const SELECT_PAIRS = [
  ['amber', 'paper2', '选中胶囊 vs 未选中胶囊'],
  ['amberSoft', 'white', '选中选项卡 vs 未选中选项卡'],
]
for (const [a, b, where] of SELECT_PAIRS) {
  const v = ratio(C[a], C[b])
  L(`    ${v >= 3 ? '·' : '→'} ${String(r2(v)).padEnd(6)} ${a} vs ${b}  ${where}`)
}
L('    → 都不到 3:1，所以每个选中态都必须另外挂一个打勾（iconCheck）。')
L('      挂了的：s-option、教案库两排筛选、建议分类、评价三选一、配图用途。')

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`)
process.exit(failed === 0 ? 0 : 1)
