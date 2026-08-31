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

import { API_BASE } from './env.js'
import { readLocal, writeLocal, removeLocal } from './storage.js'

const TOKEN_KEY = 'stem_token'

/**
 * 后端的 message 是「可直接展示给老师的中文文案」，前端不许自己拼错误话术
 * —— 话术统一在后端，改措辞不用重新发版（api-spec 第 0 节）。
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
  if (!token) token = readLocal(TOKEN_KEY)
  return token
}

export function setToken(value) {
  token = value || ''
  if (token) writeLocal(TOKEN_KEY, token)
  else removeLocal(TOKEN_KEY)
}

export function clearToken() {
  setToken('')
}

/**
 * 401 的兜底处理。stores/session.js 注册一次：清掉本地态、重新登录。
 * 放成回调而不是在这里直接写跳转，是为了不让请求层依赖具体页面路径。
 */
let authExpiredHandler = null
export function onAuthExpired(handler) {
  authExpiredHandler = handler
}

/* ============ 主体 ============ */

function toQuery(data) {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

/**
 * @param {object} opts
 * @param {string} opts.method  GET | POST | PATCH | DELETE
 * @param {string} opts.path    以 / 开头，相对 API_BASE
 * @param {object} [opts.data]  GET 时作为 query，其余作为 JSON body
 * @param {number} [opts.timeout]
 * @param {boolean} [opts.auth] 默认 true；登录接口传 false
 * @returns {Promise<object>}   已拆掉信封的 data
 */
export async function request({ method = 'GET', path, data, timeout = 20000, auth = true }) {
  let url = API_BASE + path
  let body
  const headers = {}

  if (method === 'GET') {
    if (data) {
      const qs = toQuery(data)
      if (qs) url += (url.includes('?') ? '&' : '?') + qs
    }
  } else if (data !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(data)
  }

  if (auth) {
    const t = getToken()
    if (t) headers.Authorization = `Bearer ${t}`
  }

  /*
    「超时」和「网络断了」对老师是两件事（一件她只能等，一件她能走到有信号的地方去），
    所以两个 code 必须分得开。fetch 被 abort 和 fetch 自己失败抛的是同一种异常，
    只能靠这个标志区分 —— 光看 err.name === 'AbortError' 不够：
    页面卸载时我们也会 abort，那时候不该报「等太久了」。
  */
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)

  let res
  try {
    res = await fetch(url, { method, headers, body, signal: controller.signal })
  } catch (err) {
    throw new ApiError({ ...(timedOut ? TIMEOUT_ERROR : NETWORK_ERROR) })
  } finally {
    clearTimeout(timer)
  }

  // 后端没按约定返回信封（被网关/代理截了、或者路径写错吃到了 HTML）。
  // 这时 body 里没有可展示的中文，只能给一句兜底。
  let payload
  try {
    payload = await res.json()
  } catch (err) {
    payload = null
  }
  if (!payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
    throw new ApiError({ ...NETWORK_ERROR, http: res.status })
  }

  if (payload.ok) return payload.data

  const err = new ApiError({ ...payload.error, http: res.status })
  if (err.code === 'UNAUTHORIZED') {
    clearToken()
    if (authExpiredHandler) authExpiredHandler(err)
  }
  throw err
}

export const get = (path, data, opts) => request({ method: 'GET', path, data, ...opts })
export const post = (path, data, opts) => request({ method: 'POST', path, data, ...opts })
export const patch = (path, data, opts) => request({ method: 'PATCH', path, data, ...opts })
export const del = (path, data, opts) => request({ method: 'DELETE', path, data, ...opts })
