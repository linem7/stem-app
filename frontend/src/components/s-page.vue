<template>
  <!--
    根节点上内联八个字号变量。底下所有页面内容和子组件里的 var(--fs-body) 靠继承拿到它，
    所以整套字号必须走 CSS 变量 —— SCSS 变量在编译期就写死了，继承不了。
  -->
  <div class="s-page" :style="fontStyle">
    <slot name="top" />

    <div class="s-page__inner" :class="{ 's-page__inner--flush': flush, 's-page__inner--center': center }">
      <slot />
    </div>

    <!--
      拇指位常驻操作条。方向 B 的核心资产之一，主行动永远在够得着的地方。

      用 sticky 而不是 fixed：sticky 还占着文档流的位置，所以内容天然不会被它盖住 ——
      fixed 要给每一页手工留一段 padding-bottom，而漏掉的表现是
      「最后一张卡片被压住了一半」，那种错只有滚到底才看得见。
    -->
    <div v-if="dock" class="s-page__dock">
      <slot name="dock" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { fontVars } from '../stores/prefs.js'

defineProps({
  /**
   * 要不要显示底部操作条。
   *
   * 由页面显式告诉它，不靠 useSlots() 判断：页面还在加载骨架、或者加载失败时，
   * 底下挂着一条什么都没有的空白横条，看起来像按钮没加载出来。
   */
  dock: { type: Boolean, default: false },
  /** 内容区不要左右留白（图片通栏之类） */
  flush: { type: Boolean, default: false },
  /**
   * 内容在纵向居中。只给**内容短到不会滚**的屏用（现在只有首页）。
   */
  center: { type: Boolean, default: false },
})

// computed 而不是取一次值：她在「我的」里改了字号，这一屏要当场跟着变
const fontStyle = computed(() => fontVars())
</script>

<style lang="scss" scoped>
/*
  正文列套一个最大宽度居中（2026-08-30 用户定）。手机上就是满宽；
  桌面上侧边栏占掉左边一条，剩下的空间里正文仍然是居中的一列。

  **宽屏上不把正文拉满**：一份教案两千多字，一行超过 40 个汉字眼睛会串行。
  宽度、卡片、列表照样弹性，只有字号和间距是固定的 ——
  不做「根字号跟视口宽走」那套等比缩放，理由见 CLAUDE.md。
*/
/* 🔴 **不画底色。** 底是 body 的（见 styles/tokens.scss）——
   这里再画一层，桌面上就是一条纵向的白带竖在两边的底色上。
   这一列只负责「有多宽」，不负责「什么颜色」。 */
.s-page {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  max-width: $page-max;
  margin: 0 auto;
}

.s-page__inner {
  flex: 1;
  padding: 0 $sp-5 $sp-5;

  &--flush {
    padding-left: 0;
    padding-right: 0;
  }

  &--center {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
}

.s-page__dock {
  position: sticky;
  bottom: 0;
  z-index: 10;
  background: $paper;
  border-top: 1px solid $rule;
  padding: $sp-3 $sp-5;
  padding-bottom: calc(#{$sp-3} + env(safe-area-inset-bottom));
}

/* 宽屏上正文列放宽一档：侧边栏吃掉了左边，正文这一列可以从 480 放到 640
   而不牺牲可读性（15px 字号下约 40 个汉字一行） */
@media (min-width: 900px) {
  .s-page {
    max-width: 640px;
  }
}
</style>
