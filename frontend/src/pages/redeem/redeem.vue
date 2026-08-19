<template>
  <s-page>
    <image v-show="step === 'code'" class="illo" :src="illo" mode="widthFix" />

    <!--
      同一个页面管三件事，因为对老师来说它们是同一个动作：输一个码。
        · 首次激活：码 → 从名单里选自己是哪一位
        · 续兑：完成任务拿到新码，只要码
        · 换绑：换了微信，输我给她的换绑码，也只要码
      她分不出也不需要分 —— 后端认得出来。
    -->
    <text class="q">{{ title }}</text>
    <text v-show="step === 'code' && !topup" class="meta meta--lead">
      这个小程序目前只开放给合作园的老师。填过问卷之后，你会收到一个兑换码。
    </text>

    <!-- ① 输码 -->
    <view v-show="step === 'code'" class="ask">
      <input
        v-model="code"
        class="ask__input"
        placeholder="STEM-XXXX-XXXX"
        placeholder-class="ask__ph"
        :disabled="submitting"
        confirm-type="done"
        @confirm="onCodeNext"
      />
      <text class="meta">大小写、空格都不影响，照着发你的那串敲就行。</text>
    </view>

    <!-- ② 选园所 -->
    <view v-show="step === 'kg'" class="pick">
      <view
        v-for="k in kindergartens"
        :key="`k-${k.id}`"
        class="pick__row"
        @tap="pickKg(k)"
      >
        <text class="pick__t">{{ k.name }}</text>
        <text class="pick__s">{{ k.open }} 个</text>
      </view>
      <text v-if="!kindergartens.length" class="meta">
        名单里还没有空位。跟发码给你的人说一声。
      </text>
    </view>

    <!-- ③ 选自己是哪一位 -->
    <view v-show="step === 'entry'" class="pick">
      <view
        v-for="e in entries"
        :key="`e-${e.id}`"
        class="pick__row"
        :class="{ 'pick__row--on': chosen && chosen.id === e.id }"
        @tap="pickEntry(e)"
      >
        <text class="pick__t">{{ e.class_name || '未分班' }} · {{ e.position || '老师' }}</text>
        <text class="pick__s">{{ e.surname ? `${e.surname}老师` : '' }}{{ e.note ? ` · ${e.note}` : '' }}</text>
      </view>
      <text v-if="!entries.length" class="meta">
        这个园的名单里没有空位了。跟发码给你的人说一声。
      </text>
    </view>

    <view class="act">
      <s-button
        :label="btnLabel"
        arrow
        :disabled="!canGo"
        :loading="submitting"
        :loading-text="topup ? '正在兑换' : '正在激活'"
        @press="onPrimary"
      />
      <view v-show="step !== 'code'" class="back" @tap="goBack">
        <text class="back__t">上一步</text>
      </view>
    </view>

    <text v-show="step === 'code' && !topup" class="meta meta--foot">
      还没有码？找发问卷给你的那位老师要。
    </text>
  </s-page>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { illoRedeem } from '../../utils/illustrations.js'
import { ensureSession, gate, redeem } from '../../stores/session.js'
import { rosterOptions } from '../../api/auth.js'
import { reLaunch } from '../../utils/nav.js'
import { showApiError, toast } from '../../utils/ui.js'

const illo = illoRedeem()
const code = ref('')
const submitting = ref(false)
/** 已经激活过的老师进来兑新码（任务奖励），或者换绑 —— 这时不用选身份 */
const topup = ref(false)

/** code → kg → entry。三步在一屏里换，不跳页 */
const step = ref('code')
const kindergartens = ref([])
const entries = ref([])
const chosen = ref(null)

const title = computed(() => {
  if (topup.value) return '有新的兑换码？'
  if (step.value === 'kg') return '你在哪个幼儿园？'
  if (step.value === 'entry') return '哪一位是你？'
  return '输入兑换码就能开始'
})

const btnLabel = computed(() => {
  if (topup.value) return '兑换'
  if (step.value === 'code') return '下一步'
  if (step.value === 'kg') return '下一步'
  return '就是我，激活'
})

const canGo = computed(() => {
  if (step.value === 'code') return Boolean(code.value.trim())
  if (step.value === 'kg') return false          // 园所是点着选的，按钮用不上
  return Boolean(chosen.value)
})

onLoad(async (query) => {
  await ensureSession()
  const where = gate()
  // 从「我的」页点「兑换」进来的：她已经激活了，这一趟是续兑或换绑，别把她弹走
  if (query?.topup) {
    topup.value = true
    return
  }
  // 已经激活过的老师不该停在这页（换设备重登、或从别处误跳进来）
  if (where === 'agreement') reLaunch('agreement')
  else if (where === 'main') reLaunch('home')
})

/**
 * 码输完按「下一步」。
 *
 * **续兑和换绑就在这一步提交** —— 它们不用选身份，
 * 而后端认得出这个码是哪一种。首次激活才继续往下走选择器。
 */
async function onCodeNext() {
  const c = code.value.trim()
  if (!c || submitting.value) return
  if (topup.value) return submit()

  submitting.value = true
  try {
    const d = await rosterOptions(c)
    kindergartens.value = d.kindergartens || []
    // 只有一个园就直接跳过这一步 —— 让她在一个只有一个选项的列表里点一下没有意义
    if (kindergartens.value.length === 1) {
      await pickKg(kindergartens.value[0])
    } else {
      step.value = 'kg'
    }
  } catch (err) {
    // 换绑码在这里会被拒（它不在兑换码表里），那就直接按换绑提交试一次。
    // 她手上只有一个码，分不出类型也不该让她分
    try {
      await doRedeem()
    } catch {
      showApiError(err)
    }
  } finally {
    submitting.value = false
  }
}

async function pickKg(k) {
  submitting.value = true
  try {
    const d = await rosterOptions(code.value.trim(), k.id)
    entries.value = d.entries || []
    chosen.value = null
    step.value = 'entry'
  } catch (err) {
    showApiError(err)
  } finally {
    submitting.value = false
  }
}

function pickEntry(e) {
  chosen.value = e
}

function goBack() {
  chosen.value = null
  step.value = step.value === 'entry' ? 'kg' : 'code'
  // 只有一个园时中间那一步是跳过的，回退也要跳过它
  if (step.value === 'kg' && kindergartens.value.length === 1) step.value = 'code'
}

function onPrimary() {
  if (step.value === 'code') return onCodeNext()
  if (step.value === 'entry') return submit()
}

async function submit() {
  if (submitting.value || !canGo.value) return
  submitting.value = true
  try {
    await doRedeem()
  } catch (err) {
    showApiError(err)
  } finally {
    submitting.value = false
  }
}

async function doRedeem() {
  const data = await redeem(code.value.trim(), chosen.value?.id)
  if (data.kind === 'rebind') {
    // 换绑：她的老账号回来了，协议早就同意过，直接进主流程
    toast('你的教案都还在')
    reLaunch('home')
  } else if (data.kind === 'topup') {
    toast(`到账了：教案 +${data.granted?.text ?? 0}、配图 +${data.granted?.image ?? 0}`)
    reLaunch('me')
  } else {
    // 首次激活完必然还没同意协议，直接送过去，不让她再点一次
    reLaunch('agreement')
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

/* ============ 选择器 ============ */
/* 整行可点。选项里带 A/B/C 字母是方向 B 用在「问题」上的形状，
   这里是一份名单，不是一道题 —— 用列表更贴 */
.pick {
  border: 2rpx solid $rule;
  border-radius: $r-input;
  background: $white;
  box-shadow: $shadow-card;
  overflow: hidden;
}

.pick__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 28rpx 32rpx;
  border-bottom: 2rpx solid $rule;

  &:last-child {
    border-bottom: none;
  }

  &--on {
    background: $amber-soft;
  }
}

.pick__t {
  font-size: 32rpx;
  color: $ink;
  font-weight: 600;
}

.pick__s {
  font-size: $fs-sub;
  color: $ink-3;
  margin-left: 20rpx;
}

.act {
  margin-top: 36rpx;
}

.back {
  padding: 24rpx 0 4rpx;
  display: flex;
  justify-content: center;
}

.back__t {
  font-size: 27rpx;
  color: $ink-3;
}
</style>
