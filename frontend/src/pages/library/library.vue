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
        <text class="fil__t" :class="{ 'fil__t--on': ageGroup === a.key }">{{ a.label }}</text>
      </view>
    </view>

    <!-- 加载中 -->
    <template v-if="loading && !items.length">
      <view v-for="n in 3" :key="`sk-${n}`" class="sk" />
    </template>

    <template v-else-if="loadError">
      <text class="err">{{ loadError }}</text>
      <s-button label="重试" variant="plain" @press="reload" />
    </template>

    <!-- 一份都没有。空手而归时不要只给一句「暂无数据」，给一条出路 -->
    <template v-else-if="!items.length">
      <view class="empty">
        <text class="empty__t">{{ emptyText }}</text>
        <s-button v-if="isFiltered" label="看全部" variant="plain" @press="clearFilter" />
        <s-button v-else label="写一份新的" arrow @press="goHome" />
      </view>
    </template>

    <template v-else>
      <!--
        长按删除，不做左滑：左滑在小程序里要自己实现手势，而这一屏最要紧的是别误删 ——
        教案是老师花了时间的东西。长按 + 一句确认，比滑出一个红按钮稳。
      -->
      <view
        v-for="it in items"
        :key="it.id"
        class="card"
        :class="{ 'card--draft': isDraft(it) }"
        @tap="open(it)"
        @longpress="askDelete(it)"
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

      <!-- 手动翻页而不是滚到底自动加载：自动加载在弱网下会连着打好几次请求，
           而她真正想要的多半是上面那几份 -->
      <view v-if="cursor" class="more" @tap="loadMore">
        <text class="more__t">{{ loadingMore ? '正在拿…' : '再看 20 份' }}</text>
      </view>
    </template>
  </s-page>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { listConversations, removeConversation } from '../../api/conversations.js'
import { iconChevron } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { navTo, reLaunch } from '../../utils/nav.js'
import { showApiError, toast } from '../../utils/ui.js'

const chevron = iconChevron(COLORS.ink3)

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
const loadError = ref('')

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
  loadError.value = ''
  cursor.value = null
  try {
    const data = await listConversations({ status: status.value, ageGroup: ageGroup.value })
    items.value = data.items || []
    Object.assign(counts, data.counts || {})
    cursor.value = data.next_cursor || null
  } catch (err) {
    loadError.value = err.message
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

function clearFilter() {
  status.value = 'all'
  ageGroup.value = 'all'
  reload()
}

function goHome() {
  reLaunch('home')
}

/**
 * 打开哪一屏，看它写到哪儿了。
 * 草稿回引导页接着答；写完的进成稿页 —— 列表里已经带着 lesson_plan_id，不用再问一次后端。
 */
function open(it) {
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

function askDelete(it) {
  uni.showModal({
    title: '',
    content: `删掉「${it.title || '未命名教案'}」？删了就找不回来了。`,
    confirmText: '删掉',
    confirmColor: COLORS.coralDeep,
    cancelText: '算了',
    success: (r) => {
      if (r.confirm) doDelete(it)
    },
  })
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

/** 今天/昨天/几天前，比「2026-08-18 02:38」好读 */
function fmtDate(iso) {
  if (!iso) return ''
  const then = new Date(iso)
  const now = new Date()
  const days = Math.floor((now - then) / 86400000)
  if (days <= 0 && now.getDate() === then.getDate()) return '今天'
  if (days <= 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return `${then.getMonth() + 1} 月 ${then.getDate()} 日`
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
  font-size: 42rpx;
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
}

.hd__n {
  font-size: $fs-tag;
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

.fil__t {
  font-size: 25rpx;
  color: $ink-2;
  line-height: 1.5;

  &--on {
    color: $ink;
    font-weight: 600;
  }
}

/* ============ 卡片 ============ */
.card {
  background: $white;
  border: 2rpx solid $rule-2;
  border-radius: 28rpx;
  padding: 24rpx 26rpx;
  margin-bottom: 20rpx;
  box-shadow: $shadow-card;

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
  font-size: 22rpx;
  color: $ink-3;
  line-height: 1.6;

  &--done {
    color: $mint-deep;
    font-weight: 600;
  }
}

.card__age {
  font-size: 22rpx;
  color: $ink-2;
  margin-right: 12rpx;
}

.card__img {
  font-size: 22rpx;
  color: $sky-deep;
  margin-right: 12rpx;
}

.card__date {
  font-size: 22rpx;
  color: $ink-3;
}

.card__t {
  display: block;
  font-size: 31rpx;
  font-weight: 600;
  color: $ink;
  line-height: 1.45;
}

.card__p {
  display: block;
  font-size: $fs-tag;
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
  font-size: 25rpx;
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

/* ============ 翻页 / 空 / 骨架 ============ */
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
  font-size: 26rpx;
  color: $ink-3;
}

.empty {
  border: 3rpx dashed $rule-2;
  border-radius: $r-card;
  background: $paper-2;
  padding: 56rpx 32rpx;
  margin-top: 40rpx;
}

.empty__t {
  display: block;
  font-size: $fs-sub;
  color: $ink-3;
  line-height: 1.7;
  text-align: center;
  margin-bottom: 24rpx;
}

.sk {
  height: 180rpx;
  background: $paper-2;
  border-radius: 28rpx;
  margin-bottom: 20rpx;
}

.err {
  display: block;
  font-size: $fs-body;
  color: $ink-2;
  line-height: 1.7;
  margin: 60rpx 0 32rpx;
}
</style>
