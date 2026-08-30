/** 产品建议 —— api-spec 第 1.6 节 */
import { post } from '../utils/request.js'

/** category: quality | feature | usability | other */
export function sendFeedback({ category, text }) {
  return post('/feedback', { category, text })
}
