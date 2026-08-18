/**
 * 跨页交接：上一页已经拿到手的数据，直接递给下一页，别让下一页再问一次后端。
 *
 * 起因是首页 → 引导页这一段。`POST /conversations` 的响应里**已经带着那 4 道题**了，
 * 可引导页 onLoad 又去 `GET /conversations/:id` 拉了一遍：老师看着「正在准备问题」等 4 秒，
 * 进去还要再看一次骨架屏。同一份数据、一次请求就够。
 *
 * 为什么不塞进 URL：题目和推荐答案是一大段 JSON，塞 query 里要转义、会超长，
 * 而且小程序的页面参数在开发者工具里是明文可见的一串，难看也没必要。
 *
 * 用完即弃（take 一次就清空）：留着会让「从教案库再进这一页」拿到上一次的旧题。
 */
const slots = {}

export function put(key, value) {
  slots[key] = value
}

/** 取一次就清掉。没有就返回 null，调用方照常自己去拉 */
export function take(key) {
  const v = slots[key]
  delete slots[key]
  return v ?? null
}
