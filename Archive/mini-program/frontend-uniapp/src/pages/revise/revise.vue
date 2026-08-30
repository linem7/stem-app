<template>
  <s-page :dock="loaded">
    <template #top>
      <s-topbar :title="stage === 'answer' ? '再问三个问题' : '改一改'" />

      <view v-if="stage === 'answer'" class="prog">
        <view class="prog__left">
          <view class="prog__bars">
            <view
              v-for="q in questions"
              :key="`bar-${q.id}`"
              class="prog__bar"
              :class="{ 'prog__bar--done': isAnswered(q.id) }"
            />
          </view>
          <text class="prog__lb">答了 <text class="prog__n">{{ answeredCount }}</text>/{{ questions.length }} 题</text>
        </view>
        <text class="prog__hint">答完直接重写</text>
      </view>
    </template>

    <!-- 加载中 -->
    <template v-if="!loaded && !loadError">
      <s-skel kind="title" />
      <s-skel kind="para" />
      <s-skel kind="para" w="55%" />
    </template>

    <s-state
      v-else-if="loadError"
      :kind="stateKind(loadError)"
      :text="loadError.message"
      action-label="重试"
      @action="load"
    />

    <!-- ============ 第一段：说哪里不对 ============ -->
    <template v-else-if="stage === 'ask'">
      <text v-if="planTitle" class="kicker">《{{ planTitle }}》</text>
      <text class="q">哪里不对？说给我听</text>

      <textarea
        :value="feedback"
        class="fb"
        placeholder="例：我们班只有 12 个孩子，只有一个水盆，分组轮流会等太久"
        placeholder-class="fb__ph"
        :maxlength="300"
        :auto-height="true"
        @input="onFeedbackInput"
      />
      <!-- 只在快到上限时才出现。300 字是后端的硬限制，撞上了会被打回来 -->
      <text v-if="feedback.length > 240" class="fb__count">{{ feedback.length }}/300</text>

      <view class="seeds">
        <text class="seeds__lb">常见</text>
        <view
          v-for="s in SEEDS"
          :key="s"
          class="seed"
          @tap="addSeed(s)"
        >
          <text class="seed__t">{{ s }}</text>
        </view>
      </view>
    </template>

    <!-- ============ 第二段：答三道追问 ============ -->
    <template v-else>
      <view class="said">
        <text class="said__lb">你说的</text>
        <text class="said__t">{{ feedback }}</text>
      </view>

      <view v-if="ack" class="ack"><text class="ack__t">{{ ack }}</text></view>

      <!-- 用 <view v-for> 而不是 <template v-for>：后者编译成 <block wx:key>，微信会拒 -->
      <view v-for="(q, qi) in questions" :key="q.id" class="qb" :class="{ 'qb--done': isAnswered(q.id) }">
        <view class="qb__h">
          <view class="qb__n" :class="{ 'qb__n--done': isAnswered(q.id) }">
            <image v-if="isAnswered(q.id)" class="qb__n-check" :src="checkMint" mode="widthFix" />
            <text v-else class="qb__n-t">{{ String(qi + 1).padStart(2, '0') }}</text>
          </view>
          <text class="qb__t">{{ q.title }}</text>
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
      </view>
    </template>

    <template #dock>
      <template v-if="stage === 'ask'">
        <s-button
          label="就这些，问我三个问题"
          arrow
          :disabled="!feedback.trim()"
          :loading="asking"
          loading-text="正在读你的意见"
          @press="ask"
        />
        <!-- 禁用不能只靠变灰，旁边要说清还差什么 -->
        <text v-if="!feedback.trim()" class="dock__why">先说一句哪里不对</text>
        <s-button v-else label="取消" variant="ghost" @press="cancel" />
      </template>
      <template v-else>
        <s-button
          :label="submitLabel"
          arrow
          :loading="submitting"
          loading-text="正在重写"
          @press="submit"
        />
        <!-- 一道都没答也让她走：这三题是帮模型少猜，不是考卷。后端按「（跳过）」处理。
             全答完了这句就没意义了，撤掉 —— 底下只留一个按钮最干净 -->
        <text v-if="answeredCount < questions.length" class="dock__why">没答的我按原样处理</text>
      </template>
    </template>
  </s-page>
</template>

<script setup>
/**
 * 屏⑤ 改一改。
 *
 * 三段里只实现前两段：说哪里不对 → 答三道追问 → 交上去。
 * 第三段（「改好了，前→后」那屏）**故意不做**：重写完直接落在成稿屏，
 * 版本条上就写着「按你说的改的：『…』」，还带回退。中间再插一屏总结，
 * 是让她为了看一句话多点一下（这跟首次生成完直接跳成稿是同一个决定）。
 *
 * 改稿为什么要再问三个问题、而不是拿她那句话直接重写：
 * 「孩子人数写多了」信息量不够 —— 是分组要改、材料要减，还是拆成两次活动？
 * 模型猜错了她还得再改一轮。问三个能点选的具体问题比猜快。
 */
import { computed, reactive, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { getConversation } from '../../api/conversations.js'
import { getLessonPlan, startRevise, submitReviseAnswers } from '../../api/lessonPlans.js'
import { iconCheck } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { back, redirectTo } from '../../utils/nav.js'
import { showApiError, stateKind } from '../../utils/ui.js'

const checkMint = iconCheck(COLORS.mintDeep, 2.4)

/**
 * 快捷说法。点一下往输入框里**追加**，不是替换 ——
 * 她的意见常常是两三件事凑一起（「人数对不上，而且材料没有」），
 * 替换式的填空等于让她重打一遍。
 * 这里只给短语，不替她编整句：编出来的句子多半不是她班上的实情。
 */
const SEEDS = ['孩子人数对不上', '材料我们没有', '时间不够用', '太难了', '太简单了']

const planId = ref(0)
const conversationId = ref(0)
const planTitle = ref('')
const loaded = ref(false)
const loadError = ref(null)

/** 'ask' 说哪里不对 | 'answer' 答三道追问 */
const stage = ref('ask')
const feedback = ref('')
const ack = ref('')
const round = ref(0)
const questions = ref([])
const asking = ref(false)
const submitting = ref(false)
const focusedQ = ref('')

/** { [questionId]: { selected, customText, ownOpen } } */
const answers = reactive({})

const EMPTY_ANSWER = Object.freeze({ selected: [], customText: '', ownOpen: false })

/**
 * 读某题的答题状态。
 * **只读，不许在这里补建条目** —— 模板里到处在调它，渲染期间往 reactive 上写会转成死循环。
 * 条目统一在拿到 questions 时一次建好。
 */
function state(qid) {
  return answers[qid] || EMPTY_ANSWER
}

function seedAnswers(list) {
  for (const q of list) if (!answers[q.id]) answers[q.id] = { selected: [], customText: '', ownOpen: false }
}

const isPicked = (qid, key) => state(qid).selected.includes(key)
const isAnswered = (qid) => state(qid).selected.length > 0 || Boolean(state(qid).customText.trim())
const answeredCount = computed(() => questions.value.filter((q) => isAnswered(q.id)).length)

/** 「我自己说」排在最后一个选项后面，字母顺着排下去 */
const customKey = (q) => String.fromCharCode(65 + (q.options?.length || 0))

const submitLabel = computed(() => {
  const left = questions.value.length - answeredCount.value
  return left > 0 ? `重写吧（${left} 题没答也行）` : '答完了 · 重新生成'
})

onLoad((query) => {
  planId.value = Number(query?.id || 0)
  conversationId.value = Number(query?.conversation_id || 0)
  load()
})

async function load() {
  loadError.value = null
  try {
    const plan = await getLessonPlan(planId.value)
    planTitle.value = plan.title || ''
    if (!conversationId.value) conversationId.value = plan.conversation_id || 0

    // 接着上次没答完的那一轮。
    // 她说完意见、题目已经生成出来了，然后被叫走 —— 回来要是从头再来一遍，
    // 等于白花一次模型调用（第三轮起还要扣一次额度），题目还可能换成另外三道。
    // 会话里存着这一轮的 feedback 和 questions，answers 为空就是没答完。
    if (conversationId.value) {
      try {
        const conv = await getConversation(conversationId.value)
        const list = conv.collected?.revisions || []
        const pending = list[list.length - 1]
        if (pending && !pending.answers && (pending.questions || []).length) {
          round.value = pending.round
          feedback.value = pending.feedback || ''
          questions.value = pending.questions
          seedAnswers(questions.value)
          stage.value = 'answer'
        }
      } catch (err) {
        // 续答只是个便利。拉不到就当新的一轮，别把她挡在门外
      }
    }
    loaded.value = true
  } catch (err) {
    loadError.value = err
  }
}

/* ============ 第一段 ============ */

function onFeedbackInput(e) {
  feedback.value = e.detail.value
}

function addSeed(text) {
  const now = feedback.value.trim()
  if (now.includes(text)) return
  feedback.value = now ? `${now}，${text}` : text
}

function cancel() {
  back()
}

async function ask() {
  const text = feedback.value.trim()
  if (asking.value || !text) return
  asking.value = true
  try {
    const res = await startRevise(planId.value, text)
    round.value = res.revise_round
    ack.value = res.ack || ''
    questions.value = res.questions || []
    seedAnswers(questions.value)
    stage.value = 'answer'
  } catch (err) {
    // 额度不够、正在生成中、内容被拦，文案都由后端给
    showApiError(err)
  } finally {
    asking.value = false
  }
}

/* ============ 第二段 ============ */

function pick(q, key) {
  const s = answers[q.id]
  if (!s) return
  if (q.multi) {
    const i = s.selected.indexOf(key)
    if (i >= 0) s.selected.splice(i, 1)
    else s.selected.push(key)
  } else {
    // 单选点已选中的那项 = 取消。这三题都不是必答，取消到空是允许的
    s.selected = s.selected[0] === key ? [] : [key]
  }
}

function openOwn(q) {
  if (!answers[q.id]) return
  answers[q.id].ownOpen = true
  focusedQ.value = q.id
}

// 不用 v-model：它会编译成往 state(q.id) 的返回值上赋值，没建条目时那是冻结对象，直接抛
function onOwnInput(q, e) {
  if (!answers[q.id]) return
  answers[q.id].customText = e.detail.value
}

/**
 * 交上去，重新生成。
 *
 * 这三题**一次性提交**（后端只有 revise/answer 一个入口，没有单题落库那种接口），
 * 所以跟引导那屏「每答一题即落库」不一样 —— 中途被叫走，这一轮的答案是会丢的，
 * 但题目本身在后端存着，回来接着答（见 load 里的续答）。
 * 要做到单题不丢得先改 api-spec 加接口，值不值得留给后面判断。
 */
async function submit() {
  if (submitting.value) return
  submitting.value = true
  try {
    const payload = questions.value.map((q) => {
      const s = state(q.id)
      return {
        question_id: q.id,
        selected: [...s.selected],
        custom_text: s.customText.trim() || null,
      }
    })
    await submitReviseAnswers(planId.value, round.value, payload)
    // 重写走的是跟首次生成同一条异步链路，所以还是那一屏轮询。
    // revise=1 只改文案（「正在改」而不是「正在写」），流程完全一样。
    redirectTo('generating', { id: conversationId.value, revise: 1 })
    // 这里**不要**在 finally 里解锁：跳转是异步的，解锁后她手快再点一下，
    // 会在正在离开的页面上再提交一次
  } catch (err) {
    submitting.value = false
    showApiError(err)
  }
}
</script>

<style lang="scss" scoped>
/* ============ 第一段 ============ */
.kicker {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  font-weight: 600;
  letter-spacing: 0.02em;
  margin-top: 24rpx;
}

.q {
  display: block;
  font-size: var(--fs-question);
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
  line-height: 1.45;
  margin: 10rpx 0 28rpx;
}

.fb {
  width: 100%;
  border: 2rpx solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 26rpx 26rpx;
  font-size: var(--fs-body);
  line-height: 1.6;
  color: $ink;
  min-height: 200rpx;
}

.fb__ph {
  color: $ink-3;
}

.fb__count {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  text-align: right;
  margin-top: 8rpx;
}

.seeds {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 28rpx;
}

.seeds__lb {
  font-size: var(--fs-tag);
  color: $ink-3;
  margin: 0 16rpx 12rpx 0;
}

.seed {
  border: 2rpx solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 10rpx 22rpx;
  margin: 0 12rpx 12rpx 0;
}

.seed__t {
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.5;
}

/* ============ 第二段 ============ */
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

/* 她那句话要一直摆在眼前：底下三道题是从这句话来的 */
.said {
  background: $paper-2;
  border: 2rpx solid $rule-2;
  border-radius: 28rpx;
  padding: 20rpx 24rpx;
  margin: 20rpx 0 14rpx;
}

.said__lb {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  margin-bottom: 6rpx;
}

.said__t {
  display: block;
  font-size: var(--fs-read);
  color: $ink;
  line-height: 1.65;
}

.ack {
  background: $mint-soft;
  border-radius: 20rpx;
  padding: 16rpx 22rpx;
  margin-bottom: 32rpx;
}

.ack__t {
  font-size: var(--fs-tag);
  color: $ink-2;
  line-height: 1.65;
}

/* ============ 题块（跟引导那屏一套） ============ */
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
