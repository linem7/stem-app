/**
 * 本机偏好。目前只有字号一项。
 *
 * **存在本机，不进后端**：这是一台设备上的显示偏好，不是账号数据。
 * 进后端要改 api-spec、加一列、加一次迁移，换来的只有「换手机之后不用再点一下」——
 * 而她换手机本来就要走一遍换绑。代价和收益不成比例。
 * 代价说清楚：**换微信或换手机，字号回到标准档**，她要再点一次。
 *
 * 读是同步的（`getStorageSync`），所以第一屏画出来就是她选过的那一档，
 * 不会先按标准档画一遍再跳大 —— 那种跳动比字小更难受。
 */
import { reactive } from 'vue'
import { FONT_SCALES, fontVars as buildVars } from '../utils/typography.js'

const KEY = 'stem_font_scale'
const MODE_KEY = 'stem_mode'

/**
 * 两种模式。**效率模式在前**，因为它是默认，而默认应该排第一。
 *
 * `desc` 是抽屉里那一行说明 —— 这是「界面上不写解释性小字」那条规则的
 * **一个例外**，理由过得了那条规则自己的判据：「学习模式」四个字不自明，
 * 不给一句话她只能盲选。但**只在抽屉里给这一句**，首页那个胶囊上不许挂副标题。
 */
export const MODES = [
  { key: 'efficient', label: '效率模式', desc: '直接拿到教案' },
  { key: 'learning', label: '学习模式', desc: '多告诉你为什么这样设计' },
]

function readMode() {
  try {
    const v = uni.getStorageSync(MODE_KEY)
    return MODES.some((m) => m.key === v) ? v : 'efficient'
  } catch (e) {
    return 'efficient'
  }
}

export { FONT_SCALES }

function read() {
  try {
    const v = uni.getStorageSync(KEY)
    return FONT_SCALES.some((s) => s.key === v) ? v : 'std'
  } catch (e) {
    // 存储被清了或读不到，按标准档。不要让一个偏好把页面拦住
    return 'std'
  }
}

export const prefs = reactive({
  fontScale: read(),
  /**
   * 上次用的模式，作为下次开新教案的默认。
   *
   * 记住它是为了让「每次都能选」不等于「每次都要选」——
   * 一个每次都要重选的开关，用两天就会被当成噪音。
   */
  mode: readMode(),
})

export function setMode(key) {
  if (!MODES.some((m) => m.key === key)) return
  prefs.mode = key
  try {
    uni.setStorageSync(MODE_KEY, key)
  } catch (e) {
    // 写不进去也让这一次生效
  }
}

/** 当前模式的显示名，给首页那个胶囊用 */
export function modeLabel() {
  return MODES.find((m) => m.key === prefs.mode)?.label || MODES[0].label
}

/** 挂在 s-page 根节点上的内联 style。为什么是内联见 utils/typography.js 的文件头。 */
export function fontVars() {
  return buildVars(prefs.fontScale)
}

export function setFontScale(key) {
  if (!FONT_SCALES.some((s) => s.key === key)) return
  prefs.fontScale = key
  try {
    uni.setStorageSync(KEY, key)
  } catch (e) {
    // 写不进去也让这一次生效 —— 至少她这一趟看得清
  }
}
