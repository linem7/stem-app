<template>
  <view v-if="visible" class="sheet">
    <!-- 蒙层。点它关掉 —— 老师误触时最自然的退出方式是点旁边 -->
    <view class="sheet__mask" @tap="$emit('close')" />
    <view class="sheet__panel">
      <view class="sheet__hd">
        <text class="sheet__title">{{ title }}</text>
        <view class="sheet__x" @tap="$emit('close')"><text class="sheet__x-t">关闭</text></view>
      </view>
      <scroll-view class="sheet__body" scroll-y>
        <view class="sheet__inner"><slot /></view>
      </scroll-view>
      <view v-if="hasFoot" class="sheet__foot"><slot name="foot" /></view>
    </view>
  </view>
</template>

<script setup>
/**
 * 底部抽屉。
 *
 * 起因：配图原来是「点按钮 → 材料清单变成可点 → 滚回页面上方去点」，
 * 老师点完按钮站在页面底部，要往上翻半屏才知道该干什么。
 * 抽屉从底下上来，选择就在拇指够得到的地方。
 */
defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '' },
  hasFoot: { type: Boolean, default: false },
})

defineEmits(['close'])
</script>

<style lang="scss" scoped>
.sheet {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 900;
}

.sheet__mask {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  background: rgba(58, 54, 48, 0.45);
}

.sheet__panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: $paper;
  border-top-left-radius: 44rpx;
  border-top-right-radius: 44rpx;
  box-shadow: $shadow-float;
}

.sheet__hd {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 32rpx $sp-5 20rpx;
  border-bottom: 2rpx solid $rule;
}

.sheet__title {
  font-size: 34rpx;
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.01em;
}

.sheet__x {
  padding: 8rpx 20rpx;
  border-radius: $r-chip;
  border: 2rpx solid $rule-2;
  background: $paper-2;
}

.sheet__x-t {
  font-size: 25rpx;
  color: $ink-2;
}

.sheet__body {
  flex: 1;
  /* 不写这句的话 scroll-view 会被内容撑开，抽屉直接顶穿屏幕 */
  height: 0;
}

.sheet__inner {
  padding: 26rpx $sp-5 20rpx;
}

.sheet__foot {
  flex: none;
  padding: 18rpx $sp-5 20rpx;
  padding-bottom: calc(20rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
  border-top: 2rpx solid $rule;
}
</style>
