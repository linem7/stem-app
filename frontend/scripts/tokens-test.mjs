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

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`)
process.exit(failed === 0 ? 0 : 1)
