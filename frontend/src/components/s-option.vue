<template>
  <view class="opt" :class="{ 'opt--sel': selected, 'opt--own': own, 'opt--dim': dim && !selected }" @tap="$emit('tap')">
    <view class="opt__key"><text class="opt__key-t">{{ okey }}</text></view>
    <view class="opt__txt">
      <text class="opt__label">{{ label }}</text>
      <text v-if="sub" class="opt__sub">{{ sub }}</text>
    </view>
    <!-- 选中同时有底色、边框、字重和这个勾 —— 颜色不做状态的唯一载体 -->
    <image v-if="selected" class="opt__check" :src="checkIcon" mode="widthFix" />
  </view>
</template>

<script setup>
import { iconCheck } from '../utils/icons.js'

defineProps({
  /** A / B / C / D */
  okey: { type: String, default: '' },
  label: { type: String, default: '' },
  sub: { type: String, default: '' },
  selected: { type: Boolean, default: false },
  /** 「我自己说」那一项：虚线框 */
  own: { type: Boolean, default: false },
  /** 这题已经答过了，没选中的项降一档存在感，让视线落到还没答的题上 */
  dim: { type: Boolean, default: false },
})

defineEmits(['tap'])

const checkIcon = iconCheck()
</script>

<style lang="scss" scoped>
.opt {
  display: flex;
  align-items: flex-start;
  width: 100%;
  background: $white;
  border: 2rpx solid $rule-2;
  border-radius: $r-btn;
  padding: 26rpx 26rpx 26rpx 24rpx;
  margin-bottom: 18rpx;
}

.opt__key {
  flex: none;
  width: 46rpx;
  height: 46rpx;
  border-radius: 16rpx;
  border: 2rpx solid $rule-2;
  background: $paper-2;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 2rpx;
  margin-right: 22rpx;
}

.opt__key-t {
  font-size: 24rpx;
  font-weight: 700;
  color: $ink-3;
  letter-spacing: 0.02em;
}

.opt__txt {
  flex: 1;
}

.opt__label {
  display: block;
  font-size: 30rpx;
  line-height: 1.55;
  color: $ink;
}

.opt__sub {
  display: block;
  font-size: 25rpx;
  color: $ink-3;
  margin-top: 4rpx;
  line-height: 1.5;
}

.opt__check {
  flex: none;
  width: 32rpx;
  height: 32rpx;
  margin-top: 6rpx;
  margin-left: 12rpx;
}

.opt--sel {
  background: $amber-soft;
  border-color: $amber-line;
  box-shadow: 0 0 0 2rpx $amber-line, 0 4rpx 16rpx rgba(138, 100, 16, 0.14);

  .opt__key {
    background: $amber;
    border-color: $amber;

    .opt__key-t {
      color: $ink;
    }
  }

  .opt__label {
    font-weight: 600;
  }
}

.opt--own {
  background: transparent;
  border-style: dashed;

  .opt__label {
    color: $ink-3;
  }
}

.opt--dim {
  opacity: 0.55;
}
</style>
