<template>
  <s-page tab="home">
    <!-- 启动没走完时先给骨架，不给空白也不给转圈 —— 布局稳定不跳动 -->
    <template v-if="!session.ready">
      <view class="sk sk--hero" />
      <view class="sk sk--line" />
      <view class="sk sk--line sk--short" />
    </template>

    <template v-else-if="session.bootError">
      <text class="err">{{ session.bootError.message }}</text>
      <s-button label="重试" variant="plain" @press="retry" />
    </template>

    <template v-else>
      <image class="hero" :src="hero" mode="widthFix" />

      <text class="kicker">开始新教案</text>
      <text class="q">{{ greeting }}<text class="q__br">今天想做个什么活动？</text></text>

      <view class="ask">
        <textarea
          v-model="seed"
          class="ask__ta"
          placeholder="例：我想做个浮与沉的活动"
          placeholder-class="ask__ph"
          :maxlength="200"
          :auto-height="true"
          :disable-default-padding="true"
          :adjust-position="true"
        />
        <view class="ask__seeds">
          <text class="ask__seeds-lb">试试</text>
          <view v-for="s in SEEDS" :key="s" class="chip" @tap="pickSeed(s)">
            <text class="chip__t">{{ s }}</text>
          </view>
        </view>
      </view>

      <view class="act">
        <s-button
          label="开始"
          arrow
          :disabled="!seed.trim()"
          :loading="starting"
          loading-text="正在准备问题"
          @press="start"
        />
      </view>

      <text class="foot">我就问你 4 个问题，都给好了备选答案，点一下就行。</text>
    </template>
  </s-page>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { ensureSession, gate, session } from '../../stores/session.js'
import { put } from '../../stores/handoff.js'
import { createConversation } from '../../api/conversations.js'
import { illoHero } from '../../utils/illustrations.js'
import { reLaunch, redirectTo } from '../../utils/nav.js'
import { showApiError } from '../../utils/ui.js'

// 前三个是已经真跑过的主题（小班/中班/大班各一），第四个说明其余主题一样能走
const SEEDS = ['浮与沉', '影子', '搭高塔', '磁铁']

const hero = illoHero()
const seed = ref('')
const starting = ref(false)

// 这里的 nickname 是微信昵称，不是问卷里那个真实姓名 ——
// 真实姓名和手机号永不下发前端，接口里根本没有那两个字段
const greeting = computed(() => (session.teacher?.nickname ? `${session.teacher.nickname}，` : ''))

onLoad(() => routeByGate())
// 从待激活/协议页 reLaunch 回来时 onLoad 不再触发，onShow 兜一次
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

function pickSeed(s) {
  seed.value = `我想做个${s}的活动`
}

async function start() {
  if (starting.value || !seed.value.trim()) return
  starting.value = true
  try {
    const data = await createConversation(seed.value.trim())
    // 开会话的响应里**已经带着那 4 道题**了。直接递给引导页，
    // 省掉它再 GET 一次 —— 否则老师等完「正在准备问题」，进去还要再看一次骨架屏。
    // 响应里没有 seed_input（后端那边它是入参不是出参），把她刚打的那句一起递过去，
    // 否则引导页顶上的标题会退化成「说说你的想法」
    put(`conversation:${data.conversation_id}`, { ...data, seed_input: seed.value.trim() })
    // 用 redirectTo 而不是 navigateTo：首页留在栈里没意义，
    // 引导页的返回按钮本来就是回首页（s-topbar 的 back 兜底会 reLaunch 回来）
    redirectTo('guide', { id: data.conversation_id })
    // 这里**不要**在 finally 里解锁。跳转是异步的：解锁之后、页面还没换掉的那一瞬，
    // 按钮会变回「开始」，老师以为没反应就再点一下 —— 那会再开一个新会话。
    // 让它保持 loading 直到这一页被替换掉（引导页那边同一个理由，写在 generate() 里）
  } catch (err) {
    // 额度闸门装在这里 —— 在最前面。让老师答完 4 题、等 20 秒生成，
    // 最后才说额度不够，是最糟的时机
    starting.value = false
    showApiError(err)
  }
}
</script>

<style lang="scss" scoped>
.hero {
  width: 100%;
  border-radius: $r-card;
  margin-top: 40rpx;
}

.kicker {
  display: block;
  font-size: $fs-tag;
  color: $ink-3;
  font-weight: 600;
  letter-spacing: 0.02em;
  margin-top: 32rpx;
}

.q {
  display: block;
  font-size: 46rpx;
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
  line-height: 1.45;
  margin: 14rpx 0 34rpx;
}

.q__br {
  display: block;
}

.ask {
  border: 2rpx solid $rule-2;
  border-radius: $r-input;
  background: $white;
  padding: 30rpx 32rpx 24rpx;
  box-shadow: $shadow-card;
}

.ask__ta {
  width: 100%;
  font-size: 30rpx;
  line-height: 1.55;
  color: $ink;
  min-height: 92rpx;
}

.ask__ph {
  color: $ink-3;
}

.ask__seeds {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 22rpx;
  padding-top: 20rpx;
  border-top: 2rpx dashed $rule;
}

.ask__seeds-lb {
  font-size: $fs-tag;
  color: $ink-3;
  margin-right: 10rpx;
}

.chip {
  border: 2rpx solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 6rpx 22rpx;
  margin: 6rpx 12rpx 6rpx 0;
}

.chip__t {
  font-size: 25rpx;
  color: $ink-2;
  line-height: 1.5;
}

.act {
  margin-top: 32rpx;
}

.foot {
  display: block;
  font-size: $fs-sub;
  color: $ink-3;
  line-height: 1.6;
  text-align: center;
  margin-top: 22rpx;
}

.err {
  display: block;
  font-size: $fs-body;
  color: $ink-2;
  line-height: 1.7;
  margin: 80rpx 0 32rpx;
}

/* 骨架屏 */
.sk {
  background: $paper-2;
  border-radius: $r-sm;
  margin-bottom: 20rpx;

  &--hero {
    height: 252rpx;
    border-radius: $r-card;
    margin-top: 40rpx;
  }

  &--line {
    height: 40rpx;
  }

  &--short {
    width: 55%;
  }
}
</style>
