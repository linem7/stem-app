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
   * 地址从哪来：`.env.development` 里的 `VITE_H5_API_BASE=/v1`，
   * 由 `utils/env.js` 用 `#ifdef H5` 只发给 H5。
   *
   * 🔴 别改回「在 `.env.development.local` 里覆盖 VITE_API_BASE」那种做法（2026-08-25 撤掉）。
   * 这里原来的注释写着「不覆盖也不影响小程序」—— **那句是错的**：
   * Vite 对 mode=development 一律加载 `.local` 且优先级最高，小程序那一侧会被一起改成
   * 相对路径，而 `wx.request` 不接受相对路径，编出来的包在微信里连不上后端。
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
