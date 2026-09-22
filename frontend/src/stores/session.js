/**
 * 会话态：登录、老师档案、激活/协议两位状态。
 *
 * 没上 pinia —— 全局要共享的状态只有这一份，一个 reactive 对象够了。
 * 技术选型的原则跟后端一致：能不加的依赖就不加。
 *
 * 【2026-09-20 重写】原来这里是**静默登录**：一进来自动拿一个假 openid 换 token，
 * 所以「没有 token」这件事从来没出现过，`bootstrap` 里也没有「她还没登录」这个分支。
 * 手机号 + 密码落地之后，**没登录是一个正常状态**，不是错误 ——
 * 她会落在激活页，而那一页上有一行「已经有账号？」通向登录页。
 */
import { reactive } from 'vue'
import { login as apiLogin, activate as apiActivate, redeem as apiRedeem, agree as apiAgree } from '../api/auth.js'
import { getMe } from '../api/me.js'
import { clearToken, getToken, onAuthExpired } from '../utils/request.js'

export const session = reactive({
  /** null 表示**还没登录** —— 这是正常状态，不是错误 */
  teacher: null,
  /** 启动流程走完没有。为 false 时页面应该显示骨架屏而不是空白 */
  ready: false,
  /** 启动失败时的 ApiError，页面据此显示「重试」。⚠️ 只是真失败，不含「没登录」 */
  bootError: null,
})

/**
 * 老师现在该待在哪。
 *  redeem    —— 还没登录（激活页和登录页都在这一片；她从那两边进得来）
 *  agreement —— 登录了但没同意协议
 *  main      —— 可以进主流程
 */
export function gate() {
  const t = session.teacher
  if (!t) return 'redeem'
  // 账号一律由 /auth/activate 建出来，它当场就置了 activated_at。
  // 这一句是给迁移前的老行留的兜底，正常走不到
  if (!t.activated) return 'redeem'
  if (!t.agreed) return 'agreement'
  return 'main'
}

/**
 * 启动：本地有 token 就换一份档案回来；没有就是「还没登录」。
 *
 * 🔴 **「没有 token」不能报错，也不能弹框。** 第一次来的老师就是这个状态，
 * 弹一个「登录失败」只会吓到她 —— 她还没做错任何事。
 */
export async function bootstrap() {
  session.bootError = null
  try {
    if (getToken()) {
      session.teacher = await getMe()
    }
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') {
      // token 过期或被换掉了。**不是错误**，当作没登录处理
      clearToken()
      session.teacher = null
    } else {
      // 网络断了、后端 500 —— 这个要让她看见，否则她会以为是自己填错了
      session.bootError = err
    }
  }
  session.ready = true
  return session.teacher
}

/**
 * 保证「启动流程已经走完」。每个需要登录态的页面在 onMounted 里 await 一次。
 *
 * ⚠️ 判据是 `session.ready`，**不是** `session.ready && session.teacher`。
 * 后者在「没登录」时会每次重新跑一遍 bootstrap ——
 * 而没登录是正常状态，不是「还没启动完」。
 */
let booting = null
export function ensureSession() {
  if (session.ready) return Promise.resolve(session.teacher)
  if (!booting) booting = bootstrap().finally(() => { booting = null })
  return booting
}

/** 重新拉一次档案。激活、同意协议、改档案之后调。 */
export async function refreshTeacher() {
  session.teacher = await getMe()
  return session.teacher
}

/** 手机号 + 密码登录。换设备、清缓存之后走这条。 */
export async function login(phone, password) {
  const data = await apiLogin(phone, password)
  session.teacher = data.teacher
  session.ready = true
  return data
}

/**
 * 首次激活：码 + 名单 + 手机号 + 密码。
 *
 * 后端建完账号直接回一个 token（见 api/auth.js），所以这里不用再登一次 ——
 * 她刚设完密码就要求她立刻用那个密码登录，是在考她记没记住。
 */
export async function activate(payload) {
  const data = await apiActivate(payload)
  session.teacher = data.teacher
  session.ready = true
  return data
}

/**
 * 续兑：只要码，只加额度，**身份一个字段都不动**。
 *
 * 她已经在登录态里了，所以这个走的是另一个接口（/auth/redeem）。
 * 老师端看到的都是一个输入框，分岔在代码里，不在她的操作里。
 */
export async function redeem(code) {
  const data = await apiRedeem(code)
  if (data.teacher) session.teacher = data.teacher
  else await refreshTeacher()
  return data
}

export async function agree() {
  const data = await apiAgree()
  if (data.teacher) session.teacher = data.teacher
  else await refreshTeacher()
  return data
}

/** 退出登录：只清本机。后端那边没有「会话」这个东西，token 到期自己作废。 */
export function logout() {
  clearToken()
  session.teacher = null
  session.bootError = null
  session.ready = true
}

/**
 * 401 的兜底：带着 token 发出去的请求被拒了，说明登录态没了。
 *
 * 这里**只清状态，不跳转** —— 跳转在 App.vue，它 watch 的正是 `session.teacher`
 * 变成 null 这一下。原因写在那边：这个模块会被 node 跑的契约测试直接 import，
 * 而跳转要经过 vue-router，那玩意儿在 node 里当场抛。
 * 不弹「登录过期」的框：她要的是「怎么进去」，不是「为什么进不去」，
 * 而激活页第一行就写着两条路。
 */
onAuthExpired(() => {
  clearToken()
  session.teacher = null
  session.ready = true
})
