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

/*
  这里原来还有两项：`DEV_FAKE_LOGIN` 和 `DEV_OPENID`（开发期假 openid 登录）。
  手机号 + 密码落地之后（2026-09-20）连同后端的 DEV_FAKE_LOGIN 分支、
  `scripts/dev-activate.mjs` 一起删掉了 —— 本地和线上现在是同一条路。
*/
