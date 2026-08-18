<template>
  <s-page tab="me">
    <template v-if="loading">
      <view class="sk sk--title" />
      <view class="sk sk--card" />
      <view class="sk" />
    </template>

    <template v-else>
      <!-- 档案。这里的昵称是微信昵称，**不是**问卷里那个真实姓名 ——
           真实姓名和手机号永不下发前端，接口里根本没有那两个字段 -->
      <view class="hd">
        <text class="q">{{ teacher.nickname || '老师' }}</text>
        <text v-if="profileLine" class="hd__sub">{{ profileLine }}</text>
      </view>

      <!-- 额度。不能是黑箱：给了多少、用了多少、还剩多少，一行看完 -->
      <view class="quota">
        <view class="quota__z">
          <text class="quota__n">{{ quota.text.left }}</text>
          <text class="quota__u">次教案</text>
        </view>
        <view class="quota__sep" />
        <view class="quota__z">
          <text class="quota__n">{{ quota.image.left }}</text>
          <text class="quota__u">张配图</text>
        </view>
        <view class="quota__more" @tap="toggleGrants">
          <text class="quota__more-t">{{ showGrants ? '收起' : '台账' }}</text>
        </view>
      </view>

      <!-- 台账默认收着。要看的时候必须看得到「哪来的、什么时候给的」，
           否则「我的额度怎么少了」这种事没法自己查 -->
      <view v-if="showGrants" class="grants">
        <view v-for="(g, i) in grants" :key="i" class="grant">
          <text class="grant__t">{{ g.reason || '发放' }}</text>
          <text class="grant__n">+{{ g.text }} 教案 · +{{ g.image }} 配图</text>
          <text class="grant__d">{{ fmtDate(g.at) }}</text>
        </view>
        <text v-if="!grants.length" class="grants__none">还没有发放记录</text>
        <text class="grants__used">
          已用 {{ quota.text.used }} 次教案 · {{ quota.image.used }} 张配图。每份教案还送
          {{ freeRevisions }} 次免费改稿。
        </text>
      </view>

      <!-- ============ 记忆 ============ -->
      <view class="sec">
        <text class="sec__h">我的记忆</text>
        <text class="sec__m">写教案时会自动带上</text>
      </view>

      <!--
        **点整行就是改**，不额外挂一个「改」字按钮 —— 一行只有一个动作，
        那就让整行成为那个动作。也不显示 mem_type（「教学信息」之类）：
        这一屏叫「我的记忆」，每条都是记忆，再标一遍类型是给数据库看的，不是给她看的。

        能改是 2026-08-18 才通的：改一条要走 PATCH /memories/:id，而小程序发不出 PATCH，
        后端加了 POST /memories/:id/update 这条别名才成。
        她要改的往往只是一个数字（「12 个孩子」→「15 个」），逼她删掉重打一遍是白费功夫。
      -->
      <view v-for="(m, i) in memories" :key="m.id" class="mem" @tap="startEditMem(m)">
        <text class="mem__n">{{ String(i + 1).padStart(2, '0') }}</text>
        <text class="mem__t">{{ m.fact }}</text>
      </view>

      <!--
        编辑框。跟下面的「＋ 再记一条」一样用 v-show 而不是 v-if ——
        v-if/v-else 一对会让两个 handler 拿到同一个缓存 key，微信端把点击派发错人
        （踩过三次，test:mp 第 2 条查这个）。
      -->
      <view v-show="editing" class="add">
        <textarea
          :value="editFact"
          class="add__ta"
          placeholder-class="add__ph"
          :maxlength="200"
          :auto-height="true"
          @input="onEditFactInput"
        />
        <view class="add__ops">
          <s-button label="改好了" :disabled="!editFact.trim()" :loading="savingEdit" @press="saveEditMem" />
          <view class="editops">
            <view class="editops__x" @tap="askDeleteMem(editingMem)">
              <text class="editops__x-t">删掉这条</text>
            </view>
            <view class="editops__c" @tap="cancelEditMem">
              <text class="editops__c-t">算了</text>
            </view>
          </view>
        </view>
      </view>

      <text v-if="!memories.length" class="mem__none">
        还没有记到什么。写过几份教案之后，我会把你反复提到的情况记在这儿。
      </text>

      <!--
        这两块**不能写成 v-if / v-else 一对**。uni 按「模板位置」给事件处理器分配缓存 key，
        一对 v-if/v-else 占的是同一个位置：编译出来 cancelAdd 和「＋ 再记一条」
        拿到了同一个 key（实测都是 "97"），微信运行时会把点击派发到另一个上 ——
        表现就是点「算了」反而又打开一次输入框。`npm run test:mp` 第 2 条查的正是这个。
        用 v-show 而不是 v-if：两块都真实存在于节点树里（只是藏起来一块），
        编译器才会给它们分配**不同**的 handler key。改回 v-if 会立刻复现。
      -->
      <view v-show="adding" class="add">
        <textarea
          :value="newFact"
          class="add__ta"
          placeholder="例：我们班有个孩子对面粉过敏"
          placeholder-class="add__ph"
          :maxlength="100"
          :auto-height="true"
          :focus="true"
          @input="onNewFactTyping"
        />
        <view class="add__ops">
          <s-button label="记下来" :disabled="!newFact.trim()" :loading="savingMem" @press="saveMem" />
          <s-button label="算了" variant="ghost" @press="cancelAdd" />
        </view>
      </view>
      <view v-show="!adding" class="memadd" @tap="startAdd">
        <text class="memadd__t">＋ 再记一条</text>
      </view>


      <!--
        注销。夹在记忆和提建议之间，**不挨着最底下那个「设置 >」** ——
        原来两个可点区域上下贴着，右边又都是小按钮，很容易点删除时手滑点进设置（反过来更糟）。
        点了先弹一次警告说清后果（不能再用、科研部分撤不回），再确认一次才真删。
      -->
      <view class="hr" />
      <view class="row row--danger">
        <view class="row__b">
          <text class="row__t">删除我的全部数据</text>
          <text class="row__s">教案、配图、记忆和你的身份信息一起删掉</text>
        </view>
        <view class="del" @tap="onDeleteDataTap">
          <text class="del__t">删除</text>
        </view>
      </view>

      <!-- ============ 提建议 ============ -->
      <view class="hr" />
      <view class="sec">
        <text class="sec__h">提个建议</text>
        <text class="sec__m">我会挨条看</text>
      </view>

      <view v-if="sent" class="sent">
        <text class="sent__t">收到了，谢谢。</text>
      </view>
      <template v-else>
        <view class="cats">
          <view
            v-for="c in CATEGORIES"
            :key="c.key"
            class="cat"
            :class="{ 'cat--on': category === c.key }"
            @tap="pickCategory(c.key)"
          >
            <text class="cat__t" :class="{ 'cat__t--on': category === c.key }">{{ c.label }}</text>
          </view>
        </view>
        <textarea
          :value="suggestion"
          class="sug"
          placeholder="哪里不好用、想要什么，直接说"
          placeholder-class="sug__ph"
          :maxlength="500"
          :auto-height="true"
          @input="onSuggestionInput"
        />
        <s-button
          label="提交"
          :disabled="!suggestion.trim()"
          :loading="sending"
          loading-text="正在提交"
          @press="submitSuggestion"
        />
      </template>

      <!--
        条款和关于直接摆在这一屏，不再单独开一个「设置」页 ——
        那一页最后只剩这三行，为三行内容多一次跳转不值得。
      -->
      <view class="hr" />
      <view class="row" @tap="goAgreement">
        <text class="row__t">使用协议与隐私说明</text>
        <image class="row__i" :src="chevron" mode="widthFix" />
      </view>
      <view v-for="(a, i) in ABOUT" :key="`a-${i}`" class="row">
        <text class="row__t">{{ a.k }}</text>
        <text class="row__v">{{ a.v }}</text>
      </view>
    </template>
  </s-page>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { addMemory, deleteMyAccount, getQuota, listMemories, removeMemory, updateMemory } from '../../api/me.js'
import { sendFeedback } from '../../api/feedback.js'
import { session } from '../../stores/session.js'
import { iconChevron } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { navTo, reLaunch } from '../../utils/nav.js'
import { showApiError, toast } from '../../utils/ui.js'

const chevron = iconChevron(COLORS.ink3)

/**
 * 关于。只留文字模型和版本 ——
 * 「教学框架来自台湾 STEAM 教材」那条删了：那是我们的实现来源，
 * 对老师不构成任何可操作的信息。也不写图片模型：用哪家由后台定、会换。
 */
const ABOUT = [
  { k: '文字模型', v: 'DeepSeek' },
  { k: '版本', v: '内测 · 2026-08' },
]

const CATEGORIES = [
  { key: 'quality', label: '教案质量' },
  { key: 'feature', label: '想要新功能' },
  { key: 'usability', label: '用着别扭' },
  { key: 'other', label: '其他' },
]

const loading = ref(true)
const quota = reactive({ text: { granted: 0, used: 0, left: 0 }, image: { granted: 0, used: 0, left: 0 } })
const grants = ref([])
const freeRevisions = ref(2)
const showGrants = ref(false)
const memories = ref([])

const adding = ref(false)
const newFact = ref('')
const savingMem = ref(false)

/** 正在改哪一条。null = 没在改 */
const editingMem = ref(null)
const editing = computed(() => Boolean(editingMem.value))
const editFact = ref('')
const savingEdit = ref(false)

const category = ref('quality')
const suggestion = ref('')
const sending = ref(false)
const sent = ref(false)

const teacher = computed(() => session.teacher || {})

/** 园所 · 年龄班 · 教龄，有哪样写哪样 —— 缺的不要留一串「·」 */
const profileLine = computed(() =>
  [
    teacher.value.kindergarten_name,
    teacher.value.age_group,
    teacher.value.teaching_years ? `教龄 ${teacher.value.teaching_years} 年` : '',
  ]
    .filter(Boolean)
    .join(' · ')
)

onShow(() => load())

async function load() {
  try {
    // 两个都要，但**互不阻塞**：额度拉失败不该让记忆也看不到
    const [q, m] = await Promise.allSettled([getQuota(), listMemories()])
    if (q.status === 'fulfilled') {
      Object.assign(quota, q.value.quota || {})
      grants.value = q.value.grants || []
      freeRevisions.value = q.value.free_revisions ?? 2
    }
    if (m.status === 'fulfilled') memories.value = m.value.items || []
    if (q.status === 'rejected' && m.status === 'rejected') showApiError(q.reason)
  } finally {
    loading.value = false
  }
}

/* ============ 记忆 ============ */

// 都用具名函数，不写内联箭头：内联的在编译产物里更容易跟别处撞同一个 handler key
function toggleGrants() {
  showGrants.value = !showGrants.value
}

function startAdd() {
  adding.value = true
  cancelEditMem()
}

function onNewFactTyping(e) {
  newFact.value = e.detail.value
}

function cancelAdd() {
  adding.value = false
  newFact.value = ''
}

/* ---- 改一条 ---- */

function startEditMem(m) {
  if (!m) return
  editingMem.value = m
  editFact.value = m.fact
  // 打开编辑就把「新增」收起来，两个输入框同时开着不知道该往哪个打字
  adding.value = false
}

function onEditFactInput(e) {
  editFact.value = e.detail.value
}

function cancelEditMem() {
  editingMem.value = null
  editFact.value = ''
}

async function saveEditMem() {
  const fact = editFact.value.trim()
  const m = editingMem.value
  if (!fact || !m || savingEdit.value) return
  // 一个字没动就别发请求 —— 后端每次改都要过一遍内容安全检查
  if (fact === m.fact) return cancelEditMem()
  savingEdit.value = true
  try {
    await updateMemory(m.id, fact)
    cancelEditMem()
    await load()
    toast('改好了')
  } catch (err) {
    showApiError(err)
  } finally {
    savingEdit.value = false
  }
}

async function saveMem() {
  const fact = newFact.value.trim()
  if (!fact || savingMem.value) return
  savingMem.value = true
  try {
    await addMemory(fact)
    cancelAdd()
    await load()
    toast('记下了')
  } catch (err) {
    showApiError(err)
  } finally {
    savingMem.value = false
  }
}

function askDeleteMem(m) {
  // 记忆是会被喂进模型的东西，删除权必须完全在她手里；但也别手滑就没了
  uni.showModal({
    title: '',
    content: `删掉「${m.fact}」？以后写教案就不带上它了。`,
    confirmText: '删掉',
    confirmColor: COLORS.coralDeep,
    cancelText: '算了',
    success: (r) => {
      if (r.confirm) doDeleteMem(m)
    },
  })
}

async function doDeleteMem(m) {
  cancelEditMem()
  const before = memories.value
  memories.value = memories.value.filter((x) => x.id !== m.id)
  try {
    await removeMemory(m.id)
    toast('删了')
  } catch (err) {
    memories.value = before
    showApiError(err)
  }
}

/* ============ 建议 ============ */

function pickCategory(k) {
  category.value = k
}

function onSuggestionInput(e) {
  suggestion.value = e.detail.value
}

async function submitSuggestion() {
  const text = suggestion.value.trim()
  if (!text || sending.value) return
  sending.value = true
  try {
    await sendFeedback({ category: category.value, text })
    sent.value = true
    suggestion.value = ''
  } catch (err) {
    showApiError(err)
  } finally {
    sending.value = false
  }
}

/**
 * 注销要两步。第一步把后果说全 —— 这是不可逆的操作，
 * 而「不可逆」这三个字必须在她按下去之前出现，不能事后才说。
 */
function onDeleteDataTap() {
  uni.showModal({
    title: '删除全部数据？',
    content:
      '你的教案、配图、记忆，以及手机号和姓名都会被删掉，删完这个账号就不能再用了。' +
      '已经用于科研的那部分（你提交过的建议和评价）撤不回来，但不再关联到你。',
    confirmText: '我要删除',
    confirmColor: COLORS.coralDeep,
    cancelText: '算了',
    success: (r) => {
      if (r.confirm) confirmDeleteAccount()
    },
  })
}

/** 第二步。同一个动作问两次不是啰嗦：第一次是读，第二次才是决定 */
function confirmDeleteAccount() {
  uni.showModal({
    title: '确认删除',
    content: '这一步之后就找不回来了。',
    confirmText: '确认删除',
    confirmColor: COLORS.coralDeep,
    cancelText: '再想想',
    success: (r) => {
      if (r.confirm) doDeleteAccount()
    },
  })
}

async function doDeleteAccount() {
  try {
    await deleteMyAccount()
    // 不停留在这一页：数据已经没了，留在这儿只会看到一屏空壳。
    // 回首页，那边的 gate 会因为账号已注销把她挡在门外
    uni.showModal({
      title: '',
      content: '删好了。谢谢你用过这个工具。',
      showCancel: false,
      confirmText: '知道了',
      success: () => reLaunch('home'),
    })
  } catch (err) {
    showApiError(err)
  }
}

function goAgreement() {
  // view=1：只是回头看一眼，别走激活流程（否则会被 gate 弹回首页）
  navTo('agreement', { view: 1 })
}

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}
</script>

<style lang="scss" scoped>
.hd {
  margin: 40rpx 0 28rpx;
}

.q {
  display: block;
  font-size: 42rpx;
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
}

.hd__sub {
  display: block;
  font-size: $fs-sub;
  color: $ink-3;
  margin-top: 8rpx;
}

/* ============ 额度 ============ */
.quota {
  display: flex;
  align-items: center;
  background: $amber-soft;
  border: 2rpx solid $amber-line;
  border-radius: 28rpx;
  padding: 26rpx 28rpx;
}

.quota__z {
  display: flex;
  align-items: baseline;
}

.quota__n {
  font-size: 44rpx;
  font-weight: 700;
  color: $amber-deep;
  line-height: 1.1;
}

.quota__u {
  font-size: $fs-tag;
  color: $ink-2;
  margin-left: 8rpx;
}

.quota__sep {
  width: 2rpx;
  height: 40rpx;
  background: $amber-line;
  margin: 0 28rpx;
}

.quota__more {
  margin-left: auto;
  border: 2rpx solid $amber-line;
  border-radius: $r-chip;
  background: $white;
  padding: 8rpx 20rpx;
}

.quota__more-t {
  font-size: $fs-tag;
  color: $amber-deep;
  font-weight: 600;
}

.grants {
  background: $paper-2;
  border: 2rpx solid $rule-2;
  border-radius: 24rpx;
  padding: 20rpx 24rpx;
  margin-top: 14rpx;
}

.grant {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  margin-bottom: 10rpx;
}

.grant__t {
  font-size: 25rpx;
  color: $ink;
  font-weight: 600;
  margin-right: 12rpx;
}

.grant__n {
  font-size: $fs-tag;
  color: $mint-deep;
  margin-right: 12rpx;
}

.grant__d {
  font-size: 22rpx;
  color: $ink-3;
}

.grants__none,
.grants__used {
  display: block;
  font-size: $fs-tag;
  color: $ink-3;
  line-height: 1.65;
}

.grants__used {
  border-top: 2rpx solid $rule;
  margin-top: 8rpx;
  padding-top: 12rpx;
}

/* ============ 分节 ============ */
.sec {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 36rpx 0 16rpx;
}

.sec__h {
  font-size: 26rpx;
  font-weight: 700;
  color: $ink-2;
  letter-spacing: 0.04em;
}

.sec__m {
  font-size: $fs-tag;
  color: $ink-3;
}

.hr {
  height: 2rpx;
  background: $rule;
  margin: 36rpx 0 0;
}

/* ============ 记忆 ============ */
/* 整行可点 = 整行是编辑入口 */
.mem {
  display: flex;
  align-items: flex-start;
  padding: 20rpx 0;
  border-bottom: 2rpx solid $rule;
}

.mem__n {
  flex: none;
  width: 44rpx;
  font-size: $fs-tag;
  font-weight: 700;
  color: $ink-3;
  line-height: 1.7;
}

.mem__t {
  flex: 1;
  min-width: 0;
  font-size: 27rpx;
  color: $ink-2;
  line-height: 1.65;
}

.mem__none {
  display: block;
  font-size: $fs-sub;
  color: $ink-3;
  line-height: 1.7;
  padding: 12rpx 0 4rpx;
}

.memadd {
  border: 2rpx dashed $rule-2;
  border-radius: 24rpx;
  padding: 22rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 20rpx;
}

.memadd__t {
  font-size: 26rpx;
  color: $ink-3;
}

.add {
  margin-top: 20rpx;
}

.add__ta {
  width: 100%;
  border: 2rpx solid $amber-line;
  border-radius: $r-btn;
  background: $white;
  padding: 24rpx 26rpx;
  font-size: 28rpx;
  line-height: 1.6;
  color: $ink;
  min-height: 100rpx;
  box-shadow: 0 0 0 2rpx $amber-line;
}

.add__ph {
  color: $ink-3;
}

.add__ops {
  margin-top: 16rpx;
}

/* ============ 建议 ============ */
.cats {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 16rpx;
}

.cat {
  border: 2rpx solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 8rpx 22rpx;
  margin: 0 12rpx 12rpx 0;

  &--on {
    background: $amber;
    border-color: $amber-line;
  }
}

.cat__t {
  font-size: 25rpx;
  color: $ink-2;

  &--on {
    color: $ink;
    font-weight: 600;
  }
}

.sug {
  width: 100%;
  border: 2rpx solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 24rpx 26rpx;
  font-size: 28rpx;
  line-height: 1.6;
  color: $ink;
  min-height: 140rpx;
  margin-bottom: 18rpx;
}

.sug__ph {
  color: $ink-3;
}

.sent {
  background: $mint-soft;
  border: 2rpx solid $mint-line;
  border-radius: 24rpx;
  padding: 24rpx 26rpx;
}

.sent__t {
  font-size: 27rpx;
  color: $mint-deep;
  font-weight: 600;
}

/* ============ 设置入口 ============ */
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 30rpx 0 10rpx;
}

.row__t {
  font-size: 30rpx;
  color: $ink-2;
}

.row__v {
  font-size: 27rpx;
  color: $ink-3;
  text-align: right;
  margin-left: 20rpx;
}

.row__i {
  width: 26rpx;
  height: 26rpx;
  flex: none;
}

/* 编辑框底下那两个次要动作。删掉这条放在这里而不是列表行上 ——
   列表里每行都挂一个删除按钮，滑动时太容易碰到 */
.editops {
  display: flex;
  align-items: center;
  margin-top: 14rpx;
}

.editops__x {
  border: 2rpx solid $coral;
  border-radius: $r-chip;
  background: $paper;
  padding: 10rpx 24rpx;
  margin-right: 16rpx;
}

.editops__x-t {
  font-size: 25rpx;
  color: $coral-deep;
}

.editops__c {
  padding: 10rpx 20rpx;
}

.editops__c-t {
  font-size: 25rpx;
  color: $ink-3;
}

/* ============ 注销 ============ */
.row--danger {
  align-items: flex-start;
  padding-top: 24rpx;
}

.row__b {
  flex: 1;
  min-width: 0;
}

.row__s {
  display: block;
  font-size: $fs-tag;
  color: $ink-3;
  line-height: 1.6;
  margin-top: 4rpx;
}

/* 珊瑚色描边而不是实心红块：它要找得到，但不该在这一屏抢眼 */
.del {
  flex: none;
  border: 2rpx solid $coral;
  border-radius: $r-chip;
  background: $paper;
  padding: 10rpx 26rpx;
  margin-left: 20rpx;
}

.del__t {
  font-size: 25rpx;
  color: $coral-deep;
  font-weight: 600;
}

/* ============ 骨架 ============ */
.sk {
  background: $paper-2;
  border-radius: 24rpx;
  height: 120rpx;
  margin-bottom: 20rpx;

  &--title {
    height: 56rpx;
    width: 45%;
    margin-top: 40rpx;
    border-radius: $r-sm;
  }

  &--card {
    height: 140rpx;
    border-radius: 28rpx;
  }
}
</style>
