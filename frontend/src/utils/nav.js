/**
 * 跳转。页面路径只在 router/routes.js 里出现一次，别处一律用名字。
 */
import { router } from '../router/index.js'
import { routes } from '../router/routes.js'
import { toast } from './ui.js'

/** 名字 → 路径。表在 router/routes.js，这里只是换个形状。 */
export const ROUTES = Object.fromEntries(routes.map((r) => [r.name, r.path]))

/**
 * 跳转失败不能没声音。
 *
 * 路径写错、目标页还没搬过来，表现全都是「点了没反应」，排查时无从下手。
 * 统一在这里兜住，出错时把原因说出来。
 */
function target(name, query, how) {
  if (!ROUTES[name]) {
    toast(`跳转目标不存在：${name}`, 3000)
    return null
  }
  const loc = { path: ROUTES[name] }
  if (query) {
    const clean = Object.fromEntries(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    )
    if (Object.keys(clean).length) loc.query = clean
  }
  return router[how](loc).catch((err) => {
    toast(`跳不过去：${err?.message || '未知原因'}`, 3000)
  })
}

/** 进到下一页，留下历史记录（她可以按浏览器后退回来） */
export function push(name, query) {
  return target(name, query, 'push')
}

/**
 * 换掉当前这一页，**不留历史记录**。
 *
 * 🔴 三处必须用它而不是 push（顶栏的「←」删掉之后，后退只剩浏览器那一个）：
 *   生成完跳成稿   —— 用 push 的话，后退回到「生成中」那一屏，而那次生成早就完了
 *   激活完进首页   —— 后退回到激活页，而码已经用掉了
 *   改稿完回成稿   —— 后退回到「正在重写」
 * 三种都不报错，她只会以为卡住了。
 */
export function replace(name, query) {
  return target(name, query, 'replace')
}

/**
 * 回上一页。
 *
 * ⚠️ 她从别人发的链接直接打开某一页时**没有历史记录**，这时 router.back() 会
 * 离开整个网站。所以先看有没有上一页，没有就回首页 ——
 * 删掉的是顶栏那个通用「←」，不是所有出口。
 */
export function back() {
  if (window.history.state?.back) router.back()
  else replace('home')
}
