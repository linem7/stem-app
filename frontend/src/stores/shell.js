/**
 * 外壳状态：侧边栏开着没有。
 *
 * 两种形态共用这一份状态，因为它们是同一件事的两个样子（2026-08-30 用户定）：
 *   宽屏（≥900px）  左边常驻一条侧边栏，可以收起
 *   窄屏           侧边栏变成从左边滑出来的抽屉，点汉堡键开
 *
 * ⚠️ **抽屉不能靠「从左边缘右滑」打开。** iOS Safari 把那个手势占用成了「后退」，
 * 而删掉顶栏返回箭头（2026-08-30）靠的正是这个手势。汉堡键是唯一入口。
 */
import { reactive } from 'vue'
import { readLocal, writeLocal } from '../utils/storage.js'

const KEY = 'stem_side_collapsed'
/** 宽屏的分界。比这窄就没有同时放下侧边栏和一列正文的地方 */
const WIDE = '(min-width: 900px)'

export const shell = reactive({
  /** 窄屏：抽屉开着没有。**不记到本机** —— 每次打开网站都该是关着的 */
  drawer: false,
  /** 宽屏：侧边栏收起来了没有。记到本机，她收起来是因为想要更宽的正文 */
  collapsed: readLocal(KEY) === '1',
  /** 现在算宽屏吗。跟着窗口变，桌面浏览器上拖窄窗口会当场切形态 */
  wide: false,
})

if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia(WIDE)
  shell.wide = mq.matches
  mq.addEventListener('change', (e) => {
    shell.wide = e.matches
    // 从窄拖到宽时抽屉状态要清掉，否则宽屏下那层蒙版还盖着
    if (e.matches) shell.drawer = false
  })
}

/**
 * 汉堡键。**一个键两种行为** —— 用户要的就是「打开或者收起侧边栏」这一件事，
 * 只是窄屏上它盖在正文上、宽屏上它挤开正文。
 */
export function toggleSide() {
  if (shell.wide) {
    shell.collapsed = !shell.collapsed
    writeLocal(KEY, shell.collapsed ? '1' : '0')
  } else {
    shell.drawer = !shell.drawer
  }
}

export function closeDrawer() {
  shell.drawer = false
}
