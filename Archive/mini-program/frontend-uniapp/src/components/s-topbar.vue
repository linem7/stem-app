<template>
  <view class="s-topbar" :style="{ paddingRight: capsulePad + 'px' }">
    <view v-if="showBack" class="s-topbar__back" @tap="onBack">
      <image class="s-topbar__back-icon" :src="backIcon" mode="widthFix" />
    </view>
    <text v-if="title" class="s-topbar__title">{{ title }}</text>
    <view class="s-topbar__slot"><slot /></view>
  </view>
</template>

<script setup>
import { iconBack } from '../utils/icons.js'
import { back } from '../utils/nav.js'

defineProps({
  title: { type: String, default: '' },
  showBack: { type: Boolean, default: true },
})

const emit = defineEmits(['back'])
const backIcon = iconBack()

/**
 * 右侧要给微信胶囊让位。
 * 全局用了 navigationStyle: custom，胶囊还在那儿浮着，标题长了会钻到它底下。
 * 拿不到就按 100px 兜底（胶囊实际约 87px + 边距）。
 */
const capsulePad = (() => {
  try {
    const r = uni.getMenuButtonBoundingClientRect?.()
    const w = uni.getWindowInfo ? uni.getWindowInfo().windowWidth : 375
    if (r && r.left) return Math.max(0, Math.round(w - r.left + 8))
  } catch (e) {
    /* 工具里偶尔取不到，走兜底 */
  }
  return 100
})()

function onBack() {
  emit('back')
  back()
}
</script>

<style lang="scss" scoped>
.s-topbar {
  flex: none;
  display: flex;
  align-items: center;
  padding: 10rpx $sp-5 14rpx;
  /* 固定高度，不用 min-height —— 标题一长就把整条撑高，下面的内容全被挤走 */
  height: 92rpx;
  overflow: hidden;
}

/* 全局 navigationStyle:custom，这是唯一的返回入口，触控区不能小于 44px */
.s-topbar__back {
  width: 88rpx;
  height: 88rpx;
  border-radius: $r-sm;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 8rpx;
  margin-left: -20rpx;
}

.s-topbar__back-icon {
  width: 30rpx;
  height: 30rpx;
}

/* 教案标题可以很长（首页输入框放到 200 字），必须单行截断 */
.s-topbar__title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sub);
  font-weight: 600;
  color: $ink-2;
  letter-spacing: 0.02em;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.s-topbar__slot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
</style>
