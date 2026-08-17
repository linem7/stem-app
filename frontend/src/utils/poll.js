/**
 * 轮询。生成教案 15–30 秒、配图约 30 秒，都是「发起 → 每 2 秒问一次」的形状
 * （api-spec 第 4、6 节：不用 WebSocket，小程序里长连接的断线重连成本高）。
 *
 * 两条必须守住的规则：
 * 1. **能停**。老师在幼儿园随时被叫走，页面 onUnload 必须能把定时器掐掉，
 *    否则退出去了还在打请求。
 * 2. **单次失败不算失败**。轮询过程中掉一两个包很常见，连续失败若干次才放弃，
 *    否则地铁里晃一下就报「生成失败」，其实后端好好的。
 */

const MAX_CONSECUTIVE_ERRORS = 3

/**
 * @param {object} opts
 * @param {() => Promise<any>} opts.fetch       每次轮询要调的接口
 * @param {(data:any) => boolean} opts.isDone   拿到结果算不算结束
 * @param {(data:any) => void} [opts.onTick]    每次拿到结果都回调一次（用来推进等待文案）
 * @param {number} [opts.interval]              间隔毫秒，默认 2000
 * @param {number} [opts.timeout]               总上限毫秒，默认 120000
 * @returns {{ promise: Promise<any>, stop: () => void }}
 */
export function poll({ fetch, isDone, onTick, interval = 2000, timeout = 120000 }) {
  let timer = null
  let stopped = false
  let errorCount = 0
  const startedAt = Date.now()

  let resolveOuter
  let rejectOuter
  const promise = new Promise((resolve, reject) => {
    resolveOuter = resolve
    rejectOuter = reject
  })

  function stop() {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function schedule() {
    if (stopped) return
    timer = setTimeout(tick, interval)
  }

  async function tick() {
    if (stopped) return

    if (Date.now() - startedAt > timeout) {
      stop()
      rejectOuter(new Error('POLL_TIMEOUT'))
      return
    }

    try {
      const data = await fetch()
      if (stopped) return
      errorCount = 0
      if (onTick) onTick(data)
      if (isDone(data)) {
        stop()
        resolveOuter(data)
        return
      }
    } catch (err) {
      if (stopped) return
      // 不可重试的错误（比如 401、404）再问一万次也是这个答案，立刻放弃
      if (err?.retryable === false) {
        stop()
        rejectOuter(err)
        return
      }
      errorCount += 1
      if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
        stop()
        rejectOuter(err)
        return
      }
    }
    schedule()
  }

  // 第一次立刻问，不等 interval —— 有时候后端已经好了，白等 2 秒没道理
  tick()

  return { promise, stop }
}
