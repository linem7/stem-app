<template>
  <!--
    s-shell 在 router-view 外面，所以**换页时它不重新挂载** ——
    侧边栏那条教案列表不用每翻一页重拉一次，抽屉的开合状态也不会被换页重置。
  -->
  <s-shell>
    <router-view />
  </s-shell>
  <!-- toast / 弹框 / loading。挂在这里，全站共用一份 -->
  <s-overlays />
</template>

<script setup>
/**
 * 登录态没了就把她送回登录页。
 *
 * 两种触发：token 被后端拒了（401 兜底，见 utils/request.js），
 * 或者她自己点了退出。
 *
 * 【为什么这一段在这里，不在 stores/session.js】
 * `scripts/api-contract-test.mjs` 是用 node 跑的，它**直接 import 那个 store**。
 * 而跳转要经过 utils/nav.js → router/index.js → createWebHistory()，
 * 那个函数在 `const { history, location } = window` 上当场抛
 * （node 里没有 window）。
 *
 * 一个「跳转」不该把整个 vue-router 拖进一个纯状态模块 ——
 * 契约测试跑不起来，等于丢掉一份 47 条的回归。
 * App.vue 是浏览器独有的，放这里不会牵连任何人。
 */
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { session } from './stores/session.js'
import { replace } from './utils/nav.js'

const route = useRoute()

watch(
  () => session.teacher,
  (now, before) => {
    // 只管「变没了」这个方向；登录成功之后去哪一页由各个页面自己决定
    // （激活页和登录页都要按 gate() 分流，规则不一样）
    if (now || !before) return
    if (route.name === 'redeem' || route.name === 'login') return
    replace('login')
  }
)
</script>
