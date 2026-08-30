/**
 * 把配图存到手机相册。
 *
 * 老师存下来是为了**打印**：存进相册 → 微信发到电脑 → 打印，或者直接连打印机。
 * 所以下载的必须是原图（2048 长边），不是屏幕上那个缩过的。
 * 后端给的 url 本来就是原图，`<image mode="widthFix">` 只是显示时缩，文件没变小。
 */
import { toast } from './ui.js'

/**
 * @param {string} url 图片地址
 * @returns {Promise<boolean>} 存成功没有
 */
export function saveImageToAlbum(url) {
  return new Promise((resolve) => {
    if (!url) {
      toast('这张图还没好')
      resolve(false)
      return
    }
    uni.showLoading({ title: '正在保存', mask: true })

    uni.downloadFile({
      url,
      success(res) {
        if (res.statusCode !== 200) {
          uni.hideLoading()
          toast('图片下载失败，再试一次')
          resolve(false)
          return
        }
        uni.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success() {
            uni.hideLoading()
            toast('已存到相册，可以发到电脑打印了')
            resolve(true)
          },
          fail(err) {
            uni.hideLoading()
            // 她拒绝过相册权限之后，之后每次都会静默失败 ——
            // 必须告诉她去哪儿打开，不然只会觉得"这个按钮是坏的"
            const denied = String(err?.errMsg || '').includes('auth')
            if (denied) {
              uni.showModal({
                title: '',
                content: '要先允许保存到相册。点右上角「…」→ 设置 → 打开「保存到相册」，再回来试一次。',
                showCancel: false,
                confirmText: '知道了',
              })
            } else {
              toast('没能存进相册，再试一次')
            }
            resolve(false)
          },
        })
      },
      fail() {
        uni.hideLoading()
        toast('图片下载失败，检查一下网络')
        resolve(false)
      },
    })
  })
}
