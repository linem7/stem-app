/** 教案、改稿、配图、评价 —— api-spec 第 1.6、5、6 节 */
import { get, post } from '../utils/request.js'
import { poll } from '../utils/poll.js'

export function getLessonPlan(id) {
  return get(`/lesson-plans/${id}`)
}

/**
 * 局部编辑。后端据此重渲染 content_md，两份不允许各自漂移。
 * 走 `POST /lesson-plans/:id/update`（别名，理由见 api/me.js 的 updateMe）。
 *
 * ⚠️ **目前没有页面调用它，这是有意的**（用户 2026-08-21 定）：
 * 成稿页不给「自己动手改文字」的入口，老师改教案一律走「改一改」那条 AI 重写的路。
 * 留着这个函数是因为接口通着 —— 哪天要用，前后端都不必再动。
 */
export function updateLessonPlan(id, patchBody) {
  return post(`/lesson-plans/${id}/update`, patchBody)
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

/* ============ 版本与回退 ============ */

/** 版本列表。note 是产生那一版的改稿意见 —— 老师认版本靠这句，不是版本号 */
export function getVersions(lessonPlanId) {
  return get(`/lesson-plans/${lessonPlanId}/versions`)
}

/**
 * 回到某一版。不新增版本、不删版本，可以来回切；不消耗额度；**不动图片**。
 * 图跨版本一直在是有意的：老师只在觉得某样材料值得画时才生成，
 * 那份判断不会因为教案改了一句话就失效。
 */
export function rollback(lessonPlanId, version) {
  return post(`/lesson-plans/${lessonPlanId}/rollback`, { version })
}

/* ============ 配图 ============ */

/**
 * 画一张给老师打印出来用的图（不是活动场景示意图）。
 *
 * 用**哪个模型**画不在这里传：由管理后台统一定（老师不选模型，小程序里也没这个开关）。
 * 就算传了后端也不看 —— 客户端是可以被改的，技术选型的开关不该交出去。
 *
 * purpose 决定构图和画布比例（材料图/记录表/头饰/展示图/环创背景），后端默认 material。
 * **一定要传**：漏了它，老师在抽屉里选的「记录表」会被画成一张材料图 ——
 * 界面上选得好好的，后端根本没收到，这种错最难查。
 * sectionKey 形如 material.3（自由描述时为 null），note 是材料名或她自己写的描述
 * —— 后端拿它当图片标签，因为教案改过之后材料清单可能已经变了，靠下标认不出来。
 * 每份教案最多 3 张，超了返回 IMAGE_LIMIT_EXCEEDED。
 */
export function requestImage(lessonPlanId, { purpose, sectionKey, note }) {
  return post(`/lesson-plans/${lessonPlanId}/images`, {
    purpose,
    section_key: sectionKey,
    note,
  })
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
