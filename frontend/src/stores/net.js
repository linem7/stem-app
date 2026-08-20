/**
 * 网络状态。**「无网」是一个态，不是一句错误文案。**
 *
 * 在这之前，断网走的是 request.js 里那句兜底 message（「网络好像断了，检查一下再试」），
 * 跟别的错误长得一模一样，只能靠她自己看着办 —— 而断网和「后端出错」对老师是两件事：
 * 一件她能处理（走到有信号的地方），一件她只能等。
 *
 * 有了这份状态之后多出来的那件事才是关键：**网回来的那一刻能自动重来一次**。
 * 幼儿园里走两步就没信号是常事，她不该为此记得回来点一下重试。
 *
 * 监听只注册一次（模块级）。想在组件里 watch 这个 reactive 就行，
 * 组件销毁时 watcher 自己会清 —— 比每个页面各注册一次 onNetworkStatusChange
 * 再各自记得注销可靠得多（小程序的 off* 在低版本上时有时无）。
 */
import { reactive } from 'vue'

export const net = reactive({
  /**
   * 默认 true，不默认 false。
   *
   * 首屏查询是异步的，那一小段里如果按「离线」画，每次冷启动都会闪一下
   * 「网络好像断了」再消失 —— 而绝大多数时候网是好的。
   * 宁可晚半秒知道断了，也不要每次都先冤枉一次网络。
   */
  online: true,
})

try {
  uni.getNetworkType({
    success: (r) => {
      net.online = r.networkType !== 'none'
    },
  })
  uni.onNetworkStatusChange((r) => {
    net.online = Boolean(r.isConnected)
  })
} catch (e) {
  // 取不到就当一直在线。这份状态是锦上添花，不该拦住任何东西
}

/**
 * H5 还要自己接一次 window 的 online/offline。
 *
 * **实测（2026-08-20，浏览器里断网）**：uni 的 H5 实现里 `onNetworkStatusChange` 不烧这两个事件 ——
 * `navigator.onLine` 已经是 false 了，`net.online` 还是 true，
 * 于是断网那一屏底下写着一行「网回来了」。**那是一句假话，而且正好出现在
 * 她最需要准确信息的时候。**
 *
 * 微信端只有 uni 那个 API，是好的；但 H5 预览是每天真正在看的那一端，
 * 只在微信里对不够。两边都接上，谁先报谁算。
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    net.online = navigator.onLine
  }
  window.addEventListener('online', () => {
    net.online = true
  })
  window.addEventListener('offline', () => {
    net.online = false
  })
}
