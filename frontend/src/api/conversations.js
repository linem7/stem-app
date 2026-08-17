/** 教案会话与生成 —— api-spec 第 3、4、7 节 */
import { get, post, del } from '../utils/request.js'
import { poll } from '../utils/poll.js'

/**
 * 从首页那句话开新会话。一次把 4 道题全给出来。
 * 额度闸门装在这里 —— 在最前面。让老师答完 4 题、等 20 秒生成，最后才说额度不够，是最糟的时机。
 */
export function createConversation(seedInput) {
  return post('/conversations', { seed_input: seedInput })
}

/**
 * 答一题，即时落库。
 * 一次性出题不等于一次性提交：每选一项就调一次，老师被叫走进度不丢。
 * 不限顺序、重复提交是覆盖。
 */
export function answerQuestion(conversationId, { questionId, selected, customText }) {
  return post(`/conversations/${conversationId}/answer`, {
    question_id: questionId,
    selected,
    custom_text: customText ?? null,
  })
}

/**
 * 换了年龄班时重拉推荐答案。已答内容不会被清空，只换推荐项。
 * 推荐答案必须由后端生成 —— 前端不许硬编码任何推荐项。
 */
export function refetchQuestions(conversationId, ageGroup) {
  return get(`/conversations/${conversationId}/questions`, { age_group: ageGroup })
}

/** 断点续写时拉全量：已答题目、当前进度、待答题目 */
export function getConversation(conversationId) {
  return get(`/conversations/${conversationId}`)
}

/** 教案库。cursor 分页而非 offset —— 老师边用边新增，offset 会重复或漏条。 */
export function listConversations({ status = 'all', ageGroup = 'all', cursor, limit = 20 } = {}) {
  return get('/conversations', {
    status,
    age_group: ageGroup,
    ...(cursor ? { cursor } : {}),
    limit,
  })
}

/** 软删除 */
export function removeConversation(conversationId) {
  return del(`/conversations/${conversationId}`)
}

/* ============ 生成 ============ */

/** 立即返回 task_id，真正的结果靠轮询 */
export function startGenerate(conversationId) {
  return post(`/conversations/${conversationId}/generate`)
}

export function getGenerateStatus(conversationId) {
  return get(`/conversations/${conversationId}/generate/status`)
}

/**
 * 轮询生成结果。改稿和首次生成走同一条链路，前端不用写两套。
 *
 * 返回 { promise, stop }：**stop 必须在页面 onUnload 时调**。
 * 老师随时可能被叫走，退出去了还在打请求是不对的 —— 后端会继续生成完，
 * 她回教案库照样能看到。
 */
export function pollGenerate(conversationId, { onTick } = {}) {
  return poll({
    fetch: () => getGenerateStatus(conversationId),
    isDone: (d) => d.status === 'completed' || d.status === 'failed',
    onTick,
    interval: 2000,
    timeout: 120000, // 生成 15–30 秒，给到 2 分钟已经很宽
  })
}
