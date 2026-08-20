<template>
  <!--
    center：内容纵向居中。顶上那幅风景插画撤掉之后（2026-08-20 用户定），
    这一屏只剩「一句问题 + 一个输入框 + 一个按钮」，靠上排会在下面留一大片空白，
    看着像没加载完。居中之后输入框正好落在拇指位。
  -->
  <s-page tab="home" center>
    <!-- 启动没走完时先给骨架，不给空白也不给转圈 —— 布局稳定不跳动 -->
    <template v-if="!session.ready">
      <s-skel kind="card" />
      <s-skel kind="line" />
      <s-skel kind="line" w="55%" />
    </template>

    <!--
      启动失败。这一屏是**最该分清「没网」和「后端挂了」的地方**：
      她连不上时看到的第一屏就是这里，而这两件事她能做的完全不同 ——
      一件走两步就好，一件只能等我。网回来时 s-state 自己会重来一次。
    -->
    <s-state
      v-else-if="session.bootError"
      :kind="stateKind(session.bootError)"
      :text="session.bootError.message"
      action-label="重试"
      @action="retry"
    />

    <template v-else>
      <!--
        有未读任务时的条带。**没有就不占地方** —— 首页只是一个对话框
        （CLAUDE.md 的信息架构），不该常驻一条横幅。
        用 v-show 而不是 v-if：一对 v-if/v-else 会让两个 handler 落在同一个
        模板位置、拿到同一个缓存 key，微信端把点击派发错人（test:mp 第 2 条）。
      -->
      <view v-show="unreadTasks > 0" class="banner" @tap="goTasks">
        <text class="banner__t">有 {{ unreadTasks }} 件可以换额度的事</text>
        <text class="banner__b">去看看 ›</text>
      </view>

      <text class="kicker">开始新教案</text>
      <text class="q">{{ greeting }}<text class="q__br">今天想做个什么活动？</text></text>

      <!--
        模式切换。摆在输入框正上方 —— 她要在打字之前就看到自己是哪个模式，
        打完 200 字才发现选错了会很恼火。
        胶囊上**只有模式名，没有副标题**：解释放在点开的抽屉里
        （见 stores/prefs.js 里 MODES 那段注释说的例外）。
      -->
      <view class="mode" @tap="openModeSheet">
        <text class="mode__t">{{ modeName }}</text>
        <text class="mode__c">⌄</text>
      </view>

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

      <text class="foot">{{ footText }}</text>
    </template>

    <!--
      模式选择抽屉。整行可点 = 整行是那个选择，跟「我的」里记忆那一行同一个形状。
      选完立刻关掉，不用再点一次「确定」—— 点了哪一行就是选了哪一行。
    -->
    <s-sheet :visible="modeSheet" title="怎么写这一份" @close="modeSheet = false">
      <view
        v-for="m in MODES"
        :key="m.key"
        class="mrow"
        :class="{ 'mrow--on': prefs.mode === m.key }"
        @tap="pickMode(m.key)"
      >
        <view class="mrow__b">
          <text class="mrow__t">{{ m.label }}</text>
          <text class="mrow__d">{{ m.desc }}</text>
        </view>
        <image v-if="prefs.mode === m.key" class="mrow__ck" :src="checkInk" mode="widthFix" />
      </view>
    </s-sheet>
  </s-page>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'
import { ensureSession, gate, session } from '../../stores/session.js'
import { put } from '../../stores/handoff.js'
import { createConversation } from '../../api/conversations.js'
import { listTasks } from '../../api/tasks.js'
import { MODES, modeLabel, prefs, setMode } from '../../stores/prefs.js'
import { iconCheck } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { navTo, reLaunch, redirectTo } from '../../utils/nav.js'
import { showApiError, stateKind } from '../../utils/ui.js'

const checkInk = iconCheck(COLORS.ink, 2.6)

// 前三个是已经真跑过的主题（小班/中班/大班各一），第四个说明其余主题一样能走
const SEEDS = ['浮与沉', '影子', '搭高塔', '磁铁']

const seed = ref('')
const starting = ref(false)
/** 未读任务数。为 0 时那条条带整个不出现 */
const unreadTasks = ref(0)

const modeSheet = ref(false)
const modeName = computed(() => modeLabel())

/**
 * 底下那句话跟着模式变。
 *
 * 效率模式说的是「快」（4 题、点一下就行）；学习模式说的是「为什么」。
 * 同一句话两个模式都用，等于其中一个模式的老师读到的是别人的承诺。
 */
const footText = computed(() =>
  prefs.mode === 'learning'
    ? '每个问题都会告诉你为什么问，这 4 件事也是你自己写教案时要先想的。'
    : '我就问你 4 个问题，都给好了备选答案，点一下就行。'
)

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
  if (where === 'redeem') return reLaunch('redeem')
  if (where === 'agreement') return reLaunch('agreement')
  // 进得了主流程才查任务。没激活的老师看任务没有意义，
  // 而且那个接口挂在 requireActivated 后面，查了只会拿到 403
  refreshTasks()
}

/**
 * 拉未读数。**故意不 await、失败也不弹错** ——
 * 首页的正事是那个输入框，任务只是一条锦上添花的提醒。
 * 为了一条提醒让首页停在加载态或者弹个错框，是把主次弄反了。
 */
function refreshTasks() {
  listTasks()
    .then((d) => { unreadTasks.value = d.unread || 0 })
    .catch(() => { unreadTasks.value = 0 })
}

function goTasks() {
  navTo('tasks')
}

function retry() {
  session.ready = false
  routeByGate()
}

function pickSeed(s) {
  seed.value = `我想做个${s}的活动`
}

// 都用具名函数，名字互相差得远一点 —— uni 的 handler 缓存 key 只有 256 个桶，
// 撞了微信会把点击派发错人（test:mp 第 2 条）
function openModeSheet() {
  modeSheet.value = true
}

function pickMode(key) {
  setMode(key)
  modeSheet.value = false
}

async function start() {
  if (starting.value || !seed.value.trim()) return
  starting.value = true
  try {
    const data = await createConversation(seed.value.trim(), prefs.mode)
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
/* 未读任务条带。用薄荷绿而不是暖阳黄：暖阳黄是主行动（「开始」那个按钮）的颜色，
   一条提醒不该跟这一屏真正的主行动抢同一个色（design-tokens.md 第 2 节） */
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: $mint-soft;
  border: 2rpx solid $mint-line;
  border-radius: 24rpx;
  padding: 22rpx 26rpx;
  /* 居中之后第一个孩子的 margin-top 会把整列往下推，所以间距一律写在下边 */
  margin-bottom: 40rpx;
}

.banner__t {
  font-size: var(--fs-read);
  color: $mint-deep;
  font-weight: 600;
}

.banner__b {
  font-size: var(--fs-tag);
  color: $mint-deep;
  margin-left: 20rpx;
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
  font-size: var(--fs-hero);
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
  line-height: 1.45;
  margin: 14rpx 0 34rpx;
}

.q__br {
  display: block;
}

/* ============ 模式切换 ============ */
/* 用次级底 + 描边，不用暖阳黄 —— 暖阳黄是「开始」那个主行动的颜色，
   一个切换器不该跟这一屏真正的主行动抢同一个色（design-tokens 规则 4） */
.mode {
  align-self: flex-start;
  display: flex;
  align-items: center;
  border: 2rpx solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 8rpx 22rpx;
  margin-bottom: 16rpx;
}

.mode__t {
  font-size: var(--fs-sub);
  color: $ink-2;
  font-weight: 600;
}

.mode__c {
  font-size: var(--fs-tag);
  color: $ink-3;
  margin-left: 10rpx;
  line-height: 1;
}

/* 抽屉里的两行 */
.mrow {
  display: flex;
  align-items: center;
  border: 2rpx solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 24rpx 26rpx;
  margin-bottom: 16rpx;

  &--on {
    background: $amber-soft;
    border-color: $amber-line;
    box-shadow: 0 0 0 2rpx $amber-line;
  }
}

.mrow__b {
  flex: 1;
  min-width: 0;
}

.mrow__t {
  display: block;
  font-size: var(--fs-body);
  font-weight: 600;
  color: $ink;
  line-height: 1.5;
}

.mrow__d {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  line-height: 1.6;
  margin-top: 4rpx;
}

.mrow__ck {
  flex: none;
  width: 32rpx;
  height: 32rpx;
  margin-left: 16rpx;
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
  font-size: var(--fs-body);
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
  font-size: var(--fs-tag);
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
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.5;
}

.act {
  margin-top: 32rpx;
}

.foot {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  line-height: 1.6;
  text-align: center;
  margin-top: 22rpx;
}

</style>
