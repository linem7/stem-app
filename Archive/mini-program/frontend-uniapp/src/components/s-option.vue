<template>
  <!--
    事件名故意不叫 tap。

    小程序里自定义组件是**真实节点**（uni 没开 virtualHost），根节点这个 view 的原生 tap
    会冒泡穿过 <s-option> 打到父级的 bindtap 上；而 $emit('tap') 编译成
    triggerEvent('tap')，自定义事件名和原生事件名同属一个命名空间，又打一次。
    两条路都命中同一个 bindtap，处理器跑两遍 —— 表现就是「选中了立刻又被取消」。

    改名成 press（小程序没有同名原生事件）之后，父级绑的是 bindpress，
    原生冒泡打不进来，只剩 triggerEvent 一条路。
  -->
  <view class="opt" :class="{ 'opt--sel': selected, 'opt--own': own, 'opt--dim': dim && !selected }" @tap="$emit('press')">
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

defineEmits(['press'])

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
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink-3;
  letter-spacing: 0.02em;
}

.opt__txt {
  flex: 1;
}

.opt__label {
  display: block;
  font-size: var(--fs-body);
  line-height: 1.55;
  color: $ink;
}

.opt__sub {
  display: block;
  font-size: var(--fs-sub);
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

/*
  答过的题里没选中的项要降存在感，但**不能用 opacity 压整块** ——
  那会连文字一起压掉：正文掉到约 3.2:1，「我自己说」那行更是到 2.1:1，
  低于 4.5:1 的下限。老师想回头看看别的选项写的什么就得凑近看。
  改成只降非文字层：底和边框往回收，文字最多降到 $ink-2。
*/
.opt--dim {
  background: $paper-2;
  border-color: $rule;

  .opt__label {
    color: $ink-2;
  }
}
</style>
