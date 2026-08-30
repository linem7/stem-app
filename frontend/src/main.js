import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router/index.js'
import { ensureSession } from './stores/session.js'
import './styles/tokens.scss'

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
