/**
 * 任务 —— api-spec 第 1.5 节
 *
 * 「现在有什么活动可以换额度」。额度只走兑换码之后，缺的就是这一环：
 * 以前只能在微信群里喊一声，谁看到谁没看到我们这边一无所知。
 *
 * **任务和奖励是断开的**：任务只承诺「填完给 20 次教案」，
 * 到账靠开发者事后核对答卷、建码发给她，她自己在「我的」页兑。
 */
import { get, post } from '../utils/request.js'

/**
 * 我能看到的、还没过期的任务。
 * `unread` 那个数是首页那条条带的开关 —— 为 0 就不显示，不占地方。
 */
export function listTasks() {
  return get('/tasks')
}

export function markTaskRead(id) {
  return post(`/tasks/${id}/read`)
}
