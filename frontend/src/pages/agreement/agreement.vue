<template>
  <s-page>
    <text class="kicker">开始之前</text>
    <text class="q">先说清楚我们会记录什么</text>

    <!-- 这段是整页最重要的一句。老师最怕的是园长看到她用 AI 写教案，
         所以「园方看不到」必须在最前面、最显眼，而不是埋在条款里 -->
    <view class="hero">
      <text class="hero__line">你的幼儿园和园长<text class="hero__b">看不到</text>这里的任何东西。</text>
      <text class="hero__line">你写了什么、用了多少次，只有这个项目的团队看得到，不会提供给园方。</text>
    </view>

    <view class="sec"><text class="sec__h">会记录的</text></view>
    <view class="dot"><text class="dot__t">你填问卷时留的手机号、姓名、幼儿园、班级、岗位</text></view>
    <view class="dot"><text class="dot__t">你在这里的对话、生成的教案和配图、用了多少次</text></view>

    <view class="sec"><text class="sec__h">用来做什么</text></view>
    <view class="dot"><text class="dot__t">确认你是谁、把额度发给你</text></view>
    <view class="dot"><text class="dot__t">研究和改进这个工具</text></view>

    <view class="sec"><text class="sec__h">不会做的</text></view>
    <view class="dot dot--safe">
      <text class="dot__t"><text class="dot__b">不收集孩子的任何信息</text> —— 姓名、照片、观察记录、发展评估，一概不收</text>
    </view>
    <view class="dot dot--safe"><text class="dot__t">不把你的数据给幼儿园、园长或任何第三方</text></view>
    <view class="dot dot--safe"><text class="dot__t">你的手机号和姓名不会出现在这个小程序的任何页面上</text></view>

    <text class="meta">
      你输入的内容和 AI 写的内容会经过微信的内容安全检查，这是小程序平台的要求。
    </text>

    <template #dock>
      <s-button label="知道了，开始用" arrow :loading="submitting" @tap="submit" />
    </template>
  </s-page>
</template>

<script setup>
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { agree, ensureSession, gate } from '../../stores/session.js'
import { reLaunch } from '../../utils/nav.js'
import { showApiError } from '../../utils/ui.js'

const submitting = ref(false)

onLoad(async () => {
  await ensureSession()
  const where = gate()
  if (where === 'redeem') reLaunch('redeem')
  else if (where === 'main') reLaunch('home')
})

async function submit() {
  if (submitting.value) return
  submitting.value = true
  try {
    await agree()
    reLaunch('home')
  } catch (err) {
    showApiError(err)
  } finally {
    submitting.value = false
  }
}
</script>

<style lang="scss" scoped>
.kicker {
  display: block;
  font-size: $fs-tag;
  letter-spacing: 0.02em;
  color: $ink-3;
  font-weight: 600;
  margin-top: 40rpx;
}

.q {
  display: block;
  font-size: 42rpx;
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
  line-height: 1.45;
  margin: 12rpx 0 32rpx;
}

.hero {
  background: $mint-soft;
  border: 2rpx solid $mint-line;
  border-radius: $r-card;
  padding: 26rpx 28rpx;
}

.hero__line {
  display: block;
  font-size: 29rpx;
  line-height: 1.75;
  color: $ink;

  & + & {
    margin-top: 8rpx;
  }
}

.hero__b {
  font-weight: 700;
  color: $mint-deep;
}

.sec {
  padding: 0 0 16rpx;
  margin-top: 34rpx;
}

.sec__h {
  font-size: 26rpx;
  font-weight: 700;
  color: $ink-2;
  letter-spacing: 0.04em;
}

.dot {
  position: relative;
  padding-left: 30rpx;
  margin-bottom: 10rpx;
}

.dot::before {
  content: '';
  position: absolute;
  left: 4rpx;
  top: 18rpx;
  width: 10rpx;
  height: 10rpx;
  border-radius: 999rpx;
  background: $mint;
}

/* 「不会做的」这组用珊瑚色圆点 —— 与上面两组区分开，且不只靠颜色：文案本身就是否定句 */
.dot--safe::before {
  background: $coral;
}

.dot__t {
  font-size: 27rpx;
  line-height: 1.75;
  color: $ink-2;
}

.dot__b {
  font-weight: 700;
  color: $ink;
}

.meta {
  display: block;
  font-size: $fs-sub;
  color: $ink-3;
  line-height: 1.7;
  margin-top: 32rpx;
}
</style>
