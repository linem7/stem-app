/**
 * 网络状态。**「无网」是一个态，不是一句错误文案。**
 *
 * 断网和「后端出错」对老师是两件事：一件她能处理（走到有信号的地方），一件她只能等。
 *
 * 有了这份状态之后多出来的那件事才是关键：**网回来的那一刻能自动重来一次**。
 * 幼儿园里走两步就没信号是常事，她不该为此记得回来点一下重试。
 *
 * 监听只注册一次（模块级）。想在组件里 watch 这个 reactive 就行，
 * 组件销毁时 watcher 自己会清。
 */
import { reactive } from 'vue'

export const net = reactive({
  /**
   * 默认 true，不默认 false。
   *
   * 绝大多数时候网是好的。宁可晚半秒知道断了，也不要每次都先冤枉一次网络。
   *
   * ⚠️ `navigator.onLine` 只报「这台机器有没有连上一个网络」，
   * 连上了但出不了外网时它照样是 true。所以它不能单独用来判断「无网」——
   * 判据是**两个条件同时成立**：请求没到后端（code === 'NETWORK'）**且** 这里是 false。
   * 见 utils/ui.js 的 stateKind。
   */
  online: true,
})

if (typeof window !== 'undefined') {
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
