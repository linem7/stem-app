/** 登录与激活 —— api-spec 第 1、1.5 节 */
import { post, setToken } from '../utils/request.js'
import { DEV_FAKE_LOGIN } from '../utils/env.js'

/**
 * 拿一个可以换 openid 的 code。
 *
 * 真 AppID 还没申请，微信开发者工具用测试号时 wx.login 给的 code 后端换不到 openid，
 * 所以本地开发走后端的 DEV_FAKE_LOGIN：code 以 "dev:" 开头就按固定 openid 处理。
 * 上线前 .env.production 里把 VITE_DEV_FAKE_LOGIN 关掉，这条分支自然失效。
 */
function getLoginCode() {
  if (DEV_FAKE_LOGIN) {
    // 同一台设备固定同一个假 openid，否则每次启动都是新老师，激活状态一直丢
    let devId = uni.getStorageSync('stem_dev_openid')
    if (!devId) {
      devId = `dev:${Math.random().toString(36).slice(2, 10)}`
      uni.setStorageSync('stem_dev_openid', devId)
    }
    return Promise.resolve(devId)
  }
  return new Promise((resolve, reject) => {
    uni.login({
      provider: 'weixin',
      success: (res) => (res.code ? resolve(res.code) : reject(new Error('LOGIN_NO_CODE'))),
      fail: reject,
    })
  })
}

/**
 * 静默登录。返回 teacher，其中 activated / agreed 两位决定落在哪个页。
 * 响应里永远没有 phone 和 real_name —— 包括老师自己的（operations.md 的铁律）。
 */
export async function login(profile = {}) {
  const code = await getLoginCode()
  const data = await post(
    '/auth/login',
    { code, nickname: profile.nickname, avatar_url: profile.avatar_url },
    { auth: false }
  )
  setToken(data.token)
  return data
}

/**
 * 兑一个码。后端按码的类型决定做哪件事（api-spec 第 1.5 节）：
 * 首次激活（要手机号）、续兑（只要码）、换绑（挪 openid，回一个新 token）。
 *
 * 输入宽容由后端负责（大小写、空格、下划线、各种横线、手机号里的空格都认），
 * 前端**不做任何格式校验** —— 认不出来是我们的问题，不是老师的。
 * 尤其别在前端拦「手机号必须 11 位」：她填的可能带空格，后端会清洗。
 */
export function redeem(code, phone) {
  return post('/auth/redeem', { code, phone })
}

/** 同意协议。激活后、进主流程前必须调一次。 */
export function agree() {
  return post('/me/agree')
}
