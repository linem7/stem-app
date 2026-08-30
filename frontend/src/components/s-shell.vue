<template>
  <div class="shell" :class="{ 'shell--narrow': shell.wide && shell.collapsed }">
    <!-- 窄屏抽屉开着时的蒙版。点它关掉 —— 误触时最自然的退出方式是点旁边 -->
    <div v-if="shell.drawer && !shell.wide" class="shell__mask" @click="closeDrawer" />

    <aside class="side" :class="{ 'side--open': shell.drawer }">
      <div class="side__hd">
        <button type="button" class="side__new" @click="goNew">
          <img class="side__new-i" :src="plusIcon" alt="" />
          <span class="side__new-t">写新教案</span>
        </button>
      </div>

      <!--
        两排筛选，摆在「写新教案」正下方（2026-08-31 用户定）。
        状态那排带数字 —— 老师最常问的是「我还有几份没写完」。

        🔴 **分段控件，不是一排会换行的胶囊**（2026-08-31 用户定）。
        胶囊按内容宽度排，`全部 11` 加上两位数就把 `已完成 9` 挤到下一行，
        而数到 100 份时断行位置又换一个地方 —— 排版跟着数据变。
        每段 `flex:1` 等宽平分之后，**宽度跟数字几位无关，永远不换行**。
      -->
      <div class="seg">
        <button
          v-for="s in STATES"
          :key="`st-${s.key}`"
          type="button"
          class="seg__b"
          :class="{ 'seg__b--on': status === s.key }"
          @click="setStatus(s.key)"
        >
          <!-- 打勾不是装饰：黄底压次级底只有 1.51:1，光靠颜色分不出哪个被选中 -->
          <img v-if="status === s.key" class="seg__ck" :src="checkInk" alt="已选" />
          <span class="seg__t">{{ s.label }}</span>
          <span v-if="counts[s.key]" class="seg__n">{{ counts[s.key] }}</span>
        </button>
      </div>
      <div class="seg seg--age">
        <button
          v-for="a in AGES"
          :key="`ag-${a.key}`"
          type="button"
          class="seg__b"
          :class="{ 'seg__b--on': ageGroup === a.key }"
          @click="setAge(a.key)"
        >
          <img v-if="ageGroup === a.key" class="seg__ck" :src="checkInk" alt="已选" />
          <span class="seg__t">{{ a.label }}</span>
        </button>
      </div>

      <div class="side__list">
        <template v-if="loading">
          <s-skel v-for="n in 4" :key="`sk-${n}`" kind="card" />
        </template>

        <!-- 拉不到就说拉不到。**不许画成「一份都没有」** —— 假话的代价是她不会重试，她会走 -->
        <s-state
          v-else-if="loadError"
          :kind="stateKind(loadError)"
          :text="loadError.message"
          action-label="重试"
          @action="load"
        />

        <!-- 筛完一份都没有，跟「一份都没写过」不是一回事：前者要给一条**回去的路**，
             后者要给一条**开始的路**。都画成「还没有写过教案」是句假话 -->
        <s-state
          v-else-if="!items.length"
          kind="empty"
          :text="isFiltered ? '这个筛选下没有教案' : '还没有写过教案'"
          :action-label="isFiltered ? '看全部' : ''"
          @action="clearFilters"
        />

        <button
          v-for="it in items"
          v-else
          :key="it.id"
          type="button"
          class="row"
          :class="{ 'row--on': it.id === activeId }"
          @click="open(it)"
        >
          <span class="row__t">{{ it.title || '未命名教案' }}</span>
          <span class="row__m">
            <span v-if="isDraft(it)" class="row__badge">草稿</span>
            <span v-if="it.age_group" class="row__age">{{ it.age_group }}</span>
            <span class="row__date">{{ fmtDate(it.updated_at) }}</span>
          </span>
        </button>
      </div>

      <button type="button" class="side__me" @click="goMe">
        <img class="side__me-i" :src="meIcon" alt="" />
        <span class="side__me-t">{{ session.teacher?.nickname || '我的' }}</span>
      </button>
    </aside>

    <s-me :visible="meOpen" @close="meOpen = false" />

    <div class="main">
      <slot />
    </div>
  </div>
</template>

<script setup>
/**
 * 全站外壳：左边一条侧边栏 + 右边正文（2026-08-30 用户定）。
 *
 * 宽屏（≥900px）侧边栏常驻，可以收起；窄屏它变成从左边滑出来的抽屉。
 * **两种形态是同一套 DOM**，只有 CSS 不一样 —— 不是两套页面。
 * 一套内容两个外壳，改一处两边一起变；真写两套，两边迟早长歪。
 *
 * 挂在 App.vue 里包住 router-view，所以**换页时它不重新挂载**，
 * 那条教案列表不用每翻一页重拉一次。
 *
 * 它替掉了底部三项（s-tabbar 已删）。首页 = 侧边栏的「写新教案」，
 * 教案库 = 侧边栏这条列表本身，我的 = 左下角那一行。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { listConversations } from '../api/conversations.js'
import { session } from '../stores/session.js'
import { shell, closeDrawer } from '../stores/shell.js'
import { iconCheck, iconMe, iconPlus } from '../utils/icons.js'
import { COLORS } from '../utils/colors.js'
import { push, replace } from '../utils/nav.js'
import { stateKind } from '../utils/ui.js'

const route = useRoute()
const plusIcon = iconPlus(COLORS.ink)
const meIcon = iconMe(COLORS.coralDeep, false)
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

const meOpen = ref(false)
const items = ref([])
const counts = reactive({ all: 0, draft: 0, completed: 0 })
const status = ref('all')
const ageGroup = ref('all')
const loading = ref(true)
const loadError = ref(null)

const isFiltered = computed(() => status.value !== 'all' || ageGroup.value !== 'all')

/** 正在看的那一份，在列表里高亮。`/c?id=` 里的 id 就是会话 id（列表的主键） */
const activeId = computed(() => (route.name === 'conv' ? Number(route.query.id || 0) : 0))

const isDraft = (it) => it.status !== 'completed'

onMounted(load)

/* 换页之后重拉一次：她刚写完一份，列表里要有它。
   只认路由名字变化，同一页里改 query（比如回退版本）不重拉。 */
watch(() => route.name, load)

async function load() {
  loadError.value = null
  if (!items.value.length) loading.value = true
  try {
    const data = await listConversations({
      status: status.value,
      ageGroup: ageGroup.value,
      limit: 20,
    })
    items.value = data.items || []
    // counts 是**不受筛选影响的总数**（后端算的），所以状态那排的数字
    // 不会因为筛了一下就跟着变小 —— 那样她就没法用它判断「还有几份没写完」
    Object.assign(counts, data.counts || {})
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

function setStatus(key) {
  if (status.value === key) return
  status.value = key
  items.value = []
  load()
}

function setAge(key) {
  if (ageGroup.value === key) return
  ageGroup.value = key
  items.value = []
  load()
}

function clearFilters() {
  status.value = 'all'
  ageGroup.value = 'all'
  items.value = []
  load()
}

/**
 * 时间要带时刻（「今天 14:05」）。她一天里常连着写两三份，
 * 三条全写「今天」就分不出哪条是刚才那份。
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

/** 窄屏上点完要把抽屉收掉，否则跳过去了它还盖在正文上 */
function afterPick() {
  if (!shell.wide) closeDrawer()
}

function goNew() {
  afterPick()
  replace('home')
}

/* 左下角那一行 = 打开「我的」弹窗（2026-08-31 用户定）。
   额度 / 可换额度的事 / 我的记忆（含个人档案）/ 注销 / 提建议 / 字号，全在里面 */
function goMe() {
  afterPick()
  meOpen.value = true
}

/* 草稿和成稿是**同一个地址**（2026-08-30 合并成一条流）：
   那一页自己按会话的状态决定从哪一截开始画。 */
function open(it) {
  afterPick()
  push('conv', { id: it.id })
}
</script>

<style lang="scss" scoped>
$side-w: 264px;

.shell {
  min-height: 100dvh;
}

.shell__mask {
  position: fixed;
  inset: 0;
  z-index: 800;
  background: rgba(58, 54, 48, 0.45);
}

/* ============ 侧边栏 ============ */
/*
  窄屏：盖在正文上的抽屉，默认推到屏幕左边外面。
  用 transform 而不是 left：transform 不触发重排，低端安卓机上滑得动。
*/
.side {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 810;
  width: $side-w;
  display: flex;
  flex-direction: column;
  background: $paper-2;
  border-right: 1px solid $rule;
  transform: translateX(-100%);
  transition: transform 0.22s ease;
}

.side--open {
  transform: translateX(0);
}

.side__hd {
  flex: none;
  padding: $sp-3 $sp-3 $sp-2;
}

/* 「写新教案」是这一栏唯一的主行动，所以用暖阳黄那一套的浅底 + 实描边 */
.side__new {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  border: 1px solid $amber-line;
  border-radius: $r-btn;
  background: $amber-soft;
  padding: 10px;
}

.side__new-i {
  width: 14px;
  height: 14px;
  margin-right: 6px;
}

.side__new-t {
  font-size: var(--fs-sub);
  font-weight: 600;
  color: $ink;
}

/* ============ 筛选 ============ */
/*
  分段控件：整条一个外框，里面等宽平分。
  **每段 flex:1 + min-width:0** —— 少了 min-width:0，长标签会把那一段撑宽，
  等宽就又不成立了（flex 项目默认 min-width:auto，撑不下去就是不缩）。
*/
.seg {
  flex: none;
  display: flex;
  margin: 0 $sp-3 5px;
  border: 1px solid $rule-2;
  border-radius: $r-sm;
  background: $paper;
  overflow: hidden;

  &--age {
    margin-bottom: $sp-2;
  }
}

.seg__b {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  /* 触控区不该太小。5px 上下 + 12px 字 ≈ 26px，加上两排之间的间隔够用了 */
  padding: 6px 2px;
  border-right: 1px solid $rule-2;

  &:last-child {
    border-right: none;
  }
}

.seg__b--on {
  background: $amber;
}

.seg__ck {
  flex: none;
  width: 9px;
  height: 9px;
}

/* 一个字都不许换行，也不许把那一段撑宽 —— 分段控件的全部意义就是宽度不跟内容走 */
.seg__t {
  font-size: var(--fs-tag);
  color: $ink-2;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.seg__b--on .seg__t {
  color: $ink;
  font-weight: 600;
}

/* 数字单独一个 span，靠父级那 2px 的 gap 跟文字分开 ——
   写成 `全部11` 挤成一坨，而这个数字是要被读的 */
.seg__n {
  flex: none;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.4;
}

.seg__b--on .seg__n {
  color: $ink;
  font-weight: 700;
}

/* 列表自己滚。整条侧边栏是定高的，不让它把页面撑长 */
.side__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 $sp-3;
}

.row {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  border-radius: $r-sm;
  padding: 8px 9px;
  margin-bottom: 2px;
}

/* 正在看的那一条。底色之外还加了左边一道竖杠 —— 颜色不做状态的唯一载体 */
.row--on {
  background: $white;
  border-color: $rule-2;
  box-shadow: inset 3px 0 0 $amber;
}

.row__t {
  display: block;
  font-size: var(--fs-sub);
  color: $ink;
  line-height: 1.45;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.row--on .row__t {
  font-weight: 600;
}

.row__m {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
}

/* 草稿只用颜色说不清楚，所以写字（黄色在奶油底上先天到不了 3:1） */
.row__badge {
  font-size: var(--fs-tag);
  font-weight: 600;
  color: $amber-deep;
}

.row__age,
.row__date {
  font-size: var(--fs-tag);
  color: $ink-3;
}

.side__me {
  flex: none;
  display: flex;
  align-items: center;
  width: 100%;
  border-top: 1px solid $rule;
  padding: 11px $sp-3;
  padding-bottom: calc(11px + env(safe-area-inset-bottom));
}

.side__me-i {
  width: 17px;
  height: 17px;
  margin-right: 7px;
}

.side__me-t {
  font-size: var(--fs-sub);
  color: $ink-2;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* ============ 宽屏 ============ */
/*
  侧边栏常驻，正文让开它那一条。

  正文**没有跟着屏幕拉满**：一份教案两千多字，一行超过 40 个汉字眼睛就会串行。
  所以 .s-page 那个最大宽度留着（见 s-page.vue），侧边栏吃掉多出来的空间。
*/
@media (min-width: 900px) {
  .side {
    transform: translateX(0);
    transition: none;
  }

  .main {
    margin-left: $side-w;
  }

  /* 收起来：整条推出去，正文占满。她收起来就是为了正文更宽 */
  .shell--narrow .side {
    transform: translateX(-100%);
  }

  .shell--narrow .main {
    margin-left: 0;
  }
}
</style>
