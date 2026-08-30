/**
 * 请求层 —— 对应 api-spec 第 0 节的统一响应格式。
 *
 * 后端一律返回：
 *   成功  { ok: true,  data: {...} }
 *   失败  { ok: false, error: { code, message, retryable } }
 *
 * 这里把信封拆掉，成功直接给 data，失败一律 throw ApiError。
 * 调用方只要 try/catch，不用每次判断 res.ok。
 */

import { API_BASE, USE_CLOUD, WX_CLOUD_ENV, WX_CLOUD_SERVICE } from './env.js'

const TOKEN_KEY = 'stem_token'

/**
 * 后端的 message 是「可直接展示给老师的中文文案」，前端不许自己拼错误话术
 * —— 话术统一在后端，改措辞不用重新发版小程序（api-spec 第 0 节）。
 *
 * 唯一的例外是下面这两条：请求根本没到后端，后端也就没机会说话。
 */
const NETWORK_ERROR = { code: 'NETWORK', message: '网络好像断了，检查一下再试', retryable: true }
const TIMEOUT_ERROR = { code: 'TIMEOUT', message: '等太久了，再试一次', retryable: true }

export class ApiError extends Error {
  constructor({ code, message, retryable, http }) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.retryable = Boolean(retryable)
    this.http = http
  }
}

/* ============ 登录态 ============ */

let token = ''

export function getToken() {
  if (!token) token = uni.getStorageSync(TOKEN_KEY) || ''
  return token
}

export function setToken(value) {
  token = value || ''
  if (token) uni.setStorageSync(TOKEN_KEY, token)
  else uni.removeStorageSync(TOKEN_KEY)
}

export function clearToken() {
  setToken('')
}

/**
 * 401 的兜底处理。App.vue 启动时注册一次：清掉本地态、重新静默登录、回首页。
 * 放成回调而不是在这里直接写跳转，是为了不让请求层依赖具体页面路径。
 */
let authExpiredHandler = null
export function onAuthExpired(handler) {
  authExpiredHandler = handler
}

/* ============ 主体 ============ */

/**
 * @param {object} opts
 * @param {string} opts.method  GET | POST | PATCH | DELETE
 * @param {string} opts.path    以 / 开头，相对 VITE_API_BASE
 * @param {object} [opts.data]  GET 时作为 query，其余作为 JSON body
 * @param {number} [opts.timeout]
 * @param {boolean} [opts.auth] 默认 true；登录接口传 false
 * @returns {Promise<object>}   已拆掉信封的 data
 */
export function request({ method = 'GET', path, data, timeout = 20000, auth = true }) {
  // 配了云托管就走微信内部通道（免域名免备案），没配照旧走 wx.request。
  // 分流写在这一个函数里，21 个 api 文件一个都不用知道传输层换了。
  if (USE_CLOUD) return cloudRequest({ method, path, data, timeout, auth })

  // 打包时没注入后端地址，请求会发到一个相对路径上，微信那边直接 fail，
  // 表现出来跟「网络断了」一模一样 —— 真拿这个包给老师用，她会一直以为是自己的网有问题。
  // 最容易撞上的场景：build:mp-weixin 出的是上线包，而线上域名还没备案，.env.production 里就空着。
  if (!API_BASE) {
    return Promise.reject(
      new ApiError({
        code: 'NO_API_BASE',
        message: '这个包没配后端地址，连不上。开发时请用 npm run dev:mp-weixin 出的包（dist/dev/mp-weixin）',
        retryable: false,
      })
    )
  }

  // 微信 wx.request 的 method 只认 OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE/CONNECT，
  // **没有 PATCH**。api-spec 里那三个 PATCH 接口现在都有 POST 别名，
  // 前端 api 层一律走别名（memories 2026-08-18，me 和 lesson-plans 2026-08-21）：
  //
  //   PATCH /memories/:id      → POST /memories/:id/update
  //   PATCH /me                → POST /me/update
  //   PATCH /lesson-plans/:id  → POST /lesson-plans/:id/update
  //
  // 这道拦截**留着不删**：它是给下一个人的。新加接口时顺手写成 PATCH 很自然，
  // 而那样写在 H5 预览里是通的、只有微信里静默失败 —— 拦在这里会当场报出人话。
  // 真要放开得先改 api-spec.md，不在这儿偷偷绕过去。
  if (method === 'PATCH') {
    return Promise.reject(
      new ApiError({
        code: 'METHOD_UNSUPPORTED',
        message: '小程序发不出 PATCH 请求，这个接口要先改成 POST（见 api-spec）',
        retryable: false,
      })
    )
  }

  const header = { 'Content-Type': 'application/json' }
  if (auth) {
    const t = getToken()
    if (t) header.Authorization = `Bearer ${t}`
  }

  return new Promise((resolve, reject) => {
    uni.request({
      url: API_BASE + path,
      method,
      data,
      header,
      timeout,
      success(res) {
        const body = res.data

        // 后端没按约定返回信封（比如被网关/代理截了、或者路径写错吃到了 HTML）。
        // 这时 body 里没有可展示的中文，只能给一句兜底。
        if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
          reject(new ApiError({ ...NETWORK_ERROR, http: res.statusCode }))
          return
        }

        if (body.ok) {
          resolve(body.data)
          return
        }

        const err = new ApiError({ ...body.error, http: res.statusCode })
        if (err.code === 'UNAUTHORIZED') {
          clearToken()
          if (authExpiredHandler) authExpiredHandler(err)
        }
        reject(err)
      },
      fail(err) {
        const isTimeout = String(err?.errMsg || '').includes('timeout')
        reject(new ApiError({ ...(isTimeout ? TIMEOUT_ERROR : NETWORK_ERROR) }))
      },
    })
  })
}

/* ============ 云托管通道 ============ */

/**
 * 经 wx.cloud.callContainer 打到云托管容器 —— 跟 wx.request 那条的差别只有传输层：
 * 同一个信封协议、同一个 ApiError、同一套 401 兜底。
 *
 * 三个跟 wx.request 不一样、写错了只在云上坏的地方：
 *   1. GET 的 query 要**自己拼进 path**。wx.request 会把 data 转成 query，
 *      callContainer 文档只说「其余参数同 wx.request」—— 与其赌它的实现，
 *      不如自己拼，两边一定一致
 *   2. path 是相对容器根的（我们的路由挂在 /v1），不走 API_BASE
 *   3. 必须带 X-WX-SERVICE 头（环境里可以有多个服务，不带打不到人）
 */
function cloudRequest({ method, path, data, timeout, auth }) {
  if (method === 'PATCH') {
    return Promise.reject(
      new ApiError({
        code: 'METHOD_UNSUPPORTED',
        message: '小程序发不出 PATCH 请求，这个接口要先改成 POST（见 api-spec）',
        retryable: false,
      })
    )
  }

  let fullPath = `/v1${path}`
  let body = data
  if (method === 'GET' && data && typeof data === 'object') {
    const qs = Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    if (qs) fullPath += (fullPath.includes('?') ? '&' : '?') + qs
    body = undefined
  }

  const header = { 'Content-Type': 'application/json', 'X-WX-SERVICE': WX_CLOUD_SERVICE }
  if (auth) {
    const t = getToken()
    if (t) header.Authorization = `Bearer ${t}`
  }

  return wx.cloud
    .callContainer({
      config: { env: WX_CLOUD_ENV },
      path: fullPath,
      method,
      header,
      data: body,
      timeout,
    })
    .then((res) => {
      const bodyData = res.data
      if (!bodyData || typeof bodyData !== 'object' || typeof bodyData.ok !== 'boolean') {
        throw new ApiError({ ...NETWORK_ERROR, http: res.statusCode })
      }
      if (bodyData.ok) return bodyData.data

      const err = new ApiError({ ...bodyData.error, http: res.statusCode })
      if (err.code === 'UNAUTHORIZED') {
        clearToken()
        if (authExpiredHandler) authExpiredHandler(err)
      }
      throw err
    })
    .catch((err) => {
      if (err instanceof ApiError) throw err
      const isTimeout = String(err?.errMsg || '').includes('timeout')
      throw new ApiError({ ...(isTimeout ? TIMEOUT_ERROR : NETWORK_ERROR) })
    })
}

export const get = (path, data, opts) => request({ method: 'GET', path, data, ...opts })
export const post = (path, data, opts) => request({ method: 'POST', path, data, ...opts })
export const patch = (path, data, opts) => request({ method: 'PATCH', path, data, ...opts })
export const del = (path, data, opts) => request({ method: 'DELETE', path, data, ...opts })
