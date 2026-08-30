/**
 * 提示。所有错误文案一律用后端给的 err.message —— 前端不许自己拼错误话术。
 *
 * 小程序那边 toast / 弹框 / loading 是三个平台 API，网页里没有，所以自己实现：
 * 这里只管**状态**，画出来的是 components/s-overlays.vue（App.vue 里挂一次）。
 * 分成两半是因为这些函数要能在组件外面调（api 层、store 里都会调）。
 */
import { reactive } from 'vue'
import { net } from '../stores/net.js'

export const overlay = reactive({
  /** 空串 = 不显示 */
  toast: '',
  /** null = 不显示；字符串 = 显示这句话 */
  loading: null,
  /** null = 不显示；{ content, confirmText, cancelText, resolve } */
  modal: null,
})

let toastTimer = null

/** 一句轻提示，不打断操作 */
export function toast(message, duration = 2000) {
  overlay.toast = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    overlay.toast = ''
  }, duration)
}

/**
 * 一句话 + 一个「知道了」。停得住，她读完才走。
 * @returns {Promise<boolean>} 永远是 true
 */
export function alert(content, confirmText = '知道了') {
  return new Promise((resolve) => {
    overlay.modal = { content, confirmText, cancelText: '', resolve }
  })
}

/**
 * 停下来问一句。
 * **取消一律写「取消」，不写「算了」** —— 「算了」有情绪、还含着「不重要」的暗示。
 * @returns {Promise<boolean>} 她按了确认没有
 */
export function confirm(content, { confirmText = '确定', cancelText = '取消' } = {}) {
  return new Promise((resolve) => {
    overlay.modal = { content, confirmText, cancelText, resolve }
  })
}

/** s-overlays 按完键调它 */
export function closeModal(ok) {
  const m = overlay.modal
  overlay.modal = null
  if (m) m.resolve(ok)
}

/**
 * 展示一个 ApiError。
 * 额度不足、还没激活这两类不是「错误」，是需要老师做点什么，所以用能停住的弹框而不是一闪而过的
 * toast —— 尤其 QUOTA_EXCEEDED 的文案里带着出路（怎么才能再拿到额度），一闪而过就白说了。
 */
export function showApiError(err, { onConfirm } = {}) {
  const message = err?.message || '出了点问题，再试一次'
  const needsAttention = err?.code === 'QUOTA_EXCEEDED' || err?.code === 'NOT_ACTIVATED'
  if (needsAttention) {
    alert(message).then(() => onConfirm && onConfirm())
    return
  }
  toast(message, 2500)
}

/**
 * 这个错误该按哪一种态画（给 `<s-state :kind>` 用）。
 *
 * 「无网」要**两个条件同时成立**：请求根本没发出去（`NETWORK`），
 * 而且系统确实报告了断网。
 *
 * 少了后半个条件就会错，而且错得很常见：`NETWORK` 这个 code 覆盖的是
 * 「没到后端」，里面包括「wifi 好得很，是后端连不上」。那种时候画成「无网」，
 * 等于让她去检查一件本来没问题的事，而真正的问题（只能等我）一个字没说。
 *
 * `TIMEOUT` 也不算：请求已经出去了，卡住的可能是网也可能是后端。
 */
export function stateKind(err) {
  return err?.code === 'NETWORK' && !net.online ? 'offline' : 'error'
}

export function showLoading(title = '') {
  overlay.loading = title
}

export function hideLoading() {
  overlay.loading = null
}
