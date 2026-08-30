<script>
import { ensureSession } from './stores/session.js'
import { USE_CLOUD, WX_CLOUD_ENV } from './utils/env.js'

export default {
  onLaunch() {
    // 配了云托管时先 init 云能力 —— callContainer 没有它会直接 fail，
    // 而且报的是英文的 cloud not init，不是我们那句「网络断了」。
    // init 是同步登记不发请求，放在 ensureSession 之前没有代价。
    // #ifdef MP-WEIXIN
    if (USE_CLOUD) wx.cloud.init({ env: WX_CLOUD_ENV })
    // #endif

    // 只是提前把静默登录发出去，不在这里做跳转 —— 跳转由首页拿到结果后决定，
    // 理由写在 stores/session.js 的 ensureSession 注释里。
    ensureSession()
  },
}
</script>

<style lang="scss">
/* 设计令牌与全局基底。App.vue 的 style 编译成小程序的 app.wxss，是全局的。 */
@use './styles/tokens.scss';
</style>
