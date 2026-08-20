/**
 * 提示。所有错误文案一律用后端给的 err.message —— 前端不许自己拼错误话术。
 */
import { net } from '../stores/net.js'

/** 一句轻提示，不打断操作 */
export function toast(message, duration = 2000) {
  uni.showToast({ title: message, icon: 'none', duration })
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
    uni.showModal({
      title: '',
      content: message,
      showCancel: false,
      confirmText: '知道了',
      success: () => onConfirm && onConfirm(),
    })
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
  uni.showLoading({ title, mask: true })
}

export function hideLoading() {
  uni.hideLoading()
}

/** 状态栏高度。全局用了 navigationStyle: custom，每个页面顶部都要自己让出这段。 */
export function statusBarHeight() {
  try {
    const info = uni.getWindowInfo ? uni.getWindowInfo() : uni.getSystemInfoSync()
    return info.statusBarHeight || 20
  } catch (e) {
    return 20
  }
}
