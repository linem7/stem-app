/**
 * 提示。所有错误文案一律用后端给的 err.message —— 前端不许自己拼错误话术。
 */

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
