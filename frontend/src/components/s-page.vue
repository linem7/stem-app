<template>
  <view class="s-page">
    <!-- 全局用了 navigationStyle: custom，状态栏这段得自己让出来 -->
    <view class="s-page__status" :style="{ height: statusH + 'px' }" />

    <slot name="top" />

    <scroll-view
      class="s-page__scroll"
      scroll-y
      :enable-back-to-top="true"
      :scroll-with-animation="false"
    >
      <view class="s-page__inner" :class="{ 's-page__inner--flush': flush }">
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
import { statusBarHeight } from '../utils/ui.js'

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
})

const statusH = statusBarHeight()
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
