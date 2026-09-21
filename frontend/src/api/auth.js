/** 登录与激活 —— api-spec 第 1、1.5 节 */
import { post, setToken } from '../utils/request.js'

/**
 * 手机号 + 密码登录。**换设备、清缓存之后走这条。**
 *
 * 手机号在这个系统里只是用户名 —— 不用于联系、不进 AI 提示词、不下发到页面、不进日志。
 * 所以这里不弹「登录过期」这类框，也不用存它到任何地方：她自己知道那个号。
 *
 * `auth: false` 是必须的：这次请求本身还没有 token，
 * 而它回的 401 意思是「手机号或密码不对」，不是「登录态失效」。
 * 带上 auth 的话，输错密码会被当成掉线处理，错误提示一闪就被弹走。
 */
export async function login(phone, password) {
  const data = await post('/auth/login', { phone, password }, { auth: false })
  setToken(data.token)
  return data
}

/**
 * 首次激活：一个码 + 她是谁 + 自己设的手机号密码。
 *
 * **两条路**（2026-09-21 新增第二条），由 `rosterEntryId` 有没有传决定：
 *
 *   路径一：`rosterEntryId` 有值 —— 白名单里的老师，从四级下拉认领一个位置
 *   路径二：不传 —— 不在名单的人，`self` 里带她填的姓名/园所/省市区/园所类型
 *
 * **手机号传两遍，两条路都一样。** 11 位打错一位是常事，而后果特别隐蔽 ——
 * 她下次登录输的是**正确的号**、库里存的是**打错的号**，进不去，
 * 且她完全不知道哪里出了问题。后端也会再比一次，两边都守。
 *
 * 建完账号直接就有一个 token（后端回的），她不用立刻再用一次密码。
 *
 * @param {object} o
 * @param {string} o.code
 * @param {number} [o.rosterEntryId] 路径一必填
 * @param {object} [o.self] 路径二必填：{surname, province, city, ownership}
 *   🔴 **只要姓氏，不收全名**（2026-09-21 用户定）；**也不填园所名**。
 *   ⚠️ 字段名是 `surname` 不是 `realName` —— 后端认的是 `req.body.surname`，
 *   传错了的表现是「填了姓氏，却报『填一下你的姓氏』」。
 */
export async function activate({
  code, rosterEntryId, self, phone, phoneConfirm, password,
}) {
  const data = await post(
    '/auth/activate',
    {
      code,
      roster_entry_id: rosterEntryId,
      // 路径二那几样**不传就是 undefined**，JSON.stringify 会整个丢掉，
      // 所以路径一不会带上多余的字段
      surname: self?.surname,
      province: self?.province,
      city: self?.city,
      ownership: self?.ownership,
      phone,
      phone_confirm: phoneConfirm,
      password,
    },
    { auth: false }
  )
  setToken(data.token)
  return data
}

/**
 * 激活那一屏的选择器：省 → 市 → 园 → 位置，四级。
 *
 * **必须带码** —— 后端靠它挡住「任何人打开网页就能看到一整个园的老师名单」。
 * 回来的姓名只有姓氏。
 *
 * 给到哪一级就回哪一级，判据是**最后一个有值的参数**：
 *
 *   rosterOptions(code)                    → { regions }
 *   rosterOptions(code, {province})        → { cities }
 *   rosterOptions(code, {province, city})  → { kindergartens }
 *   rosterOptions(code, {kindergartenId})  → { entries }
 *
 * ⚠️ `kindergartenId` 是**独立的一路**（不是 province/city 的下一级），
 * 因为它对应「已经在园里选人」那个状态。两者的关系是「谁先谁后」，
 * 不是「同一组参数的深浅」。
 */
export function rosterOptions(code, { province, city, kindergartenId } = {}) {
  return post(
    '/auth/roster/options',
    {
      code,
      province,
      city,
      kindergarten_id: kindergartenId,
    },
    { auth: false }
  )
}

/**
 * 续兑：**只要码**。她已经登录了，身份一个字段都不动。
 *
 * ⚠️ 这个跟激活是**两个不同的接口**，因为调用它们的人不同：
 * 续兑的人已经登录（token 带着），激活的人还没有账号。
 * 老师端看到的都是一个输入框，分岔在代码里，不在她的操作里。
 *
 * 输入宽容由后端负责（大小写、空格、下划线、各种横线都认），
 * 前端**不做任何格式校验** —— 认不出来是我们的问题，不是老师的。
 */
export function redeem(code) {
  return post('/auth/redeem', { code })
}

/** 同意协议。激活后、进主流程前必须调一次。 */
export function agree() {
  return post('/me/agree')
}
