<template>
  <s-page :dock="loaded">
    <template #top>
      <s-topbar :title="headline" />

      <view v-if="loaded" class="prog">
        <view class="prog__left">
          <view class="prog__bars">
            <view
              v-for="q in questions"
              :key="q.id"
              class="prog__bar"
              :class="{ 'prog__bar--done': isAnswered(q.id) }"
            />
          </view>
          <text class="prog__lb">答了 <text class="prog__n">{{ progress.answered }}</text>/{{ progress.total }} 题</text>
        </view>
        <text class="prog__hint">{{ requiredLeft ? '年龄班必答' : '随时可以生成' }}</text>
      </view>
    </template>

    <!-- 加载中 -->
    <template v-if="!loaded && !loadError">
      <view v-for="n in 3" :key="`sk-${n}`" class="sk-block">
        <s-skel kind="title" />
        <s-skel kind="opt" />
        <s-skel kind="opt" />
      </view>
    </template>

    <!-- 加载失败。网回来时 s-state 会自己重拉一次 —— 她不用记得回来点 -->
    <s-state
      v-else-if="loadError"
      :kind="stateKind(loadError)"
      :text="loadError.message"
      action-label="重试"
      @action="load"
    />

    <template v-else>
      <text class="lead">就问这 <text class="lead__n">{{ progress.total }}</text> 个，其余的我来定，写好了你再改。</text>

      <view v-for="(q, qi) in questions" :key="q.id" class="qb" :class="{ 'qb--done': isAnswered(q.id) }">
        <view class="qb__h">
          <view class="qb__n" :class="{ 'qb__n--done': isAnswered(q.id) }">
            <image v-if="isAnswered(q.id)" class="qb__n-check" :src="checkMint" mode="widthFix" />
            <text v-else class="qb__n-t">{{ String(qi + 1).padStart(2, '0') }}</text>
          </view>
          <text class="qb__t">
            {{ q.title }}<text v-if="q.required" class="qb__must">必答</text>
          </text>
        </view>

        <text v-if="q.hint || q.multi" class="qb__hint">
          {{ q.hint || '' }}{{ q.multi ? (q.hint ? ' · 可多选' : '可多选') : '' }}
        </text>

        <s-option
          v-for="o in q.options"
          :key="`${q.id}-${o.key}`"
          :okey="o.key"
          :label="o.label"
          :sub="o.sub"
          :selected="isPicked(q.id, o.key)"
          :dim="isAnswered(q.id)"
          @press="pick(q, o.key)"
        />

        <template v-if="q.allow_custom">
          <textarea
            v-if="state(q.id).ownOpen"
            :value="state(q.id).customText"
            class="own"
            placeholder="说说你的想法…"
            placeholder-class="own__ph"
            :maxlength="300"
            :auto-height="true"
            :focus="focusedQ === q.id"
            @input="onOwnInput(q, $event)"
            @blur="onOwnBlur(q)"
          />
          <s-option
            v-else
            own
            :okey="customKey(q)"
            :label="state(q.id).customText || '我自己说 —— 点这里打字'"
            :dim="isAnswered(q.id)"
            @press="openOwn(q)"
          />
        </template>

        <!-- 这一题没存上。不能只弹个 toast 就算了：界面上还打着勾，
             她以为答好了，实际生成教案时这题是空的 -->
        <view v-if="state(q.id).failed" class="fail" @tap="pushAnswer(q)">
          <text class="fail__t">这一题没存上，点这里重发</text>
        </view>

        <!-- 后端对这一题的一句话回应，让她知道自己选的被听进去了 -->
        <view v-else-if="state(q.id).ack" class="ack"><text class="ack__t">{{ state(q.id).ack }}</text></view>
      </view>
    </template>

    <template #dock>
      <s-button
        :label="dockLabel"
        arrow
        :disabled="requiredLeft > 0"
        :loading="generating"
        loading-text="正在开始"
        @press="generate"
      />
      <!-- 禁用不能只靠变灰：旁边必须有一句话说明还差什么（design-tokens 派生档那节） -->
      <text v-if="requiredLeft > 0" class="dock__why">上面第一题选一下年龄班就能开始</text>
    </template>
  </s-page>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import {
  answerQuestion,
  getConversation,
  refetchQuestions,
  startGenerate,
} from '../../api/conversations.js'
import { session } from '../../stores/session.js'
import { take } from '../../stores/handoff.js'
import { iconCheck } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { redirectTo } from '../../utils/nav.js'
import { showApiError, stateKind, toast } from '../../utils/ui.js'

const checkMint = iconCheck(COLORS.mintDeep, 2.4)

/** 选中项拼串时的分隔符。选项 key 只有 A–E，不含竖线 */
const SEP = '|'

const conversationId = ref(0)
const seedInput = ref('')
const title = ref('')
const questions = ref([])
const loaded = ref(false)
const loadError = ref(null)
const generating = ref(false)
const focusedQ = ref('')
/** 当前这套推荐答案是按哪个年龄班生成的。换了班才重拉，没换就别白跑一趟接口 */
const appliedAge = ref('')

const progress = reactive({ answered: 0, total: 4, required_left: 1 })
/** { [questionId]: { selected, customText, savedText, ownOpen, ack, failed } } */
const answers = reactive({})

const headline = computed(() => {
  if (title.value) return title.value
  // 「的」要连着「活动」一起去掉，否则「我想做个影子的活动」会推出「影子的的活动」
  const s = seedInput.value.replace(/^我想做个/, '').replace(/的?活动$/, '')
  return s ? `${s}的活动` : '说说你的想法'
})

/**
 * 还差几道必答题。
 *
 * **不能只信服务端的 progress.required_left** —— 那个值只在 answer 请求成功时才更新。
 * 请求超时或断网时（后端其实已经落库了，慢的是它再调一次模型要那句 ack），
 * 界面上题块已经打了绿勾，按钮却永远是灰的，老师再点同一项也发不出请求，只能杀掉小程序重进。
 * 所以闸门用本地答题状态算，服务端的数字只用来显示「答了 N/4」。
 */
const requiredLeft = computed(
  () => questions.value.filter((q) => q.required && !isAnswered(q.id)).length
)

const dockLabel = computed(() => {
  if (requiredLeft.value > 0) return '先选一下年龄班'
  const left = progress.total - progress.answered
  return left > 0 ? `写教案吧（${left} 题没答也行）` : '写教案吧'
})

const EMPTY_ANSWER = Object.freeze({
  selected: [],
  customText: '',
  savedText: '',
  ownOpen: false,
  ack: '',
  failed: false,
})

/**
 * 读某题的答题状态。
 * **只读，不许在这里补建条目** —— 模板里到处都在调它，渲染期间往 reactive 上写
 * 会触发重新渲染，转成死循环。条目统一在 questions 到手时一次建好（见 seedAnswers）。
 */
function state(qid) {
  return answers[qid] || EMPTY_ANSWER
}

function blankAnswer() {
  return { selected: [], customText: '', savedText: '', ownOpen: false, ack: '', failed: false }
}

function seedAnswers(list) {
  for (const q of list) if (!answers[q.id]) answers[q.id] = blankAnswer()
}

const isPicked = (qid, key) => state(qid).selected.includes(key)
const isAnswered = (qid) => state(qid).selected.length > 0 || Boolean(state(qid).customText)

/** 「我自己说」排在最后一个选项后面，A/B/C/D 顺着排下去 */
const customKey = (q) => String.fromCharCode(65 + (q.options?.length || 0))

onLoad((query) => {
  conversationId.value = Number(query?.id || 0)
  load()
})

async function load() {
  loadError.value = null
  try {
    // 首页开会话时后端已经把这 4 道题连同推荐答案一起给过了，直接用，
    // 不再多打一趟 —— 老师刚等完「正在准备问题」，进来不该再看一次骨架屏。
    // 拿不到（从教案库点进来、或页面被系统回收后重建）就照常自己拉
    const data =
      take(`conversation:${conversationId.value}`) || (await getConversation(conversationId.value))
    seedInput.value = data.seed_input || ''
    title.value = data.title || ''
    questions.value = data.questions || []
    seedAnswers(questions.value)
    Object.assign(progress, data.progress || {})
    // 断点续写：把已答的原样还原回去，老师被叫走再回来看到的是她离开时的样子
    for (const [qid, a] of Object.entries(data.answers || {})) {
      if (!answers[qid]) answers[qid] = blankAnswer()
      const s = answers[qid]
      s.selected = a.selected || []
      s.customText = a.custom_text || ''
      s.savedText = s.customText
      s.ownOpen = Boolean(a.custom_text)
    }
    // 这套推荐答案是按哪个班生成的：会话里存了就用会话的，
    // 没存说明是刚开的 —— 后端是照老师档案里的年龄班出的题，基线就是档案那个。
    // 少了这一步，她第一次选年龄班（哪怕选的就是自己那个班）也会白白重拉一次推荐答案。
    appliedAge.value = data.age_group || session.teacher?.age_group || ''
    loaded.value = true
  } catch (err) {
    loadError.value = err
  }
}

/* ============ 答题 ============ */

// 每选一项就调一次接口（她被叫走进度不丢）。手快连点会并发，
// 同一题按顺序排队，保证最后落库的是最后一次点的那个状态。
const chains = {}
function enqueue(qid, task) {
  const next = (chains[qid] || Promise.resolve()).then(task, task)
  chains[qid] = next
  return next
}

/** 等所有题的落库都跑完。点「写教案吧」之前必须等，否则最后一下选的可能还没到后端 */
function settleAll() {
  return Promise.all(Object.values(chains))
}

function pick(q, key) {
  const s = answers[q.id]
  if (!s) return
  const before = s.selected.join(SEP)

  if (q.multi) {
    const i = s.selected.indexOf(key)
    if (i >= 0) s.selected.splice(i, 1)
    else s.selected.push(key)
  } else {
    // 单选点已选中的那项 = 取消，她改主意很正常
    s.selected = s.selected[0] === key ? [] : [key]
  }

  // 必答题（现在只有年龄班）不能取消到空：后端会 400「这题要选一个才能继续」。
  // 对老师来说这个限制也是对的 —— 不选年龄班，写出来的教案一定是错的。
  // 所以第二下点在已选中的年龄班上，就当没点。
  if (q.required && s.selected.length === 0 && !s.customText.trim()) {
    s.selected = before ? before.split(SEP) : []
    return
  }

  // 选的没变但上次没存上，那就是她在重试
  if (s.selected.join(SEP) === before && !s.failed) return
  submit(q)
}

function openOwn(q) {
  if (!answers[q.id]) return
  answers[q.id].ownOpen = true
  focusedQ.value = q.id
}

// 不用 v-model：那会编译成往 state(q.id) 的返回值上赋值，而没建条目时返回的是
// 冻结的 EMPTY_ANSWER，赋值在严格模式下直接抛。写回口子明确指向 answers[q.id]。
function onOwnInput(q, e) {
  if (!answers[q.id]) return
  answers[q.id].customText = e.detail.value
}

/** 一个字都没改就别重发 —— 后端每次都要再跑一趟模型要那句 ack，白花钱也白等 */
function onOwnBlur(q) {
  const s = answers[q.id]
  if (!s) return
  if (s.customText.trim() === s.savedText.trim() && !s.failed) return
  submit(q)
}

/** 只负责把这一题的当前状态推给后端，不管年龄班那套联动 */
function pushAnswer(q) {
  const s = answers[q.id]
  if (!s) return Promise.resolve()
  return enqueue(q.id, async () => {
    const sent = { selected: [...s.selected], customText: s.customText.trim() || null }
    try {
      const res = await answerQuestion(conversationId.value, {
        questionId: q.id,
        selected: sent.selected,
        customText: sent.customText,
      })
      Object.assign(progress, res.progress || {})
      s.ack = res.ack || ''
      s.savedText = sent.customText || ''
      s.failed = false
    } catch (err) {
      // 不回滚选中态 —— 后端是先落库再调模型要 ack 的，超时的多半是 ack 那一段，
      // 答案其实已经存进去了，把她的选择抹掉更糟。改成明确标一句「没存上，点这里重发」，
      // 让界面别再假装成功。
      s.failed = true
      s.ack = ''
      showApiError(err)
    }
  })
}

async function submit(q) {
  await pushAnswer(q)

  // 换了年龄班要重拉推荐答案 —— 推荐项综合了年龄班规则、老师档案和记忆，
  // 只有后端算得出来，前端不许硬编码任何推荐项。
  //
  // 跟 appliedAge 比而不是跟「提交前的 selected」比：pick() 是先改状态再调 submit 的，
  // 在这里读 selected 拿到的已经是新值，前后永远相等，重拉就一次都不会发生。
  if (q.key === 'age_group') {
    const after = readAgeLabel()
    if (after && after !== appliedAge.value) {
      appliedAge.value = after
      await reloadRecommendations(after)
    }
  }
}

/** 当前选中的年龄班中文名（小班/中班/大班），没选返回空串 */
function readAgeLabel() {
  const q = questions.value.find((x) => x.key === 'age_group')
  if (!q) return ''
  const key = state(q.id).selected[0]
  return q.options?.find((o) => o.key === key)?.label || ''
}

/**
 * 换班后重拉推荐答案。
 *
 * 坑在这：**同一个字母换班后指向的是另一个答案**。实测中班的场地是
 * A=教室区角 / B=走廊 / C=户外空地，换成大班变成 A=教室建构区 / B=室内走廊 /
 * C=户外沙池或草地。要是把勾原样留在 B 上，老师看到的就是她没选过的东西。
 *
 * 所以按**文案**而不是按字母重新对位：还找得到同样意思的选项就把勾挪过去，
 * 找不到就清掉那一题，并且同步告诉后端（后端存的是文案，不清它那边还留着旧答案，
 * 两边就对不上了）。
 */
async function reloadRecommendations(ageGroup) {
  try {
    const data = await refetchQuestions(conversationId.value, ageGroup)
    const byId = Object.fromEntries((data.questions || []).map((x) => [x.id, x]))
    const resync = []
    let dropped = 0

    questions.value = questions.value.map((q) => {
      const next = byId[q.id]
      if (!next || q.key === 'age_group') return q
      const s = answers[q.id]
      if (s && s.selected.length) {
        const labels = s.selected
          .map((k) => q.options?.find((o) => o.key === k)?.label)
          .filter(Boolean)
        const remapped = labels
          .map((label) => next.options?.find((o) => o.label === label)?.key)
          .filter(Boolean)
        if (remapped.length !== s.selected.length) dropped += 1
        if (remapped.join(SEP) !== s.selected.join(SEP)) {
          s.selected = remapped
          resync.push(next)
        }
      }
      return next
    })

    seedAnswers(questions.value)
    for (const q of resync) await pushAnswer(q)

    // showToast 的标题显示不下长句，后面会被截掉。有题被清空是要她动手的事，
    // 用能停住的弹框；只是换了推荐答案就一句轻提示。
    if (dropped) {
      uni.showModal({
        title: '',
        content: `推荐答案换成${ageGroup}的了。有 ${dropped} 题的选项不一样了，麻烦再选一次。`,
        showCancel: false,
        confirmText: '知道了',
      })
    } else {
      toast(`推荐答案已按${ageGroup}重给`)
    }
  } catch (err) {
    // 重拉失败不该挡着她继续答题，旧的推荐项还在
    showApiError(err)
  }
}

/* ============ 生成 ============ */

async function generate() {
  if (generating.value || requiredLeft.value > 0) return
  generating.value = true
  try {
    // 先等答题队列落完。她可能刚在「我自己说」里打完字就直接点了生成，
    // blur 触发的那次提交还在路上，不等就丢了。
    await settleAll()
    await startGenerate(conversationId.value)
    redirectTo('generating', { id: conversationId.value })
    // 这里**不要**在 finally 里解锁：跳转是异步的，解锁后老师手快再点一下，
    // 会在正在离开的页面上再发一次请求。让它保持 loading 直到页面被替换掉。
  } catch (err) {
    generating.value = false
    showApiError(err)
  }
}
</script>

<style lang="scss" scoped>
/* ============ 进度 ============ */
.prog {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 $sp-5 20rpx;
}

.prog__left {
  display: flex;
  align-items: center;
}

.prog__bars {
  display: flex;
  margin-right: 18rpx;
}

.prog__bar {
  width: 38rpx;
  height: 8rpx;
  border-radius: 4rpx;
  background: $rule-2;
  margin-right: 8rpx;

  &--done {
    background: $amber-deep;
  }
}

.prog__lb {
  font-size: var(--fs-tag);
  color: $ink-3;
  letter-spacing: 0.02em;
}

.prog__n {
  color: $amber-deep;
  font-weight: 700;
}

.prog__hint {
  font-size: var(--fs-sub);
  color: $ink-3;
}

/* ============ 题块 ============ */
.lead {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  line-height: 1.6;
  margin: 8rpx 0 36rpx;
}

.lead__n {
  color: $ink;
  font-weight: 700;
}

.qb {
  margin-bottom: 44rpx;
}

.qb__h {
  display: flex;
  align-items: center;
  margin-bottom: 6rpx;
}

.qb__n {
  flex: none;
  width: 44rpx;
  height: 44rpx;
  border-radius: 14rpx;
  background: $paper-2;
  border: 2rpx solid $rule-2;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 18rpx;

  &--done {
    background: $mint-soft;
    border-color: $mint;
  }
}

/* 24rpx = 12px，是 design-tokens 定的辅助文字下限，不能再小 */
.qb__n-t {
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink-3;
}

.qb__n-check {
  width: 26rpx;
  height: 26rpx;
}

.qb__t {
  flex: 1;
  font-size: var(--fs-card);
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: -0.01em;
  color: $ink;
}

/* 必答用黄底墨字的胶囊，不是只把字变个色 —— 颜色不做状态的唯一载体。
   这是整屏唯一的强制性提示，字号不该比别的辅助文字还小 */
.qb__must {
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink;
  background: $amber;
  border-radius: $r-chip;
  padding: 4rpx 14rpx;
  margin-left: 12rpx;
}

.qb__hint {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  margin: 0 0 20rpx 62rpx;
}

/* 答过的题整体降一档存在感，视线自然落到还没答的那几题上 */
.qb--done .qb__t {
  color: $ink-2;
}

.own {
  width: 100%;
  border: 2rpx solid $amber-line;
  border-radius: $r-btn;
  padding: 24rpx 26rpx;
  font-size: var(--fs-body);
  line-height: 1.55;
  color: $ink;
  background: $white;
  margin-bottom: 18rpx;
  box-shadow: 0 0 0 2rpx $amber-line;
  min-height: 96rpx;
}

.own__ph {
  color: $ink-3;
}

.ack {
  background: $sky-soft;
  border-radius: 20rpx;
  padding: 16rpx 22rpx;
  margin-top: 4rpx;
}

.ack__t {
  font-size: var(--fs-tag);
  color: $ink-2;
  line-height: 1.65;
}

.fail {
  background: $paper-2;
  border: 2rpx solid $coral;
  border-radius: 20rpx;
  padding: 16rpx 22rpx;
  margin-top: 4rpx;
}

.fail__t {
  font-size: var(--fs-tag);
  color: $coral-deep;
  line-height: 1.65;
}

/* ============ 底部 ============ */
.dock__why {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  text-align: center;
  margin-top: 12rpx;
}

</style>
