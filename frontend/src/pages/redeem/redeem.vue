<template>
  <s-page>
    <image class="illo" :src="illo" mode="widthFix" />

    <!--
      同一个页面管三件事，因为对老师来说它们是同一个动作：输一个码。
        · 首次激活：码 + 手机号（后端拿手机号跟名单核对）
        · 续兑：完成任务拿到新码，只要码
        · 换绑：换了微信，输我给她的换绑码
      她分不出也不需要分 —— 后端认得出来。
    -->
    <text class="q">{{ topup ? '有新的兑换码？' : '输入兑换码就能开始' }}</text>
    <text v-if="!topup" class="meta meta--lead">
      这个小程序目前只开放给合作园的老师。填过问卷之后，你会收到一个兑换码。
    </text>

    <view class="ask">
      <input
        v-model="code"
        class="ask__input"
        placeholder="STEM-XXXX-XXXX"
        placeholder-class="ask__ph"
        :disabled="submitting"
        confirm-type="next"
        @confirm="focusPhone"
      />
      <!--
        手机号只在首次激活时要。用 v-show 不用 v-if：
        一对 v-if/v-else 会让两个 handler 落在同一个模板位置、拿到同一个缓存 key，
        微信端把点击派发错人（踩过三次，test:mp 第 2 条查这个）。
      -->
      <view v-show="!topup" class="ask__row">
        <input
          v-model="phone"
          class="ask__input ask__input--phone"
          type="number"
          placeholder="填问卷时留的手机号"
          placeholder-class="ask__ph"
          :disabled="submitting"
          confirm-type="done"
          @confirm="submit"
        />
      </view>
      <text class="meta">{{ topup ? '照着发你的那串敲就行。' : '大小写、空格都不影响。手机号要跟填问卷时留的那个一样。' }}</text>
    </view>

    <view class="act">
      <s-button
        :label="topup ? '兑换' : '激活'"
        arrow
        :disabled="!canSubmit"
        :loading="submitting"
        :loading-text="topup ? '正在兑换' : '正在激活'"
        @press="submit"
      />
    </view>

    <text v-if="!topup" class="meta meta--foot">还没有码？找发问卷给你的那位老师要。</text>
  </s-page>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { illoRedeem } from '../../utils/illustrations.js'
import { ensureSession, gate, redeem } from '../../stores/session.js'
import { reLaunch } from '../../utils/nav.js'
import { showApiError, toast } from '../../utils/ui.js'

const illo = illoRedeem()
const code = ref('')
const phone = ref('')
const submitting = ref(false)
/** 已经激活过的老师进来兑新码（任务奖励），或者换绑 —— 这时不问手机号 */
const topup = ref(false)

/**
 * 只要有码就能点。
 *
 * **手机号不设成必填**，虽然首次激活确实要它 —— 因为换绑发生在一个**全新的微信**上，
 * 那时她落在这一屏（还没激活），手上却是一个换绑码，**没有手机号要填**。
 * 把手机号设成必填，按钮永远是灰的，换绑这条路在界面上就被堵死了（第一版就是这么错的）。
 *
 * 代价是：她只填了码就点激活，会收到后端那句「还要填一下你的手机号」。
 * 多一次往返换来换绑可用 —— 而且那句话本身就是清楚的指引。
 */
const canSubmit = computed(() => Boolean(code.value.trim()))

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

function focusPhone() {
  // 码输完按「下一步」时不做别的，让她自己点手机号那一栏 ——
  // 小程序里用 :focus 抢焦点常常连带把键盘收起来又弹一次，比不抢更烦
}

async function submit() {
  if (submitting.value || !canSubmit.value) return
  submitting.value = true
  try {
    const data = await redeem(code.value, topup.value ? undefined : phone.value)
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

/* 手机号那一栏跟码之间要有一条线，否则两个输入框叠在一起看不出是两样东西 */
.ask__row {
  border-top: 2rpx solid $rule;
  padding-top: 18rpx;
}

.ask__input--phone {
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
