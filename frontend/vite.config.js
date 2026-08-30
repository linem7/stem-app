import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],

  css: {
    preprocessorOptions: {
      scss: {
        /*
          每个组件的 <style lang="scss"> 自动拿到设计令牌的 SCSS 变量。
          uni-app 时代这件事是 uni.scss 自动做的；换成 Vite 之后要自己接上，
          否则组件里的 $amber 会编译报错 —— 一个一个文件去 @use 迟早漏。

          走 loadPaths 而不是相对路径：additionalData 会被插进**每一个** scss 块，
          而相对路径是相对那个组件文件解析的，组件在哪一层目录就得写几个 ../。
        */
        additionalData: '@use "vars" as *;\n',
        loadPaths: [fileURLToPath(new URL('./src/styles', import.meta.url))],
      },
    },
  },

  server: {
    /*
      监听所有网卡，这样**同一个 WiFi 下的手机能直接打开**（2026-08-31 用户要）——
      开发者工具那个手机模拟框看的是模拟的触控和尺寸，
      真机上才看得出滚动惯性、输入法顶起页面、字号被系统调过这些事。

      ⚠️ 后端也要跟着开：手机打到 5173，vite 代理转给 `localhost:3000` 是在**这台电脑上**
      解析的，所以后端不用动。但 Windows 防火墙第一次会弹窗问，要点「允许」。
    */
    host: true,

    /*
      后端没配 CORS，所以开发时走同源代理：浏览器打到 5173 的 /v1，vite 转给 3000。
      /local-images 是配图在本机时的存放路径（backend/src/server.js 的 express.static），
      漏了它成稿页的图会 404 —— 而 404 的图在页面上就是一块空白，不报错。
    */
    proxy: {
      '/v1': 'http://localhost:3000',
      '/local-images': 'http://localhost:3000',
    },
  },
})
