import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

export default defineConfig({
  plugins: [uni()],

  /**
   * H5 预览用的开发代理。
   *
   * 只影响 `npm run dev:h5`，跟小程序那条路无关（小程序不受同源限制，
   * 直接打 `VITE_API_BASE` 就行）。
   *
   * 为什么需要它：H5 预览跑在 5173，后端在 3000，而**后端没有配 CORS**
   * （它只服务小程序，本来不需要）。所以浏览器会把请求拦下来。
   * 以前每次预览都现搭一个临时代理脚本，用完即弃 —— 那件事重复三遍就该写进配置。
   *
   * 用法：`.env.development.local` 里覆盖成相对路径，让请求走同源：
   *     VITE_API_BASE=/v1
   * 不覆盖也不影响小程序 —— 那边读的是 .env.development 里的绝对地址。
   */
  server: {
    proxy: {
      '/v1': { target: 'http://localhost:3000', changeOrigin: true },
      '/local-images': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },

  css: {
    preprocessorOptions: {
      scss: {
        // uni-app 内部还在用 dart-sass 的 legacy JS API，每编译一个组件就刷一条
        // deprecation 警告，真正的报错会被淹掉。这里只关这一条，别顺手关别的。
        silenceDeprecations: ['legacy-js-api'],
      },
    },
  },
})
