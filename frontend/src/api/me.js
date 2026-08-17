/** 老师档案、额度、记忆 —— api-spec 第 1.5、2、8 节 */
import { get, post, patch, del } from '../utils/request.js'

/** 返回 teacher 对象（含 activated / agreed / profile_completed） */
export function getMe() {
  return get('/me')
}

/** 只传要改的字段 */
export function updateMe(fields) {
  return patch('/me', fields)
}

/** 余额 + 台账。grants 是给老师自己看的对账明细，额度不能是黑箱。 */
export function getQuota() {
  return get('/me/quota')
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

export function updateMemory(id, fields) {
  return patch(`/memories/${id}`, fields)
}

export function removeMemory(id) {
  return del(`/memories/${id}`)
}
