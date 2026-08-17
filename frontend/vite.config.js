import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

export default defineConfig({
  plugins: [uni()],
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
