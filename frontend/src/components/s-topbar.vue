<template>
  <view class="s-topbar">
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

const props = defineProps({
  title: { type: String, default: '' },
  showBack: { type: Boolean, default: true },
})

const emit = defineEmits(['back'])
const backIcon = iconBack()

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
  min-height: 76rpx;
}

.s-topbar__back {
  width: 56rpx;
  height: 56rpx;
  border-radius: $r-sm;
  border: 2rpx solid $rule;
  background: $paper-2;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 18rpx;
}

.s-topbar__back-icon {
  width: 30rpx;
  height: 30rpx;
}

.s-topbar__title {
  font-size: 27rpx;
  font-weight: 600;
  color: $ink-2;
  letter-spacing: 0.02em;
}

.s-topbar__slot {
  flex: 1;
  display: flex;
  justify-content: flex-end;
  align-items: center;
}
</style>
