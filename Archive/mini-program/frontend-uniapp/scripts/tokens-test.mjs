/**
 * 令牌对账。
 *
 * 色值在三处出现：docs/design/design-tokens.md（源）、src/uni.scss（样式用）、
 * src/utils/colors.js（JS 拼 SVG 用）。人手同步三份迟早会漏一处，
 * 而漏了的表现是「有个图标颜色跟别处差一点点」，眼睛很难发现。
 *
 * 这个脚本逐个比对，顺带查一遍组件里有没有裸 hex。
 *
 *   node scripts/tokens-test.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const { COLORS, SCSS_NAME_MAP } = await import('../src/utils/colors.js')

let failed = 0
const L = console.log
const chk = (cond, msg) => {
  L(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failed++
}

/* ============ 1. uni.scss ↔ colors.js ============ */

L('=== 1. uni.scss 与 colors.js 对账 ===')
const scss = readFileSync(join(root, 'src/uni.scss'), 'utf8')
const scssVars = {}
for (const m of scss.matchAll(/^\$([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/gm)) {
  scssVars[m[1]] = m[2].toUpperCase()
}

let mismatched = 0
for (const [scssName, jsKey] of Object.entries(SCSS_NAME_MAP)) {
  const inScss = scssVars[scssName]
  const inJs = COLORS[jsKey]?.toUpperCase()
  if (!inScss) {
    L(`    ✗ uni.scss 里没有 $${scssName}`)
    mismatched++
  } else if (inScss !== inJs) {
    L(`    ✗ $${scssName}=${inScss} 但 COLORS.${jsKey}=${inJs}`)
    mismatched++
  }
}
chk(mismatched === 0, `${Object.keys(SCSS_NAME_MAP).length} 个色值两处一致`)

const uncovered = Object.keys(scssVars).filter((n) => !(n in SCSS_NAME_MAP))
chk(uncovered.length === 0, `uni.scss 里没有漏登记的色${uncovered.length ? `：${uncovered.join(', ')}` : ''}`)

/* ============ 2. design-tokens.md ↔ uni.scss ============ */

L('\n=== 2. design-tokens.md 与 uni.scss 对账 ===')
const doc = readFileSync(join(root, '../docs/design/design-tokens.md'), 'utf8')
const docVars = {}
// 文档里的表格行形如： | `--amber` | `#F5C63D` | ... |
for (const m of doc.matchAll(/\|\s*`--([a-z0-9-]+)`\s*\|\s*`(#[0-9a-fA-F]{6})`/g)) {
  docVars[m[1]] = m[2].toUpperCase()
}

let docMismatch = 0
for (const [name, hex] of Object.entries(docVars)) {
  if (!(name in scssVars)) {
    L(`    ✗ 文档有 --${name} 但 uni.scss 里没有 $${name}`)
    docMismatch++
  } else if (scssVars[name] !== hex) {
    L(`    ✗ --${name}：文档 ${hex} vs uni.scss ${scssVars[name]}`)
    docMismatch++
  }
}
chk(docMismatch === 0, `文档里的 ${Object.keys(docVars).length} 个色值与 uni.scss 一致`)

/* ============ 2.5 design-tokens.md ↔ 可点击原型 ============ */
//
// 原型（prototype/index.html）是色板的**第三份副本**，而且它一直在悄悄飘：
// 2026-08-20 查出来 `--mint-deep` 在那边是 `oklch(0.52 0.115 155)`、
// `--ink-3` 是 `oklch(0.505 0.014 82)` —— 都是手调过的，跟文档不是一个值。
// 飘开的表现是「原型上的绿跟小程序里的绿差一点点」，没人看得出来，
// 但拿原型给人看设计的时候，看的就不是真东西了。
//
// 只查原型 :root 里写成 hex 的那些（其余 oklch 是透明度/派生阴影，不在文档管辖范围）。

L('\n=== 2.5 design-tokens.md 与可点击原型对账 ===')
const proto = readFileSync(join(root, '../prototype/index.html'), 'utf8')
const protoRoot = proto.slice(proto.indexOf(':root{'), proto.indexOf('--f-body'))
const protoVars = {}
for (const m of protoRoot.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
  protoVars[m[1]] = m[2].toUpperCase()
}
let protoMismatch = 0
for (const [name, hex] of Object.entries(protoVars)) {
  if (!(name in docVars)) continue // 原型自己的辅助色，文档不管
  if (docVars[name] !== hex) {
    L(`    ✗ --${name}：原型 ${hex} vs 文档 ${docVars[name]}`)
    protoMismatch++
  }
}
chk(protoMismatch === 0, `原型里 ${Object.keys(protoVars).length} 个色值与文档一致`)

/* ============ 3. 组件里不许有裸 hex ============ */

L('\n=== 3. 组件与页面里不许有裸 hex ===')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(vue|js)$/.test(full)) out.push(full)
  }
  return out
}

// colors.js 和 icons.js 本来就是放色值的地方，uni.scss/tokens.scss 是源
const ALLOWED = ['src/utils/colors.js']

const offenders = []
for (const file of walk(join(root, 'src'))) {
  const rel = relative(root, file).replace(/\\/g, '/')
  if (ALLOWED.includes(rel)) continue
  const text = readFileSync(file, 'utf8')
  const hits = [...text.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0])
  if (hits.length) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`)
}
if (offenders.length) offenders.forEach((o) => L(`    ✗ ${o}`))
chk(offenders.length === 0, '没有裸 hex')

/* ============ 4. 字号必须走 var(--fs-*) ============ */
//
// 两件事一起查：
//
// ① **不许出现新字号**。收口前有 90 多处硬编码，25/26/27rpx 这种一像素的区分是噪音，
//    还有十几处 22rpx = 11px，低于 design-tokens 自己定的 12px 下限。
//    梯子只有八级（uni.scss 的 $fs-*），要第九级先去改那份文档。
//
// ② **不许用 $fs-* SCSS 变量**。SCSS 变量在编译期就写死成一个 rpx 值了，
//    而字号档（标准/大/特大）是靠覆盖 CSS 变量实现的 —— 写死的地方跟着放大不了。
//    这条最阴：源码看着完全正确，`$fs-tag` 明明就是那个令牌，
//    只有把字号调到特大、发现「就那几个标签没变大」才会发现。

L('\n=== 4. 字号必须走 var(--fs-*) ===')

const { FS_BASE } = await import('../src/utils/typography.js')
const LADDER = Object.keys(FS_BASE)

// ③ 文档里那张八级表要跟 typography.js 对得上。它是人读的那一份，
//    但人读的那份不准的时候，改代码的人会照文档改 —— 色值就是这么错过的
const fsDoc = {}
for (const m of doc.matchAll(/\|\s*`--fs-([a-z]+)`\s*\|\s*`(\d+)`/g)) fsDoc[m[1]] = Number(m[2])
const fsDiff = []
for (const name of new Set([...LADDER, ...Object.keys(fsDoc)])) {
  if (fsDoc[name] !== FS_BASE[name]) {
    fsDiff.push(`--fs-${name}：文档 ${fsDoc[name] ?? '（没有）'} vs typography.js ${FS_BASE[name] ?? '（没有）'}`)
  }
}
fsDiff.forEach((o) => L(`    ✗ ${o}`))
chk(fsDiff.length === 0, `design-tokens.md 的 ${LADDER.length} 级梯子与 typography.js 一致`)

// ④ SCSS 里不许再冒出 $fs-*。它一旦回来就是第二份数字，
//    而飘开的表现是「有几处文字不跟着放大」，眼睛几乎发现不了
const scssFs = [...scss.matchAll(/^\$fs-[a-z]+:/gm)].length
chk(scssFs === 0, 'uni.scss 里没有 $fs-* 变量（字号只有 typography.js 一个源）')

const fsOffenders = []
for (const file of walk(join(root, 'src'))) {
  const rel = relative(root, file).replace(/\\/g, '/')
  if (rel === 'src/styles/tokens.scss' || rel === 'src/uni.scss') continue
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const m = line.match(/font-size:\s*([^;]+);/)
    if (!m) return
    const v = m[1].trim()
    const named = v.match(/^var\(--fs-([a-z]+)\)$/)
    if (named && LADDER.includes(named[1])) return
    if (v === 'inherit') return // 全局 button 重置用的，不是新字号
    fsOffenders.push(`${rel}:${i + 1} font-size: ${v}`)
  })
}
fsOffenders.forEach((o) => L(`    ✗ ${o}`))
chk(fsOffenders.length === 0, `字号全部走八级梯子的 var(--fs-*)`)

/* ============ 5. 打网络的页面必须有失败态 ============ */
//
// 收口前三屏漏了失败态，而漏掉的表现各不相同、都很难发现：
//   · 任务页把「拉失败」渲染成「现在没有可以做的事」——**把失败伪装成空**
//   · 「我的」失败后显示 `0/0 次教案` 和「还没有记到什么」——两句都是假的
//   · 兑换页干脆没有加载态，await 那段是一屏能打字的空表单，随后自己跳走
//
// 共同点是**它们都不报错**，看起来完全正常。所以这条规则查的不是「写对了没有」，
// 而是「有没有写」：页面 import 了 api/，就必须在模板里出现 <s-state>。
//
// 例外必须带理由写在下面那张表里 —— 一个没有理由的豁免过两个月就分不清
// 是「想过了」还是「忘了」。

L('\n=== 5. 打网络的页面必须有失败态 ===')

/**
 * 不用 <s-state> 的页面，和为什么。
 *
 * 前三条的共同理由：**失败发生在她手上还握着的表单上**。
 * 换掉整屏会把她刚打进去的东西一起扔掉 —— 那比一个 toast 糟得多。
 * 这类地方正确的做法就是 toast/弹框 + 把表单原样留住。
 */
const STATE_EXEMPT = {
  'src/pages/agreement/agreement.vue': '一屏静态文字，没有可失败的读取',
  'src/pages/redeem/redeem.vue':
    '失败都发生在她填好码之后。整屏换掉会把码扔了，所以走 toast，表单原样留着',
  'src/pages/generating/generating.vue':
    '动作在 dock 里，而且「断网接着等」和「重新生成」要两个不同的按钮（一个不花钱一个花钱）',
}

const missingState = []
const brokenExempt = []
for (const file of walk(join(root, 'src/pages'))) {
  const rel = relative(root, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  if (!/from '\.\.\/\.\.\/(api|stores)\//.test(text)) continue

  if (rel in STATE_EXEMPT) {
    // 豁免不等于可以完全不管失败。至少得看得见它在处理
    if (!/showApiError|failed|loadError|booting/.test(text)) brokenExempt.push(rel)
    continue
  }
  if (!text.includes('<s-state')) missingState.push(rel)
}
missingState.forEach((o) => L(`    ✗ ${o} 会打网络，但模板里没有 <s-state>，也不在豁免表里`))
brokenExempt.forEach((o) => L(`    ✗ ${o} 在豁免表里，但看不出它处理了失败`))
chk(missingState.length === 0 && brokenExempt.length === 0, '每个打网络的页面都处理了失败')
L(`    （${Object.keys(STATE_EXEMPT).length} 屏走 toast 而不是整屏换掉，理由写在脚本里）`)

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`)
process.exit(failed === 0 ? 0 : 1)
