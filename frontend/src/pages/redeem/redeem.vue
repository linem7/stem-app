<template>
  <s-page>
    <image class="illo" :src="illo" mode="widthFix" />

    <text class="q">输入兑换码就能开始</text>
    <text class="meta meta--lead">
      这个小程序目前只开放给合作园的老师。填过问卷之后，你会收到一个兑换码。
    </text>

    <view class="ask">
      <input
        v-model="code"
        class="ask__input"
        placeholder="STEM-XXXX-XXXX"
        placeholder-class="ask__ph"
        :disabled="submitting"
        confirm-type="done"
        @confirm="submit"
      />
      <text class="meta">大小写、空格都不影响，照着微信里发你的敲就行。</text>
    </view>

    <view class="act">
      <s-button
        label="激活"
        arrow
        :disabled="!code.trim()"
        :loading="submitting"
        loading-text="正在激活"
        @tap="submit"
      />
    </view>

    <text class="meta meta--foot">还没有码？找发问卷给你的那位老师要。</text>
  </s-page>
</template>

<script setup>
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { illoRedeem } from '../../utils/illustrations.js'
import { ensureSession, gate, redeem } from '../../stores/session.js'
import { reLaunch } from '../../utils/nav.js'
import { showApiError } from '../../utils/ui.js'

const illo = illoRedeem()
const code = ref('')
const submitting = ref(false)

onLoad(async () => {
  await ensureSession()
  // 已经激活过的老师不该停在这页（比如换设备重登、或者从别处误跳进来）
  const where = gate()
  if (where === 'agreement') reLaunch('agreement')
  else if (where === 'main') reLaunch('home')
})

async function submit() {
  if (submitting.value || !code.value.trim()) return
  submitting.value = true
  try {
    await redeem(code.value)
    // 激活完必然还没同意协议，直接送过去，不让她再点一次
    reLaunch('agreement')
  } catch (err) {
    showApiError(err)
  } finally {
    submitting.value = false
  }
}
</script>

<style lang="scss" scoped>
.illo {
  width: 100%;
  margin-top: 60rpx;
  border-radius: $r-card;
}

.q {
  display: block;
  font-size: 42rpx;
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
  line-height: 1.45;
  margin: 36rpx 0 16rpx;
}

.meta {
  display: block;
  font-size: $fs-sub;
  color: $ink-3;
  line-height: 1.7;
}

.meta--lead {
  margin-bottom: 36rpx;
}

.meta--foot {
  margin-top: 28rpx;
  text-align: center;
}

.ask {
  border: 2rpx solid $rule;
  border-radius: $r-input;
  background: $white;
  padding: 30rpx 32rpx 24rpx;
  box-shadow: $shadow-card;
}

.ask__input {
  width: 100%;
  font-size: 34rpx;
  color: $ink;
  letter-spacing: 0.08em;
  line-height: 1.6;
  padding-bottom: 18rpx;
}

.ask__ph {
  color: $ink-3;
  letter-spacing: 0.08em;
}

.act {
  margin-top: 36rpx;
}
</style>
