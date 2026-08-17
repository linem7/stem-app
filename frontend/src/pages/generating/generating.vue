<template>
  <s-page :dock="true">
    <template #top>
      <s-topbar :title="headline" />
    </template>

    <view class="hd">
      <text class="kicker">正在写</text>
      <text class="q">{{ done ? '写好了' : '给我二三十秒' }}</text>
    </view>

    <!-- 阶段清单。progress_hint 由后端按生成阶段推进，等待才有反馈 -->
    <view v-for="(s, i) in STEPS" :key="s" class="step" :class="stepClass(i)">
      <view class="step__ic" :class="stepClass(i)">
        <image v-if="stepIndex > i || done" class="step__check" :src="checkWhite" mode="widthFix" />
      </view>
      <text class="step__t">{{ s }}</text>
    </view>

    <view v-if="hint && !failed" class="hint"><text class="hint__t">{{ hint }}</text></view>

    <view v-if="failed" class="fail">
      <text class="fail__t">{{ failMessage }}</text>
    </view>

    <!--
      「可以离开」不是安慰话，是产品要求：老师在幼儿园随时被叫走，
      不能要求她盯着屏幕等 30 秒。后端会继续写完，教案库里找得回。
    -->
    <view v-if="!done && !failed" class="leave" @tap="leave">
      <view class="leave__t">
        <text class="leave__h">可以先去忙</text>
        <text class="leave__s">写好了在教案库里等你，不用守着</text>
      </view>
    </view>

    <template #dock>
      <s-button
        v-if="done"
        label="看看写成什么样"
        arrow
        @press="openPlan"
      />
      <s-button
        v-else-if="failed"
        label="再试一次"
        arrow
        :loading="restarting"
        loading-text="正在重试"
        @press="retry"
      />
      <s-button v-else label="去教案库等" variant="plain" @press="leave" />
    </template>
  </s-page>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import { pollGenerate, startGenerate } from '../../api/conversations.js'
import { iconCheck } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { redirectTo, reLaunch } from '../../utils/nav.js'
import { showApiError } from '../../utils/ui.js'

const checkWhite = iconCheck(COLORS.white, 2.6)

// 后端的 progress_hint 是自由文案，这里只用来给一个「走到哪了」的粗略进度条。
// 真正给老师看的那句话是 hint，原样显示后端给的。
const STEPS = ['读你答的那几题', '设计活动流程', '按年龄班校一遍']

const conversationId = ref(0)
const hint = ref('正在准备…')
const stepIndex = ref(0)
const done = ref(false)
const failed = ref(false)
const failMessage = ref('')
const restarting = ref(false)
const lessonPlanId = ref(0)
const headline = ref('正在写教案')

let handle = null

const stepClass = (i) => ({
  'is-done': done.value || stepIndex.value > i,
  'is-now': !done.value && stepIndex.value === i,
})

onLoad((query) => {
  conversationId.value = Number(query?.id || 0)
  start()
})

// 必须停。老师退出去了还在打请求是不对的 —— 后端会自己写完，她回教案库照样看得到
onUnload(() => stop())

function stop() {
  if (handle) {
    handle.stop()
    handle = null
  }
}

function start() {
  stop()
  failed.value = false
  done.value = false
  handle = pollGenerate(conversationId.value, {
    onTick: (d) => {
      if (d.progress_hint) {
        hint.value = d.progress_hint
        // 后端阶段文案里带「检查/校」的是最后一段，其余按出现顺序往前推
        if (/检查|适合|校/.test(d.progress_hint)) stepIndex.value = 2
        else if (/流程|环节|设计/.test(d.progress_hint)) stepIndex.value = 1
        else stepIndex.value = 0
      }
    },
  })

  handle.promise
    .then((d) => {
      if (d.status === 'failed') {
        failed.value = true
        failMessage.value = d.message || '这次没写成。换个说法再试一次通常就好。'
        return
      }
      done.value = true
      stepIndex.value = STEPS.length
      hint.value = '写好了'
      lessonPlanId.value = d.lesson_plan_id || 0
    })
    .catch((err) => {
      failed.value = true
      failMessage.value =
        err?.message === 'POLL_TIMEOUT'
          ? '等了两分钟还没写完。它多半还在后台写，去教案库看看。'
          : err?.message || '出了点问题，再试一次'
    })
}

function openPlan() {
  stop()
  redirectTo('plan', { id: lessonPlanId.value, conversation_id: conversationId.value })
}

function leave() {
  stop()
  reLaunch('library')
}

async function retry() {
  if (restarting.value) return
  restarting.value = true
  try {
    await startGenerate(conversationId.value)
    stepIndex.value = 0
    hint.value = '正在准备…'
    start()
  } catch (err) {
    showApiError(err)
  } finally {
    restarting.value = false
  }
}
</script>

<style lang="scss" scoped>
.hd {
  margin: 24rpx 0 40rpx;
}

.kicker {
  display: block;
  font-size: $fs-tag;
  color: $ink-3;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.q {
  display: block;
  font-size: 42rpx;
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
  line-height: 1.45;
  margin-top: 10rpx;
}

.step {
  display: flex;
  align-items: center;
  padding: 14rpx 0;
}

.step__ic {
  flex: none;
  width: 36rpx;
  height: 36rpx;
  border-radius: 999rpx;
  border: 3rpx solid $rule-2;
  margin-right: 20rpx;
  display: flex;
  align-items: center;
  justify-content: center;

  &.is-done {
    background: $mint-deep;
    border-color: $mint-deep;
  }

  &.is-now {
    background: $amber;
    border-color: $amber-deep;
  }
}

.step__check {
  width: 22rpx;
  height: 22rpx;
}

.step__t {
  flex: 1;
  font-size: 29rpx;
  color: $ink-3;
  line-height: 1.5;
}

/* 走到哪一步不只靠颜色：当前那步字加粗、做完的转成次级色 */
.step.is-now .step__t {
  color: $ink;
  font-weight: 600;
}

.step.is-done .step__t {
  color: $ink-2;
}

.hint {
  background: $sky-soft;
  border-radius: 20rpx;
  padding: 18rpx 24rpx;
  margin-top: 24rpx;
}

.hint__t {
  font-size: $fs-sub;
  color: $ink-2;
  line-height: 1.65;
}

.fail {
  background: $paper-2;
  border: 2rpx solid $coral;
  border-radius: 20rpx;
  padding: 20rpx 24rpx;
  margin-top: 24rpx;
}

.fail__t {
  font-size: $fs-sub;
  color: $coral-deep;
  line-height: 1.7;
}

.leave {
  display: flex;
  align-items: center;
  background: $mint-soft;
  border: 2rpx solid $mint-line;
  border-radius: 28rpx;
  padding: 24rpx 28rpx;
  margin-top: 32rpx;
}

.leave__t {
  flex: 1;
}

.leave__h {
  display: block;
  font-size: 28rpx;
  font-weight: 600;
  color: $mint-deep;
  line-height: 1.5;
}

.leave__s {
  display: block;
  font-size: $fs-tag;
  color: $ink-3;
  line-height: 1.5;
  margin-top: 4rpx;
}
</style>
