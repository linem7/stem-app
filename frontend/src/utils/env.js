/**
 * 环境变量的唯一读取口。
 *
 * Vite 打包时把 import.meta.env 换成字面量；契约测试脚本是用 node 直接 import 这些模块的，
 * 那边 import.meta.env 是 undefined，所以 || {} 兜一下，两边都能读。
 */
const viteEnv = import.meta.env || {}
const nodeEnv = (typeof process !== 'undefined' && process.env) || {}

const pick = (key) => viteEnv[key] ?? nodeEnv[key] ?? ''

/**
 * 后端地址。
 *
 * 默认是**相对路径** `/v1`，两种场景都对：
 *   开发   浏览器打到 vite（5173），vite 代理转给后端（3000）—— 见 vite.config.js
 *   上线   前端产物和后端是同一个域名同一个端口（CLAUDE.md 的部署决定）
 *
 * 只有「前后端不同源」时才需要配 VITE_API_BASE 成完整地址，
 * 而那时后端也得开 CORS —— 两件事要一起做，别只改这一个。
 */
export const API_BASE = pick('VITE_API_BASE') || '/v1'

/**
 * 开发期假登录。
 *
 * 微信那套 wx.login 在网页里不存在，而手机号 + 密码的新身份模型后端还没做
 * （ADR-002）。开着它，前端拿一个固定的假 openid 走后端的 DEV_FAKE_LOGIN 分支，
 * 界面就能跑起来。**上线前 .env.production 里不许出现这一项**，
 * 后端那边 NODE_ENV=production 时也会自己关掉。
 */
export const DEV_FAKE_LOGIN = String(pick('VITE_DEV_FAKE_LOGIN')) === 'true'

/**
 * 假登录用哪个身份。空串就随机造一个新的（存在本机，下次还是它）。
 *
 * 有这一项是因为**随机造出来的那个老师没激活**，`gate()` 会把首页跳去 `/redeem`，
 * 而那一页要等后端的手机号 + 密码模型才搬得过来。
 * `npm run dev:account` 造一个激活好的账号，顺手把它写进 `.env.development`。
 */
export const DEV_OPENID = pick('VITE_DEV_OPENID')
