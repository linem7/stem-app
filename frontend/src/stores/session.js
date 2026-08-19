/**
 * 会话态：登录、老师档案、激活/协议两位状态。
 *
 * 没上 pinia —— 全局要共享的状态只有这一份，一个 reactive 对象够了。
 * 技术选型的原则跟后端一致：能不加的依赖就不加。
 */
import { reactive } from 'vue'
import { login as apiLogin, redeem as apiRedeem, agree as apiAgree } from '../api/auth.js'
import { getMe } from '../api/me.js'
import { clearToken, getToken, setToken, onAuthExpired } from '../utils/request.js'

export const session = reactive({
  /** null 表示还没登录成功 */
  teacher: null,
  /** 启动流程走完没有。为 false 时页面应该显示骨架屏而不是空白 */
  ready: false,
  /** 启动失败时的 ApiError，页面据此显示「重试」 */
  bootError: null,
})

/**
 * 老师现在该待在哪。
 *  redeem    —— 还没用兑换码激活
 *  agreement —— 激活了但没同意协议
 *  main      —— 可以进主流程
 */
export function gate() {
  const t = session.teacher
  if (!t) return 'redeem' // 还没登上，当作没激活处理，页面会先显示加载态
  if (!t.activated) return 'redeem'
  if (!t.agreed) return 'agreement'
  return 'main'
}

/** 启动：静默登录，拿到 teacher。App.vue onLaunch 调一次。 */
export async function bootstrap() {
  session.bootError = null
  try {
    if (getToken()) {
      // 有 token 先试着直接拉档案，省一次 wx.login
      session.teacher = await getMe()
    } else {
      const data = await apiLogin()
      session.teacher = data.teacher
    }
  } catch (err) {
    // token 过期时 request 层已经清掉了，这里重登一次
    if (err.code === 'UNAUTHORIZED') {
      try {
        const data = await apiLogin()
        session.teacher = data.teacher
      } catch (retryErr) {
        session.bootError = retryErr
      }
    } else {
      session.bootError = err
    }
  }
  session.ready = true
  return session.teacher
}

/**
 * 保证「启动流程已经走完」。每个需要登录态的页面在 onLoad 里 await 一次。
 *
 * 为什么不在 App.onLaunch 里直接 reLaunch 到目标页：onLaunch 跑在首页渲染之前，
 * 那时候页面栈还没建好，跳转会时灵时不灵。改成首页自己拿到结果再决定去哪，稳定得多。
 */
let booting = null
export function ensureSession() {
  if (session.ready && session.teacher) return Promise.resolve(session.teacher)
  if (!booting) booting = bootstrap().finally(() => { booting = null })
  return booting
}

/** 重新拉一次档案。激活、同意协议、改档案之后调。 */
export async function refreshTeacher() {
  session.teacher = await getMe()
  return session.teacher
}

/**
 * 兑一个码。这一个动作在后端是三件事（api-spec 第 1.5 节）：
 * 首次激活（要手机号）、续兑（只要码）、**换绑**（她换了微信）。
 *
 * `data.token` 必须存下来 —— **换绑靠这一行才成立**：
 * 换绑把旧账号挪到新 openid 上，她手上那个 token 指向的行已经被删了，
 * 而且目标账号的 token_version 刚 +1。不存新 token，下一个请求就 401，
 * 表现是「换绑好像成功了，但一进去就被踢出来」。
 */
export async function redeem(code, phone) {
  const data = await apiRedeem(code, phone)
  if (data.token) setToken(data.token)
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

/**
 * 401 的兜底：清掉本地态，重新静默登录。
 * 不弹「登录过期」的框 —— 微信小程序里静默重登对老师是无感的，弹框只会吓到她。
 *
 * 走 ensureSession 而不是直接 bootstrap：401 常常是好几个并发请求一起回来的，
 * 每个都触发一次就会同时发好几个 wx.login，输的那几路会把 bootError 写进去，
 * 首页于是停在「网络好像断了」——其实登录是成功的。ensureSession 里的 memo 保证只跑一次。
 */
let reauthing = false
onAuthExpired(async () => {
  if (reauthing) return
  reauthing = true
  clearToken()
  session.teacher = null
  session.ready = false
  try {
    await ensureSession()
  } finally {
    reauthing = false
  }
})
