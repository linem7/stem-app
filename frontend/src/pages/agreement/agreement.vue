<template>
  <s-page dock>
    <template v-if="viewOnly" #top>
      <s-topbar title="使用协议" />
    </template>
    <text class="kicker">开始之前</text>
    <text class="q">先说清楚我们会记录什么</text>

    <!-- 这段是整页最重要的一句。老师最怕的是园长看到她用 AI 写教案，
         所以「园方看不到」必须在最前面、最显眼，而不是埋在条款里 -->
    <view class="hero">
      <text class="hero__line">你的幼儿园和园长<text class="hero__b">看不到</text>这里的任何东西。</text>
      <text class="hero__line">你写了什么、用了多少次，只有这个项目的团队看得到，不会提供给园方。</text>
    </view>

    <!--
      2026-08-19 改：**不再存手机号**（016 迁移把那一列从库里删掉了）。
      协议这三处原来写着「你填问卷时留的手机号」「你的手机号和姓名不会出现在…」
      「教案配图和你的手机号姓名一起删」——那时是真的，现在全是假话。
      **不实的隐私说明比没有更糟**，所以跟着改，不能留。
    -->
    <view class="sec"><text class="sec__h">会记录的</text></view>
    <view class="dot"><text class="dot__t">你的姓名、幼儿园、班级、岗位 —— 合作园给的名单里那一行</text></view>
    <view class="dot"><text class="dot__t">你在这里的对话、生成的教案和配图、用了多少次</text></view>

    <view class="sec"><text class="sec__h">用来做什么</text></view>
    <view class="dot"><text class="dot__t">确认你是谁、把额度发给你</text></view>
    <view class="dot"><text class="dot__t">研究和改进这个工具</text></view>

    <view class="sec"><text class="sec__h">不会做的</text></view>
    <view class="dot dot--safe">
      <text class="dot__t"><text class="dot__b">不收集孩子的任何信息</text> —— 姓名、照片、观察记录、发展评估，一概不收</text>
    </view>
    <view class="dot dot--safe"><text class="dot__t"><text class="dot__b">不存你的手机号</text></text></view>
    <view class="dot dot--safe"><text class="dot__t">不把你的数据给幼儿园、园长或任何第三方</text></view>
    <view class="dot dot--safe"><text class="dot__t">你的姓名不会出现在这个小程序的任何页面上</text></view>

    <!--
      这一节是从设置页搬过来的（2026-08-18）。原来那两处各写一份隐私说明，
      逐条重复 —— 重复的两份迟早不一致，而不一致的隐私说明比没有更糟。
      协议才是老师首次进来真正签过的那份，所以内容归到这里，设置页只留一个入口。
    -->
    <view class="sec"><text class="sec__h">你随时可以</text></view>
    <view class="dot"><text class="dot__t">在「我的」里改掉或删掉任何一条记忆 —— 它们会被带进每次生成，所以改删权在你手里</text></view>
    <view class="dot"><text class="dot__t">在教案库里删掉任何一份教案</text></view>
    <view class="dot">
      <text class="dot__t">
        在「我的」里<text class="dot__b">删掉全部数据</text> ——
        教案、配图、记忆和你的姓名一起删。删完这个账号就不能再用了，
        已经用于研究的那部分（你提交过的建议和评价）撤不回来，但不再关联到你
      </text>
    </view>

    <text class="meta">
      你输入的内容和 AI 写的内容会经过微信的内容安全检查，这是小程序平台的要求。
    </text>

    <template #dock>
      <s-button v-if="viewOnly" label="看完了" variant="plain" @press="goBack" />
      <s-button v-else label="知道了，开始用" arrow :loading="submitting" @press="submit" />
    </template>
  </s-page>
</template>

<script setup>
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { agree, ensureSession, gate } from '../../stores/session.js'
import { back, reLaunch } from '../../utils/nav.js'
import { showApiError } from '../../utils/ui.js'

const submitting = ref(false)
/** 只是回头看一眼（从设置页进来），不是走激活流程 */
const viewOnly = ref(false)

onLoad(async (query) => {
  // 从设置页点进来是**回头看一眼**，不是走激活流程。
  // 没有这个开关的时候，已经同意过的老师一进来就被 gate 弹回首页 ——
  // 表现是「点了使用协议什么都没发生」，等于这份协议签完就再也找不到了。
  viewOnly.value = String(query?.view || '') === '1'
  if (viewOnly.value) return
  await ensureSession()
  const where = gate()
  if (where === 'redeem') reLaunch('redeem')
  else if (where === 'main') reLaunch('home')
})

function goBack() {
  back()
}

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
  font-size: var(--fs-tag);
  letter-spacing: 0.02em;
  color: $ink-3;
  font-weight: 600;
  margin-top: 40rpx;
}

.q {
  display: block;
  font-size: var(--fs-title);
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
  font-size: var(--fs-body);
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
  font-size: var(--fs-sub);
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
  font-size: var(--fs-read);
  line-height: 1.75;
  color: $ink-2;
}

.dot__b {
  font-weight: 700;
  color: $ink;
}

.meta {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  line-height: 1.7;
  margin-top: 32rpx;
}
</style>
