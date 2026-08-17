<script>
import { ensureSession } from './stores/session.js'

export default {
  onLaunch() {
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
