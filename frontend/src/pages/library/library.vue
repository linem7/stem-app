<template>
  <s-page tab="library">
    <view class="hd">
      <text class="q">教案库</text>
      <text v-if="counts.all" class="hd__n">{{ counts.all }} 份</text>
    </view>

    <!-- 两排筛选。状态那排带数字 —— 老师最常问的是「我还有几份没写完」 -->
    <view class="fils">
      <view
        v-for="s in STATES"
        :key="`st-${s.key}`"
        class="fil"
        :class="{ 'fil--on': status === s.key }"
        @tap="setStatus(s.key)"
      >
        <!-- 打勾不是装饰：黄底压次级底只有 1.51:1，光靠颜色分不出哪个被选中 -->
        <image v-if="status === s.key" class="fil__ck" :src="checkInk" mode="widthFix" />
        <text class="fil__t" :class="{ 'fil__t--on': status === s.key }">
          {{ s.label }}{{ counts[s.key] ? ` ${counts[s.key]}` : '' }}
        </text>
      </view>
    </view>
    <view class="fils fils--age">
      <view
        v-for="a in AGES"
        :key="`ag-${a.key}`"
        class="fil"
        :class="{ 'fil--on': ageGroup === a.key }"
        @tap="setAge(a.key)"
      >
        <image v-if="ageGroup === a.key" class="fil__ck" :src="checkInk" mode="widthFix" />
        <text class="fil__t" :class="{ 'fil__t--on': ageGroup === a.key }">{{ a.label }}</text>
      </view>
    </view>

    <!-- 加载中 -->
    <template v-if="loading && !items.length">
      <s-skel v-for="n in 3" :key="`sk-${n}`" kind="card" />
    </template>

    <s-state
      v-else-if="loadError"
      :kind="stateKind(loadError)"
      :text="loadError.message"
      action-label="重试"
      @action="reload"
    />

    <!-- 一份都没有。空手而归时不要只给一句「暂无数据」，给一条出路 -->
    <s-state
      v-else-if="!items.length"
      kind="empty"
      :text="emptyText"
      :action-label="isFiltered ? '看全部' : '写一份新的'"
      @action="onEmptyAction"
    />

    <template v-else>
      <!--
        左滑露出红色删除键（2026-08-23 用户定），**点红键再确认一次**才真删
        （2026-08-25 用户定，见 onDelTap）。
        入口从长按换成左滑的理由还在：滑动是个明确的意图动作，误触概率比长按低。
        小程序没有现成的左滑组件，手势自己算（见 onSwipeStart/Move/End）。
      -->
      <view v-for="it in items" :key="it.id" class="swipe">
        <!-- 删除键垫在底下，卡片滑开才露出来。放在前面是为了让卡片盖住它 -->
        <view class="swipe__del" @tap.stop="onDelTap(it)">
          <text class="swipe__del-t">删除</text>
        </view>
        <view
          class="card"
          :class="{ 'card--draft': isDraft(it) }"
          :style="{ transform: `translateX(${it.id === openId ? -DEL_W : 0}px)` }"
          @touchstart="onSwipeStart"
          @touchmove="onSwipeMove($event, it)"
          @touchend="onSwipeEnd(it)"
          @tap="open(it)"
        >
          <view class="card__b">
            <view v-if="isDraft(it)" class="badge badge--draft"><text class="badge__t">草稿</text></view>
            <view v-else class="badge badge--done">
              <view class="badge__dot" />
              <text class="badge__t badge__t--done">已完成</text>
            </view>
            <text v-if="it.age_group" class="card__age">{{ it.age_group }}</text>
            <text v-if="it.has_image" class="card__img">有配图</text>
            <text class="card__date">{{ fmtDate(it.updated_at) }}</text>
          </view>
          <text class="card__t">{{ it.title || '未命名教案' }}</text>
          <text v-if="isDraft(it) && it.progress_text" class="card__p">{{ it.progress_text }}</text>
          <view class="card__go">
            <text class="card__go-t" :class="{ 'card__go-t--done': !isDraft(it) }">
              {{ isDraft(it) ? '接着写' : '打开看看' }}
            </text>
            <image class="card__go-i" :src="chevron" mode="widthFix" />
          </view>
        </view>
      </view>

      <!-- 手动翻页而不是滚到底自动加载：自动加载在弱网下会连着打好几次请求，
           而她真正想要的多半是上面那几份 -->
      <view v-if="cursor" class="more" @tap="loadMore">
        <text class="more__t">{{ loadingMore ? '正在拿…' : '再看 20 份' }}</text>
      </view>
    </template>

    <!--
      第一次进这一页时教一次左滑（2026-08-23 用户定）。
      🔴 **只教手势，不介绍这一页能干什么**：其余东西（草稿标记、筛选、接着写）
      在界面上看得见，而左滑是**隐蔽手势** —— 不说她永远找不到。
      看过一次就不再出现（存 storage），不占她第二次的时间。
    -->
    <view v-if="showSwipeHint" class="hint" @tap="dismissHint">
      <view class="hint__box">
        <view class="hint__demo">
          <view class="hint__card" />
          <view class="hint__del"><text class="hint__del-t">删除</text></view>
        </view>
        <text class="hint__t">向左滑动卡片可以删除教案</text>
        <view class="hint__ok"><text class="hint__ok-t">知道了</text></view>
      </view>
    </view>
  </s-page>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { listConversations, removeConversation } from '../../api/conversations.js'
import { iconCheck, iconChevron } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { navTo, reLaunch } from '../../utils/nav.js'
import { showApiError, stateKind, toast } from '../../utils/ui.js'

const chevron = iconChevron(COLORS.ink3)
const checkInk = iconCheck(COLORS.ink, 2.6)

const STATES = [
  { key: 'all', label: '全部' },
  { key: 'draft', label: '草稿' },
  { key: 'completed', label: '已完成' },
]
const AGES = [
  { key: 'all', label: '不限' },
  { key: '小班', label: '小班' },
  { key: '中班', label: '中班' },
  { key: '大班', label: '大班' },
]

const items = ref([])
const counts = reactive({ all: 0, draft: 0, completed: 0 })
const cursor = ref(null)
const status = ref('all')
const ageGroup = ref('all')
const loading = ref(true)
const loadingMore = ref(false)
/** 存 ApiError 本身，不再只存 message —— s-state 要靠 code 分辨「没网」和「后端出错」 */
const loadError = ref(null)

const isFiltered = computed(() => status.value !== 'all' || ageGroup.value !== 'all')

const emptyText = computed(() => {
  if (isFiltered.value) return '这个筛选下没有教案'
  return '还没有教案。回首页说一句想做什么活动就能开始'
})

/** 草稿包括生成中和生成失败的 —— 在老师眼里都是「还没拿到成稿的」 */
const isDraft = (it) => it.status !== 'completed'

// 每次回到这一屏都重拉：她刚写完一份回来，列表里必须有
onShow(() => reload())

async function reload() {
  loading.value = true
  loadError.value = null
  cursor.value = null
  try {
    const data = await listConversations({ status: status.value, ageGroup: ageGroup.value })
    items.value = data.items || []
    Object.assign(counts, data.counts || {})
    cursor.value = data.next_cursor || null
    // 拿到教案之后才可能弹引导 —— 一份都没有的时候教她左滑删除是没有意义的
    maybeShowHint()
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loadingMore.value || !cursor.value) return
  loadingMore.value = true
  try {
    const data = await listConversations({
      status: status.value,
      ageGroup: ageGroup.value,
      cursor: cursor.value,
    })
    items.value = [...items.value, ...(data.items || [])]
    cursor.value = data.next_cursor || null
  } catch (err) {
    showApiError(err)
  } finally {
    loadingMore.value = false
  }
}

function setStatus(k) {
  if (status.value === k) return
  status.value = k
  reload()
}

function setAge(k) {
  if (ageGroup.value === k) return
  ageGroup.value = k
  reload()
}

/**
 * 空态那个按钮做什么，取决于空是怎么来的：
 * 筛出来的空 → 把筛选清掉（她的教案还在，只是这个组合下没有）；
 * 真的一份都没有 → 回首页开始写。
 *
 * 合成一个 handler 而不是两个按钮：s-state 只有一个主行动位，
 * 而这两件事永远不会同时是对的。
 */
function onEmptyAction() {
  if (isFiltered.value) {
    status.value = 'all'
    ageGroup.value = 'all'
    reload()
    return
  }
  reLaunch('home')
}

/**
 * 打开哪一屏，看它写到哪儿了。
 * 草稿回引导页接着答；写完的进成稿页 —— 列表里已经带着 lesson_plan_id，不用再问一次后端。
 */
function open(it) {
  // 刚刚是在滑动（或者有卡片正滑开着）→ 这一下不算「打开」。
  // 不拦的话左滑松手会顺带把教案打开，而她的意图是想删它
  if (swipeMoved) { swipeMoved = false; return }
  if (openId.value) { openId.value = null; return }
  if (isDraft(it)) {
    navTo('guide', { id: it.id })
  } else if (it.lesson_plan_id) {
    navTo('plan', { id: it.lesson_plan_id, conversation_id: it.id })
  } else {
    // 状态是 completed 却没有教案 id，只可能是数据不一致。
    // 与其跳过去给她一个空白页，不如说清楚
    toast('这份教案还没生成好，过一会儿再看')
  }
}

/* ── 左滑露出删除键（2026-08-23 用户定，小程序没有现成组件，手势自己算）──
   只允许**一张**卡片处于滑开状态：两张同时开着，那个红键点下去删的是哪一份
   要靠她自己记，而这是不可逆动作。 */
const DEL_W = 84            // 删除键宽度（px），跟 .swipe__del 的 168rpx 对应
const openId = ref(null)    // 当前滑开的那张卡片 id
let startX = 0
let startY = 0
let swipeMoved = false      // 这一次触摸算不算滑动（用来压掉尾随的 tap）
let horizontal = null       // 本次手势是横向还是纵向，判定一次就锁定

function onSwipeStart(e) {
  const t = e.touches?.[0] || e.changedTouches?.[0]
  startX = t?.clientX ?? 0
  startY = t?.clientY ?? 0
  swipeMoved = false
  horizontal = null
}

function onSwipeMove(e, it) {
  const t = e.touches?.[0]
  if (!t) return
  const dx = t.clientX - startX
  const dy = t.clientY - startY
  /* 先判方向再决定要不要接管这一次手势。
     不判的话竖着滚列表会被误认成左滑，整页滚动变得很黏 ——
     纵向位移更大就直接放手，让页面自己滚。 */
  if (horizontal === null) {
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
    horizontal = Math.abs(dx) > Math.abs(dy)
  }
  if (!horizontal) return
  swipeMoved = true
  // 只认左滑；右滑用来关掉已经开着的那张
  if (dx < -DEL_W / 2) openId.value = it.id
  else if (dx > DEL_W / 2) openId.value = null
}

function onSwipeEnd() {
  horizontal = null
}

/**
 * 点红色删除键 —— **再确认一次才真删**（2026-08-25 用户定，推翻了 08-24 的「点了就删」）。
 *
 * 删教案是不可逆的：那是她花时间写出来的东西，而左滑本身只是把红键露出来，
 * 露出来之后手指顺势往那块红色上一点是很容易发生的。
 * 所以「不可逆」三个字必须出现在她按下去之前 —— 这是 CLAUDE.md 里
 * 「界面上留得住的小字」的第二种：不可逆动作的后果。
 *
 * ⚠️ 确认框弹出来之前先把行收回去（openId = null）。留着红键的话，
 * 她取消之后那一行还是滑开的状态，看起来像「取消了但还是要删」。
 */
function onDelTap(it) {
  openId.value = null
  uni.showModal({
    title: '',
    content: `删掉「${it.title || '未命名教案'}」？删了就找不回来了。`,
    confirmText: '删掉',
    confirmColor: COLORS.coralDeep,
    cancelText: '取消',
    success: (r) => {
      if (r.confirm) doDelete(it)
    },
  })
}

/* 首次引导：她有教案、且没看过 → 弹一次，教左滑。看过就记住 */
const HINT_KEY = 'lib_swipe_hint_seen'
const showSwipeHint = ref(false)

function maybeShowHint() {
  if (showSwipeHint.value || !items.value.length) return
  try {
    if (uni.getStorageSync(HINT_KEY)) return
  } catch { /* storage 读不出来就当没看过，多弹一次不是问题 */ }
  showSwipeHint.value = true
}

function dismissHint() {
  showSwipeHint.value = false
  try { uni.setStorageSync(HINT_KEY, 1) } catch { /* 存不上就下次再弹一次，不影响用 */ }
}

async function doDelete(it) {
  // 先从列表里拿掉，不等后端 —— 她要的是「它消失」这个反馈。
  // 失败了再放回去，比转着圈等两秒好
  const before = items.value
  items.value = items.value.filter((x) => x.id !== it.id)
  try {
    await removeConversation(it.id)
    counts.all = Math.max(0, counts.all - 1)
    const k = isDraft(it) ? 'draft' : 'completed'
    counts[k] = Math.max(0, counts[k] - 1)
    toast('删了')
  } catch (err) {
    items.value = before
    showApiError(err)
  }
}

/**
 * 「今天 14:05」「昨天 09:30」「3 天前 16:20」「8 月 12 日 10:15」。
 *
 * **日期后面一律带时刻**（用户 2026-08-21 要的）。原来只有日期，
 * 而她一天里常常连着写两三份 —— 三张卡片全写「今天」，
 * 就分不出哪张是刚才那份、哪张是早上被打断的那份，
 * 而这一列排序用的正是 updated_at。日期挡住了排序依据，卡片顺序看起来就是乱的。
 *
 * 时刻用 24 小时制、补零：`9:5` 这种参差的宽度在一列卡片里很显眼，
 * 而这一列的作用就是让她扫。
 */
function fmtDate(iso) {
  if (!iso) return ''
  const then = new Date(iso)
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const hm = `${p(then.getHours())}:${p(then.getMinutes())}`

  const days = Math.floor((now - then) / 86400000)
  if (days <= 0 && now.getDate() === then.getDate()) return `今天 ${hm}`
  if (days <= 1) return `昨天 ${hm}`
  if (days < 7) return `${days} 天前 ${hm}`
  return `${then.getMonth() + 1} 月 ${then.getDate()} 日 ${hm}`
}
</script>

<style lang="scss" scoped>
.hd {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 40rpx 0 24rpx;
}

.q {
  font-size: var(--fs-title);
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
}

.hd__n {
  font-size: var(--fs-tag);
  color: $ink-3;
}

/* ============ 筛选 ============ */
.fils {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 12rpx;

  &--age {
    margin-bottom: 28rpx;
  }
}

.fil {
  display: flex;
  align-items: center;
  border: 2rpx solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 8rpx 24rpx;
  margin: 0 12rpx 12rpx 0;

  /* 选中同时有底色、边框和字重，不只靠颜色 */
  &--on {
    background: $amber;
    border-color: $amber-line;
  }
}

.fil__ck {
  width: 22rpx;
  height: 22rpx;
  margin-right: 8rpx;
}

.fil__t {
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.5;

  &--on {
    color: $ink;
    font-weight: 600;
  }
}

/* ============ 左滑删除（2026-08-23）============ */
/* 删除键垫在卡片底下，卡片靠 transform 滑开露出它。
   .swipe 要 overflow:hidden —— 不然没滑开的时候红键从右边探出来一截 */
.swipe {
  position: relative;
  overflow: hidden;
  margin-bottom: 20rpx;
  border-radius: 28rpx;
}

.swipe__del {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 168rpx;   /* 跟 JS 里的 DEL_W = 84px 对应，改一个要改两个 */
  background: $coral-deep;
  display: flex;
  align-items: center;
  justify-content: center;
}

.swipe__del-t {
  color: $white;
  font-size: var(--fs-body);
  font-weight: 600;
}

/* ============ 卡片 ============ */
.card {
  position: relative;   /* 盖住底下的删除键 */
  background: $white;
  border: 2rpx solid $rule-2;
  border-radius: 28rpx;
  padding: 24rpx 26rpx;
  box-shadow: $shadow-card;
  transition: transform .18s ease;

  /* 草稿降一档存在感：视线该落在能用的那几份上 */
  &--draft {
    background: $paper-2;
    box-shadow: none;
  }
}

.card__b {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10rpx;
  /*
    换行时两行之间要有缝。日期加上时刻之后这一行变长了
    （「已完成 · 中班 · 有配图 · 今天 14:05」），在特大字号档下会折到第二行，
    没有行间距的话那一行会贴在上一行底下，看起来像渲染坏了。
  */
  row-gap: 6rpx;
}

.badge {
  display: flex;
  align-items: center;
  border-radius: $r-chip;
  padding: 3rpx 16rpx;
  margin-right: 12rpx;

  &--draft {
    background: $paper;
    border: 2rpx solid $rule-2;
  }

  &--done {
    background: $mint-soft;
    border: 2rpx solid $mint;
  }
}

.badge__dot {
  width: 10rpx;
  height: 10rpx;
  border-radius: 999rpx;
  background: $mint;
  margin-right: 8rpx;
}

.badge__t {
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;

  &--done {
    color: $mint-deep;
    font-weight: 600;
  }
}

.card__age {
  font-size: var(--fs-tag);
  color: $ink-2;
  margin-right: 12rpx;
}

.card__img {
  font-size: var(--fs-tag);
  color: $sky-deep;
  margin-right: 12rpx;
}

.card__date {
  font-size: var(--fs-tag);
  color: $ink-3;
}

.card__t {
  display: block;
  font-size: var(--fs-card);
  font-weight: 600;
  color: $ink;
  line-height: 1.45;
}

.card__p {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  margin-top: 6rpx;
}

.card__go {
  display: flex;
  align-items: center;
  margin-top: 14rpx;
}

.card__go-t {
  font-size: var(--fs-sub);
  color: $ink-2;
  font-weight: 600;

  &--done {
    color: $mint-deep;
  }
}

.card__go-i {
  width: 24rpx;
  height: 24rpx;
  margin-left: 8rpx;
}

/* ============ 翻页 ============ */
.more {
  border: 2rpx dashed $rule-2;
  border-radius: 24rpx;
  padding: 24rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20rpx;
}

.more__t {
  font-size: var(--fs-sub);
  color: $ink-3;
}

/* ============ 首次引导（只教左滑这一件事）============ */
.hint {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  background: rgba(58, 54, 48, .55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 99;
}

.hint__box {
  background: $white;
  border-radius: 32rpx;
  padding: 40rpx 36rpx 32rpx;
  margin: 0 60rpx;
  align-items: center;
  display: flex;
  flex-direction: column;
}

/* 一个静态的示意：左边一块卡片形状，右边露出红键。
   不做动画 —— 一次性引导上加动画，她还没看懂就播完了 */
.hint__demo {
  position: relative;
  width: 420rpx;
  height: 96rpx;
  border-radius: 20rpx;
  overflow: hidden;
  background: $coral-deep;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin-bottom: 24rpx;
}

.hint__card {
  position: absolute;
  left: -84rpx;
  top: 0;
  bottom: 0;
  width: 420rpx;
  background: $paper-2;
  border: 2rpx solid $rule-2;
  border-radius: 20rpx;
}

.hint__del {
  width: 168rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hint__del-t {
  color: $white;
  font-size: var(--fs-sub);
  font-weight: 600;
}

.hint__t {
  font-size: var(--fs-body);
  color: $ink;
  text-align: center;
}

.hint__ok {
  margin-top: 28rpx;
  background: $amber;
  border: 2rpx solid $amber-line;
  border-radius: 20rpx;
  padding: 18rpx 56rpx;
}

.hint__ok-t {
  font-size: var(--fs-body);
  color: $ink;
  font-weight: 600;
}

</style>
