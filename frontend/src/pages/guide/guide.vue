<template>
  <s-page>
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
      <view v-for="n in 3" :key="n" class="sk-block">
        <view class="sk sk--title" />
        <view class="sk sk--opt" />
        <view class="sk sk--opt" />
      </view>
    </template>

    <!-- 加载失败 -->
    <template v-else-if="loadError">
      <text class="err">{{ loadError.message }}</text>
      <s-button label="重试" variant="plain" @tap="load" />
    </template>

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
          :key="o.key"
          :okey="o.key"
          :label="o.label"
          :sub="o.sub"
          :selected="isPicked(q.id, o.key)"
          :dim="isAnswered(q.id)"
          @tap="pick(q, o.key)"
        />

        <template v-if="q.allow_custom">
          <textarea
            v-if="state(q.id).ownOpen"
            :value="state(q.id).customText"
            class="own"
            @input="onOwnInput(q, $event)"
            placeholder="说说你的想法…"
            placeholder-class="own__ph"
            :maxlength="200"
            :auto-height="true"
            :focus="focusedQ === q.id"
            @blur="submit(q)"
          />
          <s-option
            v-else
            own
            :okey="customKey(q)"
            :label="state(q.id).customText || '我自己说 —— 点这里打字'"
            :dim="isAnswered(q.id)"
            @tap="openOwn(q)"
          />
        </template>

        <!-- 后端对这一题的一句话回应，让她知道自己选的被听进去了 -->
        <view v-if="state(q.id).ack" class="ack"><text class="ack__t">{{ state(q.id).ack }}</text></view>
      </view>
    </template>

    <template v-if="loaded" #dock>
      <s-button
        :label="dockLabel"
        arrow
        :disabled="requiredLeft > 0"
        :loading="generating"
        loading-text="正在开始"
        @tap="generate"
      />
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
import { iconCheck } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { redirectTo } from '../../utils/nav.js'
import { showApiError, toast } from '../../utils/ui.js'

const checkMint = iconCheck(COLORS.mintDeep, 2.4)

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
/** { [questionId]: { selected: [], customText: '', ownOpen: false, ack: '' } } */
const answers = reactive({})

const requiredLeft = computed(() => progress.required_left)

const headline = computed(() => {
  if (title.value) return title.value
  const s = seedInput.value.replace(/^我想做个/, '').replace(/活动$/, '')
  return s ? `${s}的活动` : '说说你的想法'
})

const dockLabel = computed(() => {
  if (requiredLeft.value > 0) return '先选一下年龄班'
  const left = progress.total - progress.answered
  return left > 0 ? `写教案吧（${left} 题没答也行）` : '写教案吧'
})

const EMPTY_ANSWER = Object.freeze({ selected: [], customText: '', ownOpen: false, ack: '' })

/**
 * 读某题的答题状态。
 * **只读，不许在这里补建条目** —— 模板里到处都在调它，渲染期间往 reactive 上写
 * 会触发重新渲染，转成死循环。条目统一在 questions 到手时一次建好（见 seedAnswers）。
 */
function state(qid) {
  return answers[qid] || EMPTY_ANSWER
}

function seedAnswers(list) {
  for (const q of list) {
    if (!answers[q.id]) answers[q.id] = { selected: [], customText: '', ownOpen: false, ack: '' }
  }
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
    const data = await getConversation(conversationId.value)
    seedInput.value = data.seed_input || ''
    title.value = data.title || ''
    questions.value = data.questions || []
    seedAnswers(questions.value)
    Object.assign(progress, data.progress || {})
    // 断点续写：把已答的原样还原回去，老师被叫走再回来看到的是她离开时的样子
    for (const [qid, a] of Object.entries(data.answers || {})) {
      if (!answers[qid]) answers[qid] = { selected: [], customText: '', ownOpen: false, ack: '' }
      const s = answers[qid]
      s.selected = a.selected || []
      s.customText = a.custom_text || ''
      s.ownOpen = Boolean(a.custom_text)
    }
    // 记下进来时的年龄班。之后跟它比，才知道老师是不是真的换了班
    appliedAge.value = data.age_group || readAgeLabel()
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
  chains[qid] = (chains[qid] || Promise.resolve()).then(task, task)
  return chains[qid]
}

function pick(q, key) {
  const s = answers[q.id]
  if (!s) return
  if (q.multi) {
    const i = s.selected.indexOf(key)
    if (i >= 0) s.selected.splice(i, 1)
    else s.selected.push(key)
  } else {
    // 单选点已选中的那项 = 取消，她改主意很正常
    s.selected = s.selected[0] === key ? [] : [key]
  }
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

async function submit(q) {
  const s = answers[q.id]
  if (!s) return

  await enqueue(q.id, async () => {
    try {
      const res = await answerQuestion(conversationId.value, {
        questionId: q.id,
        selected: [...s.selected],
        customText: s.customText.trim() || null,
      })
      Object.assign(progress, res.progress || {})
      s.ack = res.ack || ''
    } catch (err) {
      showApiError(err)
    }
  })

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

async function reloadRecommendations(ageGroup) {
  try {
    const data = await refetchQuestions(conversationId.value, ageGroup)
    // 按 id 原地替换，已填的答案一个都不动
    const byId = Object.fromEntries((data.questions || []).map((x) => [x.id, x]))
    questions.value = questions.value.map((q) => (byId[q.id] && q.key !== 'age_group' ? byId[q.id] : q))
    seedAnswers(questions.value)
    toast(`推荐答案换成${ageGroup}的了`)
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
    await startGenerate(conversationId.value)
    redirectTo('generating', { id: conversationId.value })
  } catch (err) {
    showApiError(err)
  } finally {
    generating.value = false
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
  font-size: $fs-tag;
  color: $ink-3;
  letter-spacing: 0.02em;
}

.prog__n {
  color: $amber-deep;
  font-weight: 700;
}

.prog__hint {
  font-size: $fs-sub;
  color: $ink-3;
}

/* ============ 题块 ============ */
.lead {
  display: block;
  font-size: $fs-sub;
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
  width: 42rpx;
  height: 42rpx;
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

.qb__n-t {
  font-size: 22rpx;
  font-weight: 700;
  color: $ink-3;
}

.qb__n-check {
  width: 26rpx;
  height: 26rpx;
}

.qb__t {
  flex: 1;
  font-size: $fs-card;
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: -0.01em;
  color: $ink;
}

/* 必答用黄底墨字的胶囊，不是只把字变个色 —— 颜色不做状态的唯一载体 */
.qb__must {
  font-size: 22rpx;
  font-weight: 700;
  color: $ink;
  background: $amber;
  border-radius: $r-chip;
  padding: 2rpx 14rpx;
  margin-left: 12rpx;
}

.qb__hint {
  display: block;
  font-size: $fs-tag;
  color: $ink-3;
  line-height: 1.6;
  margin: 0 0 20rpx 60rpx;
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
  font-size: 30rpx;
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
  font-size: $fs-tag;
  color: $ink-2;
  line-height: 1.65;
}

/* ============ 四态 ============ */
.err {
  display: block;
  font-size: $fs-body;
  color: $ink-2;
  line-height: 1.7;
  margin: 60rpx 0 32rpx;
}

.sk-block {
  margin-bottom: 44rpx;
}

.sk {
  background: $paper-2;
  border-radius: $r-sm;
  margin-bottom: 18rpx;

  &--title {
    height: 40rpx;
    width: 70%;
  }

  &--opt {
    height: 96rpx;
    border-radius: $r-btn;
  }
}
</style>
