/**
 * 路由表 —— **页面路径的唯一一处**。
 *
 * 一张表同时喂两边：createRouter 要 path + component，utils/nav.js 要 name → path。
 * 分成两份的话，加一页要记得改两个地方，而忘掉一处的表现是「点了没反应」。
 *
 * 搬一个页面过来 = 在这里加一行。表里没有的名字，nav.js 会当场报出来。
 */
export const routes = [
  { name: 'home', path: '/', component: () => import('../pages/index/index.vue') },

  /*
    一条对话流：引导 + 生成 + 成稿 + 改一改（2026-08-30 合并）。
    原来的 /guide /generating /plan 三个地址没了 —— 那三段现在是同一条流里的三截。
    `?id=` 是**会话 id**，不是教案 id。
  */
  { name: 'conv', path: '/c', component: () => import('../pages/conv/conv.vue') },

  /*
    使用协议与隐私说明。两种进法：激活流程里签一次；从「我的」带 `?view=1` 回头看。
    没有 view 那个开关，已经同意过的老师一进来就被 gate 弹回首页。
  */
  { name: 'agreement', path: '/agreement', component: () => import('../pages/agreement/agreement.vue') },

  // 组件预览。**真页面搬完就删掉这一行和那个目录**
  { name: 'preview', path: '/preview', component: () => import('../pages/preview/preview.vue') },
]
