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

    <!--
      阶段清单。**这三步现在是真的**（2026-08-25）：后端回的 phase 是
      thinking / writing / checking 三个真实阶段，不再是四句按代码行数推进的文案。
    -->
    <view v-for="(s, i) in steps" :key="s" class="step" :class="stepClass(i)">
      <view class="step__ic" :class="stepClass(i)">
        <image v-if="stepIndex > i || done" class="step__check" :src="checkWhite" mode="widthFix" />
      </view>
      <text class="step__t">{{ s }}</text>
    </view>

    <!--
      正文一个字一个字长出来（2026-08-25 用户定）。
      这一屏原来是三个假勾 + 一句「正在设计教学流程…」，看起来跟没开始一样；
      现在她看见的是**她那份教案本身**在长。

      🔴 用 scroll-view 不用 view：正文有两千多字，普通 view 会把整页撑长，
      而这一页底下还有「可以先去忙」和操作条。固定高度 + 自动滚到底。
      失败之后**不再显示这块** —— 半截教案配一句「没写成」是自相矛盾的。
    -->
    <scroll-view
      v-if="!failed"
      class="live"
      scroll-y
      :scroll-top="scrollTop"
      :scroll-with-animation="true"
    >
      <text class="live__t">{{ shown || '正在想怎么写…' }}</text>
    </scroll-view>

    <view v-if="failed" class="fail" :class="{ 'fail--net': failKind === 'net' }">
      <text class="fail__t" :class="{ 'fail__t--net': failKind === 'net' }">{{ failMessage }}</text>
      <!-- 只说否定的那一面。网通着就不说话 —— 理由同 s-state：别编「网回来了」 -->
      <text v-if="failKind === 'net' && !net.online" class="fail__live">还是没有网络</text>
    </view>

    <!--
      「可以先去忙」那张卡片 **2026-08-25 用户定：删掉**。
      ⚠️ 它背后那条产品要求没变（老师在幼儿园随时被叫走，不能要求她盯着屏幕等），
      只是这一屏现在正一个字一个字地写给她看 —— 在这时候劝她走，
      跟这一屏新的目的正好相反。
      **离开的出口还在**：顶栏那个返回。走了后端照样写完，教案库里找得回。
    -->

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

/* 三步对应后端的三个 phase，**顺序不能动**（见下面 PHASE_STEP）。
   2026-08-25 之前它们由 progress_hint 那四句文案用正则猜出来 ——
   而那四句是按代码走到哪一行发的，跟模型真的写到哪没关系。 */
const STEPS = ['读你答的那几题', '设计活动流程', '按年龄班校一遍']
// 改稿走的是同一条链路，只有第一步读的东西不一样 —— 她提的意见 + 刚答的三题
const REVISE_STEPS = ['读你提的意见', '重排活动流程', '按年龄班校一遍']

const conversationId = ref(0)
const stepIndex = ref(0)

/* 正文分两个变量，是有理由的（2026-08-25）：
     buf    后端已经给到的全文
     shown  已经显示出来的那一截
   轮询是 800 毫秒一次，一次带回来几十个字。直接显示 buf 的话是一坨一坨往外蹦；
   `shown` 由一个 40 毫秒的小定时器把 buf 慢慢放出来，看起来才像在写。
   **放出来的速度跟着积压量走**（见 tick），所以它只会平滑、不会掉队 ——
   写完那一刻积压清空，最后一个字跟着就到。 */
const buf = ref('')
const shown = ref('')
/* scroll-view 要靠 scroll-top 变化才滚。给一个只增不减的数，
   它自己会夹到底部 —— 比维护一个 sentinel 元素 id 省事，也不会因为
   同一个 id 不触发而卡在半空 */
const scrollTop = computed(() => shown.value.length * 40)
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
let reveal = null

const stepClass = (i) => ({
  'is-done': done.value || stepIndex.value > i,
  'is-now': !done.value && stepIndex.value === i,
})

onLoad((query) => {
  conversationId.value = Number(query?.id || 0)
  isRevise.value = String(query?.revise || '') === '1'
  start()
})

// 必须停。老师退出去了还在打请求是不对的 —— 后端会自己写完，她回教案库照样看得到。
// 那个 40 毫秒的定时器也要停：页面没了它还在跑就是一个泄漏
onUnload(() => stop())

function stop() {
  if (handle) {
    handle.stop()
    handle = null
  }
  if (reveal) {
    clearInterval(reveal)
    reveal = null
  }
}

/**
 * 把 buf 里积压的字慢慢放到 shown 上。
 *
 * 每次放的量 = 积压的十二分之一（至少 2 个字）。这个写法有两个好处：
 *   · 积压多就放得快，**永远不会越落越远** —— 定速放字的话，
 *     模型写得比放得快时，她会在教案早就写完之后还盯着字往外爬
 *   · 积压少就一个一个放，看起来才是「正在写」而不是「贴上去的」
 */
function startReveal() {
  if (reveal) return
  reveal = setInterval(() => {
    const gap = buf.value.length - shown.value.length
    if (gap <= 0) return
    shown.value = buf.value.slice(0, shown.value.length + Math.max(2, Math.ceil(gap / 12)))
  }, 40)
}

/** 后端三个真实阶段 → 清单上的第几步。**一一对应，不用正则猜** */
const PHASE_STEP = { thinking: 0, writing: 1, checking: 2 }

function start() {
  stop()
  failed.value = false
  done.value = false
  startReveal()
  handle = pollGenerate(conversationId.value, {
    onTick: (d) => {
      if (d.phase in PHASE_STEP) stepIndex.value = PHASE_STEP[d.phase]
      const s = d.stream
      if (!s) return
      // restart = 后端重打了一次（被截断、或思考吃穿了预算），刚才那些不算了。
      // 显示的那一截也要一起清 —— 只清 buf 的话 shown 比 buf 长，reveal 再也不动
      if (s.restart) {
        buf.value = s.text
        shown.value = ''
      } else {
        buf.value += s.text
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
      // 最后那几个字直接补齐，不等慢放 —— 450 毫秒之后这一屏就跳走了，
      // 让她带着一句写到一半的话离开是奇怪的
      shown.value = buf.value
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
    // 重新生成 = 一份全新的教案。旧那半截必须清掉，否则新的接在它后面
    buf.value = ''
    shown.value = ''
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

/* 正在写出来的正文。**高度写死** —— 里面有两千多字，
   不定高的话这一屏会被撑成一条长得没边的页面，底下的操作条被推走。
   底色用最浅的纸色而不是白：白色块在奶油底上像一张贴上去的纸，
   而这段字是「正在长出来的东西」，不是一份已经做好的文件 */
.live {
  height: 520rpx;
  background: $paper-2;
  border-radius: 20rpx;
  padding: 20rpx 24rpx;
  margin-top: 24rpx;
  box-sizing: border-box;
}

.live__t {
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.75;
  white-space: pre-wrap;
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

/* 「可以先去忙」那张卡片的样式（.leave / .leave__t / .leave__h / .leave__s）
   跟卡片本身一起删掉了（2026-08-25）。留着就是没人用的死样式。
   ⚠️ `leave()` 那个函数**不是死的** —— dock 里「去教案库找」还在用它 */
</style>
