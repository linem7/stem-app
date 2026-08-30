/**
 * 把配图存下来。
 *
 * 老师存下来是为了**打印**：存到手机 → 发到电脑 → 打印，或者直接连打印机。
 * 所以下载的必须是原图（长边 2048），不是屏幕上那个缩过的。
 * 后端给的 url 本来就是原图，`<img>` 只是显示时缩，文件没变小。
 *
 * 先取成 blob 再下载，不直接给 `<a href=远程地址 download>`：
 * `download` 这个属性**跨源时会被浏览器忽略**，那时点下去变成「在新标签页打开」，
 * 她得自己长按保存。图片以后要搬到 COS（另一个域名），所以这条现在就得走对。
 *
 * 🔴 但 blob 那条路要对方允许跨源读（CORS）。开发时后端回的是
 * `http://localhost:3000/local-images/...` 而页面在 5173，`/local-images` 没配 CORS，
 * fetch 直接失败 —— **这时候绝不能报「检查一下网络」**：网好好的，
 * 那句话会让她去查一件根本没问题的事。所以取不到就退到「新标签页打开」，
 * 并告诉她接下来按什么。上 COS 时给桶配上 CORS，这条退路就用不到了。
 */
import { toast, showLoading, hideLoading } from './ui.js'

/**
 * @param {string} url 图片地址
 * @param {string} filename 存成什么名字（不含扩展名）
 * @returns {Promise<boolean>} 存成功没有
 */
export async function downloadImage(url, filename = '配图') {
  if (!url) {
    toast('这张图还没好')
    return false
  }

  showLoading('正在保存')
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()

    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = `${filename}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    // 立刻 revoke 会让部分浏览器还没读完就断了
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000)

    hideLoading()
    toast('已经存下来了，可以发到电脑打印')
    return true
  } catch (err) {
    hideLoading()
    window.open(url, '_blank', 'noopener')
    toast('图片在新页面打开了，长按（电脑上右键）保存', 3500)
    return false
  }
}
