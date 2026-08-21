/** 老师档案、额度、记忆 —— api-spec 第 1.5、2、8 节 */
import { get, post, del } from '../utils/request.js'

/** 返回 teacher 对象（含 activated / agreed / profile_completed） */
export function getMe() {
  return get('/me')
}

/**
 * 改档案。只传要改的字段（后端白名单，只认园所 / 年龄班 / 教龄 / 昵称 / 头像 / 偏好）。
 *
 * 走 `POST /me/update` 而不是语义正确的 PATCH —— **wx.request 发不出 PATCH**。
 * 后端两个方法指向同一个 handler（同 memories，见 routes/me.js 的注释）。
 */
export function updateMe(fields) {
  return post('/me/update', fields)
}

/** 余额 + 台账。grants 是给老师自己看的对账明细，额度不能是黑箱。 */
export function getQuota() {
  return get('/me/quota')
}

/**
 * 注销：删掉我的全部数据。**不可逆**。
 *
 * 后端做的是「留壳去身份」：对话、教案、配图、记忆连同姓名一起删掉，
 * 只留一行没有身份的壳，用来认出「这个人注销过」并拒绝她再次登录 ——
 * 这是「删完就不能再用」那句承诺的技术兑现。
 * 已经用于科研的部分（提交过的建议和评价）留着，但不再关联到姓名。
 * 她在名单上那个**位置**放回「等她来认领」—— 位置是园所的，不是她的
 * （明年这个班还有主班，只是换了人）。
 */
export function deleteMyAccount() {
  return del('/me')
}

/* ============ 记忆 ============ */
// 写入是后端自动的（教案生成后异步提取），但删改权必须完全在老师手里 —— 这是隐私底线。

export function listMemories() {
  return get('/memories')
}

/** 手动添加的自动 is_pinned = true，不参与自动淘汰 */
export function addMemory(fact) {
  return post('/memories', { fact })
}

/**
 * 改一条记忆。
 *
 * 走 `POST /memories/:id/update` 而不是语义正确的 PATCH ——
 * **wx.request 发不出 PATCH**，请求层会直接拦下来。后端两个方法都收，
 * 指向同一个 handler（见 routes/memories.js 的注释）。
 */
export function updateMemory(id, fact) {
  return post(`/memories/${id}/update`, { fact })
}

export function removeMemory(id) {
  return del(`/memories/${id}`)
}
