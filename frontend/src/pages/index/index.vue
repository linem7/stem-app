<template>
  <s-page tab="home">
    <!-- 首页内容在下一步做（屏①）。这一版只把进门闸门跑通。 -->
    <view v-if="!session.ready" class="boot">
      <view class="boot__bar" />
      <view class="boot__bar boot__bar--short" />
    </view>

    <view v-else-if="session.bootError" class="boot">
      <text class="boot__msg">{{ session.bootError.message }}</text>
      <s-button label="重试" variant="plain" @tap="retry" />
    </view>
  </s-page>
</template>

<script setup>
import { onLoad, onShow } from '@dcloudio/uni-app'
import { ensureSession, gate, session } from '../../stores/session.js'
import { reLaunch } from '../../utils/nav.js'

onLoad(() => routeByGate())
// 从待激活/协议页 reLaunch 回来时 onLoad 不再触发，onShow 再兜一次
onShow(() => routeByGate())

async function routeByGate() {
  await ensureSession()
  if (session.bootError) return
  const where = gate()
  if (where === 'redeem') reLaunch('redeem')
  else if (where === 'agreement') reLaunch('agreement')
}

function retry() {
  session.ready = false
  routeByGate()
}
</script>

<style lang="scss" scoped>
.boot {
  padding-top: 80rpx;
}

/* 骨架屏而不是转圈 —— 布局稳定不跳动（api-spec 第 9 节） */
.boot__bar {
  height: 40rpx;
  border-radius: $r-sm;
  background: $paper-2;
  margin-bottom: 20rpx;

  &--short {
    width: 55%;
  }
}

.boot__msg {
  display: block;
  font-size: $fs-body;
  color: $ink-2;
  line-height: 1.7;
  margin-bottom: 32rpx;
}
</style>
