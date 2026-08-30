/**
 * 路由。页面路径只在这里出现一次，别处一律用名字。
 */

export const ROUTES = {
  home: '/pages/index/index',
  guide: '/pages/guide/guide',
  generating: '/pages/generating/generating',
  plan: '/pages/plan/plan',
  revise: '/pages/revise/revise',
  library: '/pages/library/library',
  me: '/pages/me/me',
  redeem: '/pages/redeem/redeem',
  agreement: '/pages/agreement/agreement',
  tasks: '/pages/tasks/tasks',
}

/**
 * 底部三个 tab。
 *
 * 没用小程序原生 tabBar：原生的 iconPath 只吃 png/jpg，而这套设计的图标是几何 SVG
 * （design-tokens.md 第 5 节：只用几何形手搓，不用位图）。为了图标能跟着色板走，
 * tabBar 做成普通组件，切换用 reLaunch —— 保证页面栈里始终只有一页，不会越点越深。
 */
export const TABS = ['home', 'library', 'me']

function withQuery(path, query) {
  if (!query) return path
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  return qs ? `${path}?${qs}` : path
}

/**
 * 跳转失败不能没声音。
 *
 * uni 的这几个跳转 API 失败时只走 fail 回调，不抛异常 —— 页面路径写错、
 * 目标页没注册、栈满了，表现全都是「点了没反应」，排查时无从下手。
 * 统一在这里兜住，出错时把原因说出来。
 */
function go(api, name, query, label) {
  const url = withQuery(ROUTES[name], query)
  if (!ROUTES[name]) {
    uni.showToast({ title: `跳转目标不存在：${name}`, icon: 'none', duration: 3000 })
    return
  }
  api({
    url,
    fail: (err) => {
      uni.showToast({ title: `跳不过去（${label}）：${err?.errMsg || '未知原因'}`, icon: 'none', duration: 3000 })
    },
  })
}

export function navTo(name, query) {
  go(uni.navigateTo, name, query, 'navigateTo')
}

export function redirectTo(name, query) {
  go(uni.redirectTo, name, query, 'redirectTo')
}

export function reLaunch(name, query) {
  go(uni.reLaunch, name, query, 'reLaunch')
}

export function back(delta = 1) {
  const pages = getCurrentPages()
  if (pages.length > delta) uni.navigateBack({ delta })
  else reLaunch('home')
}

/** 切 tab。用 reLaunch 而不是 navigateTo，否则来回点几下页面栈就爆了（上限 10 层）。 */
export function switchTab(name) {
  reLaunch(name)
}
