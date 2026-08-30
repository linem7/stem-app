/**
 * 小程序编译产物体检。
 *
 * 查的是「源码看着没问题、编译成小程序才出事」的那一类，靠读源码发现不了。
 * 每条规则底下都写了它是因为什么真实事故加的。
 *
 *   node scripts/mp-lint.mjs            # 默认查 dist/dev/mp-weixin
 *   node scripts/mp-lint.mjs dist/build/mp-weixin
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dist = join(root, process.argv[2] || 'dist/dev/mp-weixin')

let failed = 0
const L = console.log
const chk = (cond, msg) => {
  L(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failed++
}

function walk(dir, ext, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, ext, out)
    else if (full.endsWith(ext)) out.push(full)
  }
  return out
}

if (!existsSync(dist)) {
  L(`没有编译产物：${dist}\n先跑 npm run dev:mp-weixin 或 build:mp-weixin`)
  process.exit(1)
}

/* ============ 1. 自定义组件不许用原生事件名接事件 ============ */
//
// 事故：s-option / s-button 对外 $emit('tap')，父级写 @tap 编译成 bindtap。
// 小程序里自定义组件是真实节点（uni 没开 virtualHost），组件内部那个 view 的
// 原生 tap 会冒泡穿过组件节点打到父级 bindtap 上；triggerEvent('tap') 又打一次。
// 处理器跑两遍 = 选中后立刻被取消，引导页除年龄班外三道题一个都选不上。
// 查了三轮才找到，因为源码层面完全看不出来。

L('=== 1. 自定义组件的事件名不许撞原生事件 ===')
const NATIVE_EVENTS = ['tap', 'touchstart', 'touchmove', 'touchend', 'longpress', 'longtap']
const offenders = []
for (const file of walk(dist, '.wxml')) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/<(s-[a-z-]+)\b([^>]*)>/g)) {
    const [, tag, attrs] = m
    for (const ev of NATIVE_EVENTS) {
      if (new RegExp(`\\bbind:?${ev}\\s*=`).test(attrs)) {
        offenders.push(`${relative(dist, file).replace(/\\/g, '/')}: <${tag} bind${ev}>`)
      }
    }
  }
}
if (offenders.length) [...new Set(offenders)].forEach((o) => L(`    ✗ ${o}`))
chk(offenders.length === 0, '没有自定义组件用 bindtap 之类接事件（会触发两遍）')

/* ============ 2. v-for 的 key 在同一页里不许重复 ============ */
//
// 事故：选项行写 :key="o.key"，四道题各有一个 A/B/C。
// uni-app 按「同一处模板 + 同一个 key」缓存事件处理器，四题的 A 共用一个，
// 点第 2/3/4 题的选项实际调的是第 1 题的 handler。

L('\n=== 2. 事件处理器的缓存 key 不许重复 ===')
const dupKeys = []
for (const file of walk(dist, '.js')) {
  if (file.includes('common')) continue
  const text = readFileSync(file, 'utf8')
  // common_vendor.o(fn, key) —— 抓出所有字面量 key
  const keys = [...text.matchAll(/common_vendor\.o\([^,]*,\s*"([^"]+)"\)/g)].map((m) => m[1])
  const seen = new Set()
  for (const k of keys) {
    if (seen.has(k)) dupKeys.push(`${relative(dist, file).replace(/\\/g, '/')}: key "${k}" 出现多次`)
    seen.add(k)
  }
}
if (dupKeys.length) [...new Set(dupKeys)].forEach((d) => L(`    ✗ ${d}`))
chk(dupKeys.length === 0, '同一页里没有重复的字面量 handler key')

/* ============ 2.5 <block> 上不许有 wx:key ============ */
//
// 事故：成稿页写了 <template v-for="k in STEAM_KEYS" :key="k">，
// 编译成 <block wx:for wx:key="i">。WXML **不允许**在 <block> 上写 wx:key。
// uni 构建一声不吭、这边所有测试全绿，只有微信开发者工具会拒，
// 而且只说一句「WXML 文件编译错误」，不告诉你是哪个文件哪一行。
// 结论：v-for 要循环一组元素时用 <view v-for>，别用 <template v-for :key>。

L('\n=== 2.5 <block> 上不许有 wx:key ===')
const blockKeys = []
for (const file of walk(dist, '.wxml')) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/<block\b[^>]*>/g)) {
    if (/\bwx:key\s*=/.test(m[0])) {
      blockKeys.push(`${relative(dist, file).replace(/\\/g, '/')}: ${m[0].slice(0, 60)}`)
    }
  }
}
blockKeys.forEach((b) => L(`    ✗ ${b}`))
chk(blockKeys.length === 0, '没有 <block wx:key>（微信会拒，uni 不报错）')

/* ============ 3. pages.json 里的每一页都要真的编译出来 ============ */

L('\n=== 3. 路由与编译产物对得上 ===')
const appJson = JSON.parse(readFileSync(join(dist, 'app.json'), 'utf8'))
const missing = appJson.pages.filter((p) => !existsSync(join(dist, `${p}.wxml`)))
missing.forEach((p) => L(`    ✗ ${p} 没有编译产物`))
chk(missing.length === 0, `${appJson.pages.length} 个页面全部编译出来了`)

/* ============ 4. 页面不许是「一片空白」 ============ */
//
// 事故：generating 是一行裸文字、没让状态栏，跳过去看起来就是整屏奶油白，
// 被当成「没跳转」，白查了两轮。占位屏也必须一眼看得出是一屏。

L('\n=== 4. 页面不能编译成近乎空白 ===')
const thin = []
for (const p of appJson.pages) {
  const f = join(dist, `${p}.wxml`)
  if (!existsSync(f)) continue
  const text = readFileSync(f, 'utf8')
  if (text.length < 160) thin.push(`${p} (${text.length} 字节)`)
}
thin.forEach((t) => L(`    ✗ ${t} —— 内容太少，跳过去大概率看着像没跳`))
chk(thin.length === 0, '每一页都有实际内容')

/* ============ 5. 源码里不许有 NUL 字节 ============ */
//
// 事故：改文件时把分隔符写成了真正的 \0，git 和 grep 从此把 guide.vue 当二进制，
// diff 退化成「Binary files differ」，最复杂的那个文件没法做 review。

L('\n=== 5. 源码没有 NUL 字节 ===')
const binary = []
for (const ext of ['.vue', '.js', '.scss', '.json']) {
  for (const f of walk(join(root, 'src'), ext)) {
    if (readFileSync(f).includes(0)) binary.push(relative(root, f).replace(/\\/g, '/'))
  }
}
binary.forEach((b) => L(`    ✗ ${b}`))
chk(binary.length === 0, 'src 下没有被当成二进制的文件')

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`)
process.exit(failed === 0 ? 0 : 1)
