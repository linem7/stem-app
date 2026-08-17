/** 教案、改稿、配图、评价 —— api-spec 第 1.6、5、6 节 */
import { get, post, patch } from '../utils/request.js'
import { poll } from '../utils/poll.js'

export function getLessonPlan(id) {
  return get(`/lesson-plans/${id}`)
}

/** 局部编辑。后端据此重渲染 content_md，两份不允许各自漂移。 */
export function updateLessonPlan(id, contentJson) {
  return patch(`/lesson-plans/${id}`, { content_json: contentJson })
}

/** 导出 docx。后端还没实现，现在会返回 NOT_IMPLEMENTED（不可重试）。 */
export function exportLessonPlan(id, format = 'docx') {
  return post(`/lesson-plans/${id}/export`, { format })
}

/* ============ 改一改 ============ */

/**
 * 老师说哪里不对 → 拿到 3 道追问（必须是引导阶段没问过的）。
 * feedback 上限 300 字。前两次改稿免费，第三次起查文案额度 —— 查在提问之前，
 * 问完三个问题再说没额度等于白问。
 */
export function startRevise(lessonPlanId, feedback) {
  return post(`/lesson-plans/${lessonPlanId}/revise`, { feedback })
}

/** 答完追问，重新生成。之后仍然轮询 conversations 的 generate/status。 */
export function submitReviseAnswers(lessonPlanId, reviseRound, answers) {
  return post(`/lesson-plans/${lessonPlanId}/revise/answer`, {
    revise_round: reviseRound,
    answers,
  })
}

/* ============ 配图 ============ */

export function requestImage(lessonPlanId, { sectionKey, note }) {
  return post(`/lesson-plans/${lessonPlanId}/images`, { section_key: sectionKey, note })
}

export function getImage(lessonPlanId, imageId) {
  return get(`/lesson-plans/${lessonPlanId}/images/${imageId}`)
}

/** 一张约 30 秒。同样返回 stop，页面离开时必须调。 */
export function pollImage(lessonPlanId, imageId, { onTick } = {}) {
  return poll({
    fetch: () => getImage(lessonPlanId, imageId),
    isDone: (d) => d.status === 'ready' || d.status === 'failed',
    onTick,
    interval: 2000,
    timeout: 180000,
  })
}

/* ============ 评价 ============ */

/**
 * 教案评价。绑 lesson_plan_id + version —— 后台看到的是「大班搭高塔的 v2 被标了用不了，
 * 原文在这」，而不是一句无从查起的抱怨。同版本重复提交是覆盖。
 *
 * 这是「教案是否真的适龄可用」这个最大未知数的持续数据源。
 */
export function rateLessonPlan(id, { rating, text }) {
  return post(`/lesson-plans/${id}/rate`, { rating, text })
}
