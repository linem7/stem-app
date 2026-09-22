import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router/index.js'
import { ensureSession, logout } from './stores/session.js'
import './styles/tokens.scss'
import { TOKEN_KEY } from './utils/request.js'

/*
  九个 s-* 组件全局注册。
  对应小程序时代 pages.json 里那段 easycom —— 页面模板里直接写 <s-button> 就行，
  不用每页 import 一遍（十个页面 × 五六个组件 = 六十行只为了 import）。
*/
const components = import.meta.glob('./components/s-*.vue', { eager: true })

const app = createApp(App)
for (const [path, mod] of Object.entries(components)) {
  app.component(path.replace(/^.*\/(s-[a-z]+)\.vue$/, '$1'), mod.default)
}
app.use(router)
app.mount('#app')

// 只是提前把登录发出去，不在这里做跳转 —— 跳转由页面拿到结果后决定，
// 理由写在 stores/session.js 的 ensureSession 注释里。
ensureSession()

// 浏览器后退恢复整页快照时，重新校验登录，不能复活退出前的个人页面。
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload()
})

// 同一浏览器的其他标签页也应退出；其他设备的凭证不受影响。
window.addEventListener('storage', (event) => {
  if ((event.key === TOKEN_KEY || event.key === null) && event.newValue === null) {
    logout()
    window.location.replace(router.resolve({ name: 'login' }).href)
  }
})
