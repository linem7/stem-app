<template>
  <!--
    根节点上内联八个字号变量。底下所有页面内容和子组件里的 var(--fs-body) 靠继承拿到它，
    所以整套字号必须走 CSS 变量 —— SCSS 变量在编译期就写死了，继承不了。

    **为什么是内联 style 而不是一个类**：微信自定义组件默认样式隔离，
    app.wxss 里的类选择器进不了组件内部，而这个根节点正在组件内部。
    那条路会静默失效（编译不报错、H5 预览还是对的，只有微信里调到特大什么都没变）。
    详见 utils/typography.js 的文件头。
  -->
  <view class="s-page" :style="fontStyle">
    <!-- 全局用了 navigationStyle: custom，状态栏这段得自己让出来 -->
    <view class="s-page__status" :style="{ height: statusH + 'px' }" />

    <slot name="top" />

    <scroll-view
      class="s-page__scroll"
      scroll-y
      :enable-back-to-top="true"
      :scroll-with-animation="false"
    >
      <view
        class="s-page__inner"
        :class="{ 's-page__inner--flush': flush, 's-page__inner--center': center }"
      >
        <slot />
      </view>
    </scroll-view>

    <!-- 拇指位常驻操作条。方向 B 的核心资产之一，主行动永远在够得着的地方 -->
    <view v-if="dock" class="s-page__dock">
      <slot name="dock" />
    </view>

    <s-tabbar v-if="tab" :active="tab" />
  </view>
</template>

<script setup>
import { computed } from 'vue'
import { statusBarHeight } from '../utils/ui.js'
import { fontVars } from '../stores/prefs.js'

defineProps({
  /** 'home' | 'library' | 'me'，传了才显示底部 tab */
  tab: { type: String, default: '' },
  /**
   * 要不要显示底部操作条。
   *
   * 原来是用 useSlots() 判断的，在小程序端不成立 —— 插槽是**编译期静态声明**的
   * （wxml 上那句 u-s="{{['top','dock','d']}}"），运行时 slots.dock 恒为真。
   * 结果是页面还在加载骨架、或者加载失败时，底下也挂着一条什么都没有的空白横条，
   * 看起来像按钮没加载出来。改成由页面显式告诉它。
   */
  dock: { type: Boolean, default: false },
  /** 内容区不要左右留白（图片通栏之类） */
  flush: { type: Boolean, default: false },
  /**
   * 内容在纵向居中。只给**内容短到不会滚**的屏用（现在只有首页）。
   *
   * 内容一旦长过一屏，`justify-content:center` 会把顶部溢出的那截顶到
   * 滚动区外面去、还滚不回来 —— 那是这个属性唯一的坑，别顺手加到别的屏上。
   */
  center: { type: Boolean, default: false },
})

const statusH = statusBarHeight()

// computed 而不是取一次值：她在「我的」里改了字号，这一屏要当场跟着变
const fontStyle = computed(() => fontVars())
</script>

<style lang="scss" scoped>
.s-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: $paper;
}

.s-page__status {
  flex: none;
}

.s-page__scroll {
  flex: 1;
  // 不写 height:0 的话，小程序里 scroll-view 会被内容撑开，flex:1 形同虚设，整页就不滚了
  height: 0;
}

.s-page__inner {
  padding: 0 $sp-5 $sp-5;

  &--flush {
    padding-left: 0;
    padding-right: 0;
  }

  /*
    纵向居中。`min-height:100%` 能生效是因为外层 .s-page__scroll 有确定高度
    （flex:1 + height:0，装在 height:100vh 的 flex 列里）—— 百分比有东西可以算。
    用 min-height 而不是 height：内容万一长过一屏，它还能被撑开继续滚，
    而 height:100% 会把多出来的部分裁掉。
  */
  &--center {
    min-height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
}

.s-page__dock {
  flex: none;
  border-top: 2rpx solid $rule;
  background: $paper;
  padding: $sp-3 $sp-5 $sp-3;
  padding-bottom: calc(#{$sp-3} + constant(safe-area-inset-bottom));
  padding-bottom: calc(#{$sp-3} + env(safe-area-inset-bottom));
}
</style>
