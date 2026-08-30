<template>
  <!-- 🔴 dock 要显式传。s-page 不靠 useSlots() 判断有没有插槽 ——
       页面还在加载骨架时底下挂一条空白横条，看起来像按钮没加载出来 -->
  <s-page :dock="loaded && !loadError">
    <template #top>
      <s-topbar :title="headline" />
    </template>

    <!-- 加载中 -->
    <template v-if="!loaded && !loadError">
      <s-skel kind="line" w="55%" />
      <s-skel kind="title" />
      <s-skel kind="opt" />
      <s-skel kind="opt" />
    </template>

    <s-state
      v-else-if="loadError"
      :kind="stateKind(loadError)"
      :text="loadError.message"
      action-label="重试"
      @action="load"
    />

    <template v-else>
      <!-- ① 她说的那一句 -->
      <div class="me"><span class="me__t">{{ seedInput || '（没写想法）' }}</span></div>

      <!-- ② 引导 4 题。生成过之后收成一句摘要 —— 一份教案里她要找的是流程，
           不是回头看自己答过什么，四张卡片常驻会把流撑得很长 -->
      <template v-if="!plan">
        <span class="lead">{{ leadText }}</span>
        <s-quiz
          :questions="questions"
          :answers="answers"
          @pick="pick"
          @own-open="openOwn"
          @own-input="onOwnInput"
          @own-blur="onOwnBlur"
          @retry="pushAnswer"
        />
      </template>
      <!-- 🔴 `v-if="recap.length"` 不能省：**重新打开一份已完成的教案时，
           后端不再回那 4 道题**，摘要就是空的 —— 只留一个「你答的」标签底下什么都没有，
           看起来像加载失败。空了就整块不出现。 -->
      <div v-else-if="recap.length" class="recap">
        <span class="recap__lb">你答的</span>
        <span v-for="r in recap" :key="r.q" class="recap__r">{{ r.q }}：{{ r.a }}</span>
      </div>

      <!-- ③ 每一版。当前那一版画成完整的 container，其余只占一行 -->
      <template v-for="v in versionRows" :key="v.version">
        <div v-if="v.note" class="me"><span class="me__t">{{ v.note }}</span></div>

        <s-plan
          v-if="v.version === currentVersion && plan"
          ref="planEl"
          :plan="plan"
          :current-version="currentVersion"
          @reload="loadPlan"
        />
        <button v-else type="button" class="old" @click="doRollback(v.version)">
          <span class="old__t">第 {{ v.version }} 版</span>
          <span class="old__go">看这一版</span>
        </button>
      </template>

      <!-- ④ 正在写。写完这一块消失，上面那个 container 出现 -->
      <div v-if="writing" class="write">
        <div v-for="(s, i) in steps" :key="s" class="step" :class="stepClass(i)">
          <span class="step__ic" :class="stepClass(i)">
            <img v-if="stepIndex > i" class="step__check" :src="checkWhite" alt="" />
          </span>
          <span class="step__t">{{ s }}</span>
        </div>
        <div ref="liveEl" class="live">
          <span class="live__t">{{ shown || '正在想怎么写…' }}</span>
        </div>
      </div>

      <div v-if="genFail" class="gfail" :class="{ 'gfail--net': failKind === 'net' }">
        <span class="gfail__t" :class="{ 'gfail__t--net': failKind === 'net' }">{{ failMessage }}</span>
        <span v-if="failKind === 'net' && !net.online" class="gfail__live">还是没有网络</span>
        <s-button
          :label="failKind === 'net' ? '接着等' : '再试一次'"
          :variant="failKind === 'net' ? 'plain' : 'primary'"
          :loading="restarting"
          loading-text="正在重试"
          @press="failKind === 'net' ? startPoll() : retryGenerate()"
        />
      </div>

      <!-- ⑤ 改稿：三道追问摊在流的最底下，答完接着往下长 -->
      <template v-if="revise.stage === 'answer'">
        <!-- 她刚说的那句要摆出来。不摆的话流里只有三道凭空冒出来的题，
             而这三道题正是**针对那句话**问的 -->
        <div class="me"><span class="me__t">{{ revise.feedback }}</span></div>
        <div v-if="revise.ack" class="rvack"><span class="rvack__t">{{ revise.ack }}</span></div>
        <span class="lead">再问你三个，答完直接重写。</span>
        <s-quiz
          :questions="revise.questions"
          :answers="revise.answers"
          @pick="rvPick"
          @own-open="rvOpenOwn"
          @own-input="rvOwnInput"
        />
        <s-button
          :label="rvSubmitLabel"
          arrow
          :loading="revise.submitting"
          loading-text="正在重写"
          @press="rvSubmit"
        />
      </template>
    </template>

    <!-- ⑥ 底部输入框。**一条流只有一个入口** —— 没答完就是「写教案吧」，
         写完了就是「哪里不对」。两件事共用拇指位那一条 -->
    <template v-if="loaded && !loadError" #dock>
      <s-button
        v-if="!plan && !writing"
        :label="dockLabel"
        arrow
        :disabled="requiredLeft > 0"
        :loading="generating"
        loading-text="正在开始"
        @press="generate"
      />
      <span v-if="!plan && !writing && requiredLeft > 0" class="dock__why">上面第一题选一下年龄班就能开始</span>

      <!--
        🔴 **收起来的时候只有一个按钮**（2026-08-31 用户定）。
        输入框 + 五个常见说法常驻的话，手机上这一条要占掉小半屏，
        而她多数时候是在**读教案**，不是在提意见 —— 那半屏是白挡的。
        点了「改一改」再展开。
      -->
      <template v-if="plan && !writing && revise.stage !== 'answer'">
        <s-button
          v-if="!composerOpen"
          label="哪里不对？我来改"
          arrow
          @press="openComposer"
        />
        <template v-else>
          <textarea
            ref="fbEl"
            v-model="revise.feedback"
            class="fb"
            placeholder="哪里不对？说给我听"
            maxlength="300"
            rows="1"
            @input="autogrow($event.target)"
          />
          <div class="fb__ops">
            <div class="seeds">
              <button v-for="s in RV_SEEDS" :key="s" type="button" class="seed" @click="rvAddSeed(s)">
                <span class="seed__t">{{ s }}</span>
              </button>
            </div>
            <s-button
              label="改一改"
              arrow
              :disabled="!revise.feedback.trim()"
              :loading="revise.asking"
              loading-text="正在读你的意见"
              @press="rvAsk"
            />
            <s-button label="取消" variant="ghost" @press="composerOpen = false" />
          </div>
        </template>
      </template>
    </template>
  </s-page>
</template>

<script setup>
/**
 * 一条对话流 —— 引导 + 生成 + 成稿 + 改一改，全在这一页（2026-08-30 用户定）。
 *
 * 小程序时代这是四个页面（guide / generating / plan / revise），跳来跳去；
 * 现在从上往下就是整个过程：她说的那句 → 4 道题 → 正在写 → 教案 → 她提的意见 → 新一版。
 *
 * 【为什么正文归这一页拉，不归 s-plan】
 * 这条流还要用同一份教案数据判断「写完没有」「现在第几版」。
 * s-plan 再拉一次就是两份事实，迟早对不上。
 *
 * 【版本在流里怎么摆】
 * `GET /versions` **只回元数据不回正文**（backend/src/routes/lessonPlans.js），
 * 所以摆不出「两版正文一前一后」。当前那一版画成完整 container，
 * 其余每版占一行，点它就是回退（不新增版本、不删版本、不花额度，可以来回切）。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, useTemplateRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  answerQuestion,
  getConversation,
  pollGenerate,
  refetchQuestions,
  startGenerate,
} from '../../api/conversations.js'
import {
  getLessonPlan,
  getVersions,
  rollback,
  startRevise,
  submitReviseAnswers,
} from '../../api/lessonPlans.js'
import { session } from '../../stores/session.js'
import { net } from '../../stores/net.js'
import { take } from '../../stores/handoff.js'
import { iconCheck } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { alert, showApiError, stateKind, toast } from '../../utils/ui.js'
import { autogrow } from '../../utils/autogrow.js'

const route = useRoute()
const checkWhite = iconCheck(COLORS.white, 2.6)

/** 选中项拼串时的分隔符。选项 key 只有 A–E，不含竖线 */
const SEP = '|'

const convId = ref(0)
const seedInput = ref('')
const title = ref('')
const loaded = ref(false)
const loadError = ref(null)

/* ============ 引导 ============ */
const questions = ref([])
const answers = reactive({})
const progress = reactive({ answered: 0, total: 4 })
const learningLead = ref('')
const appliedAge = ref('')
const generating = ref(false)

/* ============ 教案 ============ */
const plan = ref(null)
const versions = ref([])
const currentVersion = ref(1)

/* ============ 正在写 ============ */
const STEPS = ['读你答的那几题', '设计活动流程', '按年龄班校一遍']
const REVISE_STEPS = ['读你提的意见', '重排活动流程', '按年龄班校一遍']
const PHASE_STEP = { thinking: 0, writing: 1, checking: 2 }

const writing = ref(false)
const isRevise = ref(false)
const stepIndex = ref(0)
const buf = ref('')
const shown = ref('')
const liveEl = ref(null)
const genFail = ref(false)
const failKind = ref('gen')
const failMessage = ref('')
const restarting = ref(false)

const steps = computed(() => (isRevise.value ? REVISE_STEPS : STEPS))
const stepClass = (i) => ({ 'is-done': stepIndex.value > i, 'is-now': stepIndex.value === i })

let handle = null
let reveal = null

/* ============ 改一改 ============ */
const RV_SEEDS = ['孩子人数对不上', '材料我们没有', '时间不够用', '太难了', '太简单了']
const fbEl = ref(null)
/** 底部那个输入框展开了没有。收起来时只有一个「哪里不对？我来改」按钮 */
const composerOpen = ref(false)
const revise = reactive({
  /** 'idle' 等她说 | 'answer' 三道追问摊着 */
  stage: 'idle',
  feedback: '',
  /** 后端读完她那句意见的一句回应 */
  ack: '',
  round: 0,
  questions: [],
  answers: {},
  asking: false,
  submitting: false,
})

/* ============ 派生 ============ */

const headline = computed(() => {
  if (title.value) return title.value
  const s = seedInput.value.replace(/^我想做个/, '').replace(/的?活动$/, '')
  return s ? `${s}的活动` : '说说你的想法'
})

const leadText = computed(() =>
  learningLead.value || `就问这 ${progress.total} 个，其余的我来定，写好了你再改。`
)

/**
 * 还差几道必答题。
 *
 * **不能只信服务端的 progress.required_left** —— 那个值只在 answer 请求成功时才更新。
 * 请求超时时后端其实已经落库了（慢的是它再调一次模型要那句 ack），
 * 界面上已经打了绿勾、按钮却永远是灰的，她只能关掉重进。
 */
const requiredLeft = computed(
  () => questions.value.filter((q) => q.required && !isAnswered(q.id)).length
)

const dockLabel = computed(() => {
  if (requiredLeft.value > 0) return '先选一下年龄班'
  const left = progress.total - progress.answered
  return left > 0 ? `写教案吧（${left} 题没答也行）` : '写教案吧'
})

/** 生成过之后，把她答的收成一句一句的摘要 */
const recap = computed(() =>
  questions.value
    .map((q) => {
      const s = answers[q.id]
      if (!s) return null
      const picked = s.selected
        .map((k) => q.options?.find((o) => o.key === k)?.label)
        .filter(Boolean)
      const text = [...picked, s.customText].filter(Boolean).join('、')
      return text ? { q: q.title.replace(/[？?]$/, ''), a: text } : null
    })
    .filter(Boolean)
)

/** 流里要摆几行版本。没有版本记录时至少摆一行（第 1 版就是当前这份） */
const versionRows = computed(() => {
  if (!plan.value) return []
  if (!versions.value.length) return [{ version: currentVersion.value, note: null }]
  return versions.value.map((v) => ({ version: v.version, note: v.note }))
})

const rvSubmitLabel = computed(() => {
  const n = revise.questions.filter((q) => rvAnswered(q.id)).length
  const left = revise.questions.length - n
  return left > 0 ? `重写吧（${left} 题没答也行）` : '答完了 · 重新生成'
})

/* ============ 装载 ============ */

const blank = () => ({ selected: [], customText: '', savedText: '', ownOpen: false, ack: '', failed: false })
const isAnswered = (qid) => {
  const s = answers[qid]
  return Boolean(s) && (s.selected.length > 0 || Boolean(s.customText))
}

function seedAnswers(list) {
  for (const q of list) if (!answers[q.id]) answers[q.id] = blank()
}

onMounted(() => {
  convId.value = Number(route.query.id || 0)
  load()
})

onUnmounted(() => stopPoll())

async function load() {
  loadError.value = null
  try {
    // 首页开会话时后端已经把 4 道题连同推荐答案一起给过了，直接用，不再多打一趟
    const data = take(`conversation:${convId.value}`) || (await getConversation(convId.value))
    seedInput.value = data.seed_input || ''
    title.value = data.title || ''
    learningLead.value = data.learning_lead || ''
    questions.value = data.questions || []
    seedAnswers(questions.value)
    Object.assign(progress, data.progress || {})
    // 断点续写：把已答的原样还原回去
    for (const [qid, a] of Object.entries(data.answers || {})) {
      if (!answers[qid]) answers[qid] = blank()
      const s = answers[qid]
      s.selected = a.selected || []
      s.customText = a.custom_text || ''
      s.savedText = s.customText
      s.ownOpen = Boolean(a.custom_text)
    }
    appliedAge.value = data.age_group || session.teacher?.age_group || ''

    // 已经生成过就把教案接上；还在生成中就接着轮询（她刷新过、或者被叫走一趟回来）
    if (data.lesson_plan_id) {
      await loadPlan(data.lesson_plan_id)
    } else if (data.status === 'generating') {
      startPoll()
    }

    // 上一轮改稿的题目还没答完就接着答 —— 从头再来一遍等于白花一次模型调用
    const pending = (data.collected?.revisions || []).slice(-1)[0]
    if (pending && !pending.answers && (pending.questions || []).length) {
      revise.round = pending.round
      revise.feedback = pending.feedback || ''
      revise.questions = pending.questions
      for (const q of revise.questions) revise.answers[q.id] = blank()
      revise.stage = 'answer'
    }

    loaded.value = true
  } catch (err) {
    loadError.value = err
  }
}

/** 拉教案正文 + 版本列表。画完一张图、回退版本之后也调它 */
async function loadPlan(id) {
  const planId = Number(id) || plan.value?.id
  if (!planId) return
  plan.value = await getLessonPlan(planId)
  currentVersion.value = plan.value.current_version || plan.value.version || 1
  // 版本列表拉失败不该挡着她看教案 —— 大不了流里只有一行
  try {
    const v = await getVersions(planId)
    versions.value = v.versions || []
    currentVersion.value = v.current_version || currentVersion.value
  } catch (e) {
    versions.value = []
  }
}

/* ============ 引导答题 ============ */

// 每选一项就调一次接口（她被叫走进度不丢）。手快连点会并发，
// 同一题按顺序排队，保证最后落库的是最后一次点的那个状态。
const chains = {}
function enqueue(qid, task) {
  const next = (chains[qid] || Promise.resolve()).then(task, task)
  chains[qid] = next
  return next
}

/** 等所有题的落库都跑完。点「写教案吧」之前必须等，否则最后一下选的可能还没到后端 */
const settleAll = () => Promise.all(Object.values(chains))

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

  // 必答题（现在只有年龄班）不能取消到空：后端会 400，而且不选年龄班写出来一定是错的。
  // 所以第二下点在已选中的年龄班上，就当没点
  if (q.required && s.selected.length === 0 && !s.customText.trim()) {
    s.selected = before ? before.split(SEP) : []
    return
  }

  // 选的没变但上次没存上，那就是她在重试
  if (s.selected.join(SEP) === before && !s.failed) return
  submitAnswer(q)
}

function openOwn(q) {
  if (answers[q.id]) answers[q.id].ownOpen = true
}

function onOwnInput(q, text) {
  if (answers[q.id]) answers[q.id].customText = text
}

/** 一个字都没改就别重发 —— 后端每次都要再跑一趟模型要那句 ack，白花钱也白等 */
function onOwnBlur(q) {
  const s = answers[q.id]
  if (!s) return
  if (s.customText.trim() === s.savedText.trim() && !s.failed) return
  submitAnswer(q)
}

/** 只负责把这一题的当前状态推给后端，不管年龄班那套联动 */
function pushAnswer(q) {
  const s = answers[q.id]
  if (!s) return Promise.resolve()
  return enqueue(q.id, async () => {
    const sent = { selected: [...s.selected], customText: s.customText.trim() || null }
    try {
      const res = await answerQuestion(convId.value, {
        questionId: q.id,
        selected: sent.selected,
        customText: sent.customText,
      })
      Object.assign(progress, res.progress || {})
      s.ack = res.ack || ''
      s.savedText = sent.customText || ''
      s.failed = false
    } catch (err) {
      // 不回滚选中态 —— 后端是先落库再调模型要 ack 的，超时的多半是 ack 那一段。
      // 改成明确标一句「没存上，点这里重发」，让界面别再假装成功
      s.failed = true
      s.ack = ''
      showApiError(err)
    }
  })
}

async function submitAnswer(q) {
  await pushAnswer(q)
  // 换了年龄班要重拉推荐答案 —— 推荐项综合了年龄班规则、老师档案和记忆，
  // 只有后端算得出来，前端不许硬编码任何推荐项
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
  const key = answers[q.id]?.selected[0]
  return q.options?.find((o) => o.key === key)?.label || ''
}

/**
 * 换班后重拉推荐答案。
 *
 * 坑在这：**同一个字母换班后指向的是另一个答案**。中班的场地是
 * A=教室区角 / B=走廊 / C=户外空地，换成大班变成 A=教室建构区 / B=室内走廊 /
 * C=户外沙池。把勾原样留在 B 上，她看到的就是她没选过的东西。
 * 所以按**文案**而不是按字母重新对位。
 */
async function reloadRecommendations(ageGroup) {
  try {
    const data = await refetchQuestions(convId.value, ageGroup)
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

    // 有题被清空是要她动手的事，用能停住的弹框；只是换了推荐答案就一句轻提示
    if (dropped) {
      alert(`推荐答案换成${ageGroup}的了。有 ${dropped} 题的选项不一样了，麻烦再选一次。`)
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
    // 先等答题队列落完。她可能刚在「我自己说」里打完字就直接点了生成
    await settleAll()
    await startGenerate(convId.value)
    isRevise.value = false
    buf.value = ''
    shown.value = ''
    startPoll()
  } catch (err) {
    showApiError(err)
  } finally {
    generating.value = false
  }
}

function stopPoll() {
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
 * 每次放的量 = 积压的十二分之一（至少 2 个字）。积压多就放得快，
 * **永远不会越落越远** —— 定速放字的话，模型写得比放得快时，
 * 她会在教案早就写完之后还盯着字往外爬。
 */
function startReveal() {
  if (reveal) return
  reveal = setInterval(() => {
    const gap = buf.value.length - shown.value.length
    if (gap <= 0) return
    shown.value = buf.value.slice(0, shown.value.length + Math.max(2, Math.ceil(gap / 12)))
  }, 40)
}

function startPoll() {
  stopPoll()
  genFail.value = false
  writing.value = true
  stepIndex.value = 0
  startReveal()

  handle = pollGenerate(convId.value, {
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
    .then(async (d) => {
      if (d.status === 'failed') {
        writing.value = false
        genFail.value = true
        failKind.value = 'gen'
        failMessage.value =
          d.message ||
          (isRevise.value ? '这次没改成，再试一次通常就好。' : '这次没写成。换个说法再试一次通常就好。')
        return
      }
      shown.value = buf.value
      if (d.lesson_plan_id) await loadPlan(d.lesson_plan_id)
      // 教案 container 出来了，「正在写」那一块就该消失 —— 同一件事不摆两遍
      writing.value = false
      revise.stage = 'idle'
      revise.feedback = ''
    })
    .catch((err) => {
      writing.value = false
      genFail.value = true
      if (err?.message === 'POLL_TIMEOUT') {
        failKind.value = 'timeout'
        failMessage.value = '等了两分钟还没写完。它多半还在后台写，过一会儿刷新看看。'
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

async function retryGenerate() {
  if (restarting.value) return
  restarting.value = true
  try {
    await startGenerate(convId.value)
    // 重新生成 = 一份全新的教案。旧那半截必须清掉，否则新的接在它后面
    buf.value = ''
    shown.value = ''
    startPoll()
  } catch (err) {
    showApiError(err)
  } finally {
    restarting.value = false
  }
}

/**
 * 网一回来就自己接上。
 * 只在 failKind === 'net' 时成立 —— 别的失败都要她自己决定要不要再花一次。
 */
watch(
  () => net.online,
  (now, before) => {
    if (now && !before && genFail.value && failKind.value === 'net') startPoll()
  }
)

/* 字一多出来就滚到底。跟着 shown 走而不是在放字的定时器里滚：
   DOM 要等这一帧渲染完才有新的 scrollHeight，在定时器里滚永远差一帧。 */
watch(shown, () => {
  nextTick(() => {
    const el = liveEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
})

/**
 * 流底下长出新东西时，把页面滚过去。
 *
 * 🔴 没有它这条流是坏的：改稿的三道追问长在一份两千多字的教案**底下**，
 * 而她还停在教案顶上 —— 屏幕上什么都没变，看起来就是「点了没反应」。
 */
watch([() => revise.stage, writing], ([stage, isWriting], [, wasWriting]) => {
  // 🔴 只在**开始写**和**追问冒出来**时滚到底。
  // `writing` 由 true 变 false 也会触发这个 watcher，而那一刻正是教案 container 出现的时候 ——
  // 不挡住的话它会把页面拽到底，跟下面那个「停在教案开头」的 watcher 打架，
  // 表现是写完之后直接落在教案最后一节上（实测 scrollY 2121，教案顶在视口上方 1947px）。
  if (isWriting && !wasWriting) {
    nextTick(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }))
    return
  }
  if (stage === 'answer') {
    nextTick(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }))
  }
})

/**
 * 教案写完时停在**这份教案的开头**，不是滚到底（2026-08-31 用户定）。
 *
 * 滚到底她落在教案最后一节（安全提示、配图、评价）上，要读得自己往回翻两千多字。
 * 而她这时候唯一想做的事是从头读一遍。
 *
 * 改稿出的新一版同理 —— 所以判据是 `plan.id + 版本号`，
 * 光看 plan.id 的话第二版是同一个 id，滚不动。
 */
const planEl = useTemplateRef('planEl')
watch(
  () => (plan.value ? `${plan.value.id}:${currentVersion.value}` : ''),
  (now) => {
    if (!now) return
    nextTick(() => {
      // ref 写在 v-for 里，Vue 给的是**数组**。只有当前那一版会渲染，所以取第一个
      const hit = Array.isArray(planEl.value) ? planEl.value[0] : planEl.value
      const el = hit?.$el || hit
      if (!el || !el.getBoundingClientRect) return
      // 减掉顶栏那 46px，否则 container 的标题正好被顶栏压住
      const y = window.scrollY + el.getBoundingClientRect().top - 54
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' })
    })
  }
)

/* ============ 版本回退 ============ */

async function doRollback(version) {
  try {
    await rollback(plan.value.id, version)
    await loadPlan(plan.value.id)
    toast(`回到第 ${version} 版了`)
  } catch (err) {
    showApiError(err)
  }
}

/* ============ 改一改 ============ */

const rvAnswered = (qid) => {
  const s = revise.answers[qid]
  return Boolean(s) && (s.selected.length > 0 || Boolean(s.customText.trim()))
}

function openComposer() {
  composerOpen.value = true
  // 展开之后直接能打字，不用她再点一下输入框
  nextTick(() => fbEl.value?.focus())
}

/** 点一下往输入框里**追加**，不是替换 —— 她的意见常常是两三件事凑一起 */
function rvAddSeed(text) {
  const now = revise.feedback.trim()
  if (now.includes(text)) return
  revise.feedback = now ? `${now}，${text}` : text
  nextTick(() => autogrow(fbEl.value))
}

/**
 * 改稿为什么要再问三个问题、而不是拿她那句话直接重写：
 * 「孩子人数写多了」信息量不够 —— 是分组要改、材料要减，还是拆成两次活动？
 * 模型猜错了她还得再改一轮。问三个能点选的具体问题比猜快。
 */
async function rvAsk() {
  const text = revise.feedback.trim()
  if (revise.asking || !text) return
  revise.asking = true
  try {
    const res = await startRevise(plan.value.id, text)
    revise.round = res.revise_round
    revise.questions = res.questions || []
    revise.answers = {}
    for (const q of revise.questions) revise.answers[q.id] = blank()
    revise.ack = res.ack || ''
    revise.stage = 'answer'
  } catch (err) {
    // 额度不够、正在生成中、内容被拦，文案都由后端给
    showApiError(err)
  } finally {
    revise.asking = false
  }
}

function rvPick(q, key) {
  const s = revise.answers[q.id]
  if (!s) return
  if (q.multi) {
    const i = s.selected.indexOf(key)
    if (i >= 0) s.selected.splice(i, 1)
    else s.selected.push(key)
  } else {
    // 这三题都不是必答，取消到空是允许的
    s.selected = s.selected[0] === key ? [] : [key]
  }
}

function rvOpenOwn(q) {
  if (revise.answers[q.id]) revise.answers[q.id].ownOpen = true
}

function rvOwnInput(q, text) {
  if (revise.answers[q.id]) revise.answers[q.id].customText = text
}

/**
 * 交上去，重新生成。
 *
 * 这三题**一次性提交**（后端只有 revise/answer 一个入口，没有单题落库那种接口），
 * 所以跟引导那几题「每答一题即落库」不一样 —— 中途被叫走这一轮的答案会丢，
 * 但题目本身在后端存着，回来接着答（见 load 里那段）。
 */
async function rvSubmit() {
  if (revise.submitting) return
  revise.submitting = true
  try {
    const payload = revise.questions.map((q) => {
      const s = revise.answers[q.id]
      return {
        question_id: q.id,
        selected: [...s.selected],
        custom_text: s.customText.trim() || null,
      }
    })
    await submitReviseAnswers(plan.value.id, revise.round, payload)
    revise.stage = 'idle'
    revise.questions = []
    isRevise.value = true
    buf.value = ''
    shown.value = ''
    startPoll()
  } catch (err) {
    showApiError(err)
  } finally {
    revise.submitting = false
  }
}
</script>

<style lang="scss" scoped>
/* ============ 她说的那一句 ============ */
/*
  用户那一侧的气泡靠右、有底色；AI 那一侧不画气泡（正文本来就是它说的）。
  只给一侧画框，两边才分得开 —— 两边都画就变成一堆卡片，读不出谁在说话。
*/
.me {
  display: flex;
  justify-content: flex-end;
  margin: $sp-4 0 $sp-3;
}

.me__t {
  max-width: 85%;
  background: $amber-soft;
  border: 1px solid $amber-line;
  border-radius: $r-btn;
  padding: 9px 12px;
  font-size: var(--fs-body);
  line-height: 1.55;
  color: $ink;
  white-space: pre-wrap;
}

.lead {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  line-height: 1.6;
  margin: 4px 0 18px;
}

/* ============ 答题摘要 ============ */
.recap {
  border-left: 3px solid $rule-2;
  padding-left: 11px;
  margin-bottom: $sp-4;
}

.recap__lb {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  font-weight: 600;
  margin-bottom: 3px;
}

.recap__r {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.7;
}

.rvack {
  background: $sky-soft;
  border-radius: 10px;
  padding: 9px 11px;
  margin: $sp-3 0 $sp-2;
}

.rvack__t {
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.7;
}

/* ============ 旧版本那一行 ============ */
.old {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  border: 1px solid $sky-line;
  border-radius: $r-btn;
  background: $sky-soft;
  padding: 10px 12px;
  margin: $sp-3 0;
}

.old__t {
  font-size: var(--fs-sub);
  font-weight: 600;
  color: $sky-deep;
}

.old__go {
  font-size: var(--fs-tag);
  color: $sky-deep;
}

/* ============ 正在写 ============ */
.write {
  margin: $sp-3 0;
}

.step {
  display: flex;
  align-items: center;
  padding: 5px 0;
}

.step__ic {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: $r-chip;
  border: 1.5px solid $rule-2;
  margin-right: 10px;
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
  width: 11px;
  height: 11px;
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
   不定高的话整条流会被撑得没边，底下的输入框被推走 */
.live {
  height: 260px;
  overflow-y: auto;
  background: $paper-2;
  border-radius: 10px;
  padding: 10px 12px;
  margin-top: 10px;
}

.live__t {
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.75;
  white-space: pre-wrap;
}

/* ============ 生成失败 ============ */
.gfail {
  background: $paper-2;
  border: 1px solid $coral;
  border-radius: 10px;
  padding: 12px;
  margin: $sp-3 0;
}

.gfail--net {
  background: $sky-soft;
  border-color: $sky-line;
}

.gfail__t {
  display: block;
  font-size: var(--fs-sub);
  color: $coral-deep;
  line-height: 1.7;
  margin-bottom: 10px;

  /* 断网不是事故，别画成红的 —— 中性提示用天空蓝（design-tokens 规则 4） */
  &--net {
    color: $sky-deep;
  }
}

.gfail__live {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  margin: -6px 0 8px;
}

/* ============ 底部 ============ */
.dock__why {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  text-align: center;
  margin-top: 6px;
}

.fb {
  display: block;
  width: 100%;
  outline: none;
  resize: none;
  border: 1px solid $rule-2;
  border-radius: $r-input;
  background: $white;
  padding: 10px 13px;
  font-size: var(--fs-body);
  line-height: 1.55;
  color: $ink;
  min-height: 40px;
  max-height: 120px;
  overflow-y: auto;
}

.fb::placeholder {
  color: $ink-3;
}

.fb__ops {
  margin-top: 7px;
}

.seeds {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 7px;
}

.seed {
  border: 1px solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 3px 10px;
  margin: 0 5px 4px 0;
}

.seed__t {
  font-size: var(--fs-tag);
  color: $ink-2;
  line-height: 1.5;
}
</style>
