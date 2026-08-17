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

export const API_BASE = pick('VITE_API_BASE')
export const DEV_FAKE_LOGIN = String(pick('VITE_DEV_FAKE_LOGIN')) === 'true'
