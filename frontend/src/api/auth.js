/** 登录与激活 —— api-spec 第 1、1.5 节 */
import { post, setToken, ApiError } from '../utils/request.js'
import { DEV_FAKE_LOGIN, DEV_OPENID } from '../utils/env.js'
import { readLocal, writeLocal } from '../utils/storage.js'

/**
 * 拿一个能换出身份的 code。
 *
 * 🔴 **这个函数是临时的。** 网页里没有 wx.login，而手机号 + 密码的新身份模型
 * 后端还没做（ADR-002 / PRD-web「身份与账号」）。现在只有开发期假登录这一条路：
 * code 以 "dev:" 开头，后端的 DEV_FAKE_LOGIN 分支按固定 openid 处理。
 *
 * 新身份模型落地时，整个 login() 换成「手机号 + 密码」，这个函数删掉。
 */
function getLoginCode() {
  if (!DEV_FAKE_LOGIN) {
    // 关掉开关就没有可用的登录方式了。**必须当场说清楚**，
    // 否则表现是首页停在骨架屏上不动，看着像后端挂了。
    throw new ApiError({
      code: 'LOGIN_NOT_IMPLEMENTED',
      message: '网页端的登录还没做好（手机号 + 密码那套）。本地开发请把 VITE_DEV_FAKE_LOGIN 设为 true',
      retryable: false,
    })
  }
  // .env.development 里指定了就用它 —— 那是 `npm run dev:account` 激活好的那个账号。
  // 不指定就随机造一个，但**造出来的没激活**，首页会跳去还没搬的 /redeem
  if (DEV_OPENID) return `dev:${DEV_OPENID}`

  // 同一台设备固定同一个假 openid，否则每次刷新都是新老师，激活状态一直丢
  let devId = readLocal('stem_dev_openid')
  if (!devId) {
    devId = `dev:${Math.random().toString(36).slice(2, 10)}`
    writeLocal('stem_dev_openid', devId)
  }
  return devId
}

/**
 * 静默登录。返回 teacher，其中 activated / agreed 两位决定落在哪个页。
 * 响应里永远没有 phone 和 real_name —— 包括老师自己的（operations.md 的铁律）。
 */
export async function login(profile = {}) {
  const code = getLoginCode()
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
 * 首次激活（还要一个 `roster_entry_id`：她从名单里选的那个位置）、
 * 续兑（只要码）、换绑（挪 openid，回一个新 token）。
 *
 * 输入宽容由后端负责（大小写、空格、下划线、各种横线都认），
 * 前端**不做任何格式校验** —— 认不出来是我们的问题，不是老师的。
 */
export function redeem(code, rosterEntryId) {
  return post('/auth/redeem', { code, roster_entry_id: rosterEntryId })
}

/**
 * 激活那一屏的选择器：先拿有空位的园，再拿那个园里的位置。
 *
 * **必须带码** —— 后端靠它挡住「任何人打开小程序就能看到一整个园的老师名单」。
 * 回来的姓名只有姓氏。
 */
export function rosterOptions(code, kindergartenId) {
  return post('/auth/roster/options', { code, kindergarten_id: kindergartenId })
}

/** 同意协议。激活后、进主流程前必须调一次。 */
export function agree() {
  return post('/me/agree')
}
