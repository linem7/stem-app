/**
 * 开发用：造一个已激活、已同意协议的假账号，并把它写进 `.env.development.local`。
 *
 * 🔴 **临时脚本，网页端的激活页（redeem）搬过来之后就删掉。**
 *
 * 为什么需要它：DEV_FAKE_LOGIN 登进来的是一个全新老师，`gate()` 判她「还没激活」，
 * 首页会跳去 /redeem —— 而那一页还没搬（要等后端的手机号 + 密码那套身份模型）。
 * 没有它，主链路（首页 → 引导 → 生成 → 成稿）在浏览器里一步都走不了。
 *
 *   npm run dev:account
 *
 * ⚠️ 这条命令**要另开一个窗口跑**：`npm run dev` 是个服务器，会一直占着它那个窗口。
 *
 * 写完 .env.development.local，vite 自己会重启一次，浏览器刷新就是激活好的账号 ——
 * 不用往控制台里粘任何东西。
 *
 * ⚠️ 它建的园叫「契约测试园_xxx」，所以 `backend/scripts/cleanup-test-data.mjs`
 * **会把这个账号一起删掉**。清完库再跑一次这条命令就行。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.API_BASE || 'http://localhost:3000'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456'

process.env.VITE_API_BASE = `${BASE}/v1`
process.env.VITE_DEV_FAKE_LOGIN = 'true'

const RND = String(Date.now()).slice(-8)
const OPENID = `web_${RND}`

/* ============ 后台那半边：建园 → 导名单 → 建码 ============ */

const adminLogin = await fetch(`${BASE}/admin/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
}).then((r) => r.json())
if (!adminLogin.ok) throw new Error(`管理后台登录失败：${adminLogin.error?.message}`)
const tok = adminLogin.data.token

const post = (p, body) =>
  fetch(`${BASE}/admin/api${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  }).then((r) => r.json())

// 园所名字带「契约测试园」这个前缀，`backend/scripts/cleanup-test-data.mjs` 认得出来
const kg = await post('/kindergartens', { name: `契约测试园_${RND}` })
const imp = await post('/roster/import', {
  text: `网页联调老师${RND}, 中一班, 主班, 中班`,
  kindergarten_id: kg.data.id,
  dry_run: false,
})
if (!imp.ok) throw new Error(`导名单失败：${imp.error?.message}`)
const made = await post('/codes', {
  kindergarten_id: kg.data.id,
  init_text: 20,
  init_image: 10,
  grant_reason: '网页端联调',
})
if (!made.ok) throw new Error(`建码失败：${made.error?.message}`)

/* ============ 老师那半边：登录 → 兑码 → 同意协议 ============ */

const storageMod = await import('../src/utils/storage.js')
storageMod.writeLocal('stem_dev_openid', `dev:${OPENID}`)

const authApi = await import('../src/api/auth.js')
await authApi.login()
await authApi.redeem(made.data.code, imp.data.created[0].id)
await authApi.agree()

/* ============ 写进 .env.development.local ============ */

/*
  写 `.env.development.local` 而不是 `.env.development`：
  这个假 openid **每台机器不一样**，提交进 git 等于让下一个人拿到一个指向
  不存在账号的配置 —— 而那个配置的表现是「首页跳去还没搬的 /redeem」，不报错。
  `.env.*.local` 已经在 .gitignore 里，Vite 加载它的优先级也比 .env.development 高。

  ⚠️ CLAUDE.md 里有一条「别再用 .env.development.local 覆盖 VITE_API_BASE」——
  那条针对的是 API_BASE：它会把小程序包里的后端地址也改掉，而那个文件被 gitignore
  挡着、谁都看不见它干了什么。这里不一样：变量只在开发期假登录时读，
  而且这个脚本每次都把写了什么打出来。
*/
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.development.local')
const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
const line = `VITE_DEV_OPENID=${OPENID}`
writeFileSync(
  envPath,
  /^VITE_DEV_OPENID=.*$/m.test(text)
    ? text.replace(/^VITE_DEV_OPENID=.*$/m, line)
    : `${text.trimEnd()}\n${line}\n`.trimStart()
)

console.log(`\n激活好了：${OPENID}（20 次教案 / 10 张配图，园所 契约测试园_${RND}）`)
console.log('已经写进 .env.development.local（本机文件，不进 git），vite 会自己重启。**刷新浏览器**就行。')
