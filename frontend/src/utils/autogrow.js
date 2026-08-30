/**
 * 让 textarea 跟着内容长高。
 *
 * uni 的 `<textarea :auto-height>` 在网页里没有对应物。`field-sizing: content`
 * 是干这件事的 CSS，但 Safari 还不支持 —— 老师十有八九用的是手机 Safari 或微信内置浏览器，
 * 所以只能自己量。
 *
 * 先归零再读 scrollHeight：不归零的话内容删短了它只会越长越高，收不回去。
 */
export function autogrow(el) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
