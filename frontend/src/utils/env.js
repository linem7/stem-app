/**
 * 环境变量的唯一读取口。
 *
 * Vite 打包时把 import.meta.env 换成字面量；契约测试脚本是用 node 直接 import 这些模块的，
 * 那边 import.meta.env 是 undefined，所以 || {} 兜一下，两边都能读。
 *
 * ⚠️ 不要写成 `typeof import.meta !== 'undefined' && import.meta.env`。
 * 那个 typeof 会逼 Vite 把 import.meta 本身也实体化，生成一段带 document.currentScript
 * 和 require('url') 的垫片 —— 小程序运行时这两样都不存在，一进来就炸。
 * 直接访问 .env 才会被静态替换掉。
 */
const viteEnv = import.meta.env || {}
const nodeEnv = (typeof process !== 'undefined' && process.env) || {}

const pick = (key) => viteEnv[key] ?? nodeEnv[key] ?? ''

/* 两个平台要的地址形状不一样，所以按平台分流：
   H5 预览走 vite 的同源代理（后端没配 CORS），地址必须是相对路径 `/v1`；
   小程序的 `wx.request` **不接受相对路径**，必须是带 http(s):// 的完整地址。

   🔴 别再用 `.env.development.local` 覆盖 VITE_API_BASE 来达成这件事（2026-08-25 撤掉）。
   Vite 对 mode=development **一律**加载 `.env.development.local`，而它优先级最高 ——
   小程序那一侧跟着被改成 `/v1`，编译出来的包在微信里连不上后端。
   两处注释当时都写着「小程序不读这个文件」，而实测产物里烧的就是 `/v1`。
   更难查的是：`request.js` 那道 `if (!API_BASE)` 的友好提示挡不住它（`/v1` 不是空串），
   老师看到的是一个原始的 wx.request 报错；而那个文件被 .gitignore 挡着，谁都看不见它干了什么。 */
let apiBase = pick('VITE_API_BASE')
// #ifdef H5
apiBase = pick('VITE_H5_API_BASE') || apiBase
// #endif

export const API_BASE = apiBase
export const DEV_FAKE_LOGIN = String(pick('VITE_DEV_FAKE_LOGIN')) === 'true'
