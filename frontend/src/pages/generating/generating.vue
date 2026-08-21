<template>
  <!--
    **只在真的有按钮时才留操作条。**
    dock 那条横杠自己带一道上边框和底色，里面没东西时就是一条空白横条,
    看起来像按钮没加载出来。所以这里判的是「有没有按钮」，不是「有没有写完」。

    现在只有三种情况有按钮：断网（接着等）、真没写成（再试一次）、
    写完了但后端没回 id（去教案库找 —— 那条路唯一的出口）。
    **正常等待中没有按钮**（2026-08-21 用户去掉了「去教案库等」）。
  -->
  <s-page :dock="hasDockButton">
    <template #top>
      <s-topbar :title="headline" />
    </template>

    <view class="hd">
      <text class="kicker">{{ isRevise ? '正在改' : '正在写' }}</text>
      <!-- 「二三十秒」改成「20-30 秒」（用户 2026-08-21）：口语的约数读起来像敷衍，
           而她要的是一个能对表的数 —— 20 到 30 才是真实区间 -->
      <text class="q">{{ done ? (isRevise ? '改好了' : '写好了') : '等我 20-30 秒' }}</text>
    </view>

    <!-- 阶段清单。progress_hint 由后端按生成阶段推进，等待才有反馈 -->
    <view v-for="(s, i) in steps" :key="s" class="step" :class="stepClass(i)">
      <view class="step__ic" :class="stepClass(i)">
        <image v-if="stepIndex > i || done" class="step__check" :src="checkWhite" mode="widthFix" />
      </view>
      <text class="step__t">{{ s }}</text>
    </view>

    <view v-if="hint && !failed" class="hint"><text class="hint__t">{{ hint }}</text></view>

    <view v-if="failed" class="fail" :class="{ 'fail--net': failKind === 'net' }">
      <text class="fail__t" :class="{ 'fail__t--net': failKind === 'net' }">{{ failMessage }}</text>
      <!-- 只说否定的那一面。网通着就不说话 —— 理由同 s-state：别编「网回来了」 -->
      <text v-if="failKind === 'net' && !net.online" class="fail__live">还是没有网络</text>
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
      <!--
        写完直接跳，**不给按钮**（2026-08-20 用户定）。
        她本来就在等结果，跳转前闪一下「去看教案」只是多一个来不及点的按钮。

        `lessonPlanId` 为 0 时才留着它 —— 那种情况自动跳转跳不了
        （后端没回 id），没有这个按钮她就困在这一屏了。
        所以这不是「以防万一」，是那条路唯一的出口。
      -->
      <s-button
        v-if="done && !lessonPlanId"
        label="去教案库找"
        arrow
        @press="leave"
      />
      <!--
        断网和「真的没写成」是两件事，按钮不能是同一个：
        · 断网 → 后端还在写，只要**接着轮询**。不花钱、幂等，所以网一回来自动就接上了
        · 没写成 → 要**重新生成**，那是一次真的模型调用。绝不能自动触发
        原来两条都走 startGenerate，等于每次弱网抖一下就白花一次钱重写一遍。
      -->
      <s-button
        v-else-if="failed && failKind === 'net'"
        label="接着等"
        arrow
        @press="resume"
      />
      <s-button
        v-else-if="failed"
        label="再试一次"
        arrow
        :loading="restarting"
        loading-text="正在重试"
        @press="retry"
      />
      <!--
        原来这里还有一个「去教案库等」（`v-else`，也就是**等待中一直挂着**）。
        2026-08-21 用户去掉了：等待中不该劝她走。而且这一屏本来就有两个离开的出口
        （中间那块「可以先去忙」+ 顶栏返回），底下再摆一个是第三个。

        去掉按钮之后 **dock 必须跟着收掉** —— 那条横杠自己带上边框和底色，
        留着就是一条空白横条，看起来像按钮没加载出来。
        所以上面 s-page 的 :dock 判的是「到底有没有按钮」，不是「有没有写完」。
      -->
    </template>
  </s-page>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { onLoad, onUnload } from '@dcloudio/uni-app'
import { pollGenerate, startGenerate } from '../../api/conversations.js'
import { net } from '../../stores/net.js'
import { iconCheck } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { redirectTo, reLaunch } from '../../utils/nav.js'
import { showApiError } from '../../utils/ui.js'

const checkWhite = iconCheck(COLORS.white, 2.6)

// 后端的 progress_hint 是自由文案，这里只用来给一个「走到哪了」的粗略进度条。
// 真正给老师看的那句话是 hint，原样显示后端给的。
const STEPS = ['读你答的那几题', '设计活动流程', '按年龄班校一遍']
// 改稿走的是同一条链路，只有第一步读的东西不一样 —— 她提的意见 + 刚答的三题
const REVISE_STEPS = ['读你提的意见', '重排活动流程', '按年龄班校一遍']

const conversationId = ref(0)
const hint = ref('正在准备…')
const stepIndex = ref(0)
const done = ref(false)
const failed = ref(false)
const failMessage = ref('')
/**
 * 怎么失败的。决定那个按钮做什么，也决定能不能自动重来。
 *  'net'     轮询断了 —— 后端还在写，接着轮询就行（幂等、不花钱）
 *  'gen'     后端说没写成 —— 要重新生成，那是真的一次模型调用
 *  'timeout' 等了两分钟还没完 —— 它多半还在写，去教案库看
 */
const failKind = ref('gen')
const restarting = ref(false)
const lessonPlanId = ref(0)
/** 从改一改过来的。只影响文案，链路完全一样 */
const isRevise = ref(false)
const headline = computed(() => (isRevise.value ? '正在改教案' : '正在写教案'))

/**
 * 底下那条操作条里到底有没有按钮。
 *
 * 三个条件跟下面 #dock 里那三个 s-button 的 v-if 链**一一对应**，
 * 加一个按钮就要同时加在这里 —— 少加了就是「按钮画在了收起来的条里」（点不到），
 * 多算了就是「一条空白横条」。这两个地方必须一起改。
 */
const hasDockButton = computed(
  () => failed.value || (done.value && !lessonPlanId.value)
)
const steps = computed(() => (isRevise.value ? REVISE_STEPS : STEPS))

let handle = null

const stepClass = (i) => ({
  'is-done': done.value || stepIndex.value > i,
  'is-now': !done.value && stepIndex.value === i,
})

onLoad((query) => {
  conversationId.value = Number(query?.id || 0)
  isRevise.value = String(query?.revise || '') === '1'
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
        failKind.value = 'gen'
        failMessage.value =
          d.message ||
          (isRevise.value ? '这次没改成，再试一次通常就好。' : '这次没写成。换个说法再试一次通常就好。')
        return
      }
      done.value = true
      stepIndex.value = steps.value.length
      hint.value = isRevise.value ? '改好了' : '写好了'
      lessonPlanId.value = d.lesson_plan_id || 0
      // 写完直接进成稿，不让她再点一下 —— 她就是在等这个结果。
      // 留一小段是为了让最后那个勾能被看见，不然屏幕像是闪了一下。
      if (lessonPlanId.value) setTimeout(openPlan, 450)
    })
    .catch((err) => {
      failed.value = true
      if (err?.message === 'POLL_TIMEOUT') {
        failKind.value = 'timeout'
        failMessage.value = '等了两分钟还没写完。它多半还在后台写，去教案库看看。'
        return
      }
      // 请求根本没发出去 —— 那是网的事，教案在后端好好地写着。
      // 这一条**绝不能走「重新生成」**：弱网抖一下就重写一遍，白花一次钱，
      // 而且她会拿到一份跟刚才不一样的教案
      failKind.value = err?.code === 'NETWORK' ? 'net' : 'gen'
      failMessage.value =
        failKind.value === 'net'
          ? '网断了，不过教案还在后台写着。等网回来我就接着看。'
          : err?.message || '出了点问题，再试一次'
    })
}

/** 只接着轮询，不重新生成。断网那条路唯一该走的动作 */
function resume() {
  start()
}

/**
 * 网一回来就自己接上。
 * 只在 failKind === 'net' 时成立 —— 别的失败都要她自己决定要不要再花一次。
 */
watch(
  () => net.online,
  (now, before) => {
    if (now && !before && failed.value && failKind.value === 'net') resume()
  }
)

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
  font-size: var(--fs-tag);
  color: $ink-3;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.q {
  display: block;
  font-size: var(--fs-title);
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
  font-size: var(--fs-read);
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
  font-size: var(--fs-sub);
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
  font-size: var(--fs-sub);
  color: $coral-deep;
  line-height: 1.7;

  /* 断网不是事故，别画成红的 —— 中性提示用天空蓝（design-tokens 规则 4） */
  &--net {
    color: $sky-deep;
  }
}

.fail--net {
  background: $sky-soft;
  border-color: $sky-line;
}

.fail__live {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  margin-top: 6rpx;
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
  font-size: var(--fs-body);
  font-weight: 600;
  color: $mint-deep;
  line-height: 1.5;
}

.leave__s {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.5;
  margin-top: 4rpx;
}
</style>
