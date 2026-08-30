/**
 * 本机存储。三个调用方：登录令牌（request.js）、字号与模式偏好（stores/prefs.js）、
 * 开发期假 openid（api/auth.js）。
 *
 * 包一层是为了两件事：
 *
 * 1. **读写都不许抛异常**。隐私模式下 localStorage 存在但 setItem 会抛，
 *    而这三样全是「有更好、没有也能用」的东西 —— 一个偏好把整页拦住是不划算的
 * 2. **node 里也能跑**。`scripts/api-contract-test.mjs` 直接 import 真的 src/api，
 *    那边没有 localStorage。退到内存 Map，一次进程内照样连贯
 */

const memory = new Map()

function backend() {
  try {
    return globalThis.localStorage || null
  } catch (e) {
    // Safari 隐私模式下访问 localStorage 本身就可能抛
    return null
  }
}

export function readLocal(key) {
  const ls = backend()
  if (!ls) return memory.get(key) ?? ''
  try {
    return ls.getItem(key) ?? ''
  } catch (e) {
    return memory.get(key) ?? ''
  }
}

export function writeLocal(key, value) {
  memory.set(key, value)
  const ls = backend()
  if (!ls) return
  try {
    ls.setItem(key, value)
  } catch (e) {
    // 写不进去也让这一次生效 —— 内存那份已经记下了
  }
}

export function removeLocal(key) {
  memory.delete(key)
  const ls = backend()
  if (!ls) return
  try {
    ls.removeItem(key)
  } catch (e) {
    /* 同上 */
  }
}
