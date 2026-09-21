<template>
  <!--
    center：内容纵向居中。顶上那幅风景插画撤掉之后（2026-08-20 用户定），
    这一屏只剩「一句问题 + 一个输入框 + 一个按钮」，靠上排会在下面留一大片空白，
    看着像没加载完。居中之后输入框正好落在拇指位。
  -->
  <s-page center>
    <!-- 首页的顶栏只有一个汉堡键，没有标题 —— 它是抽屉在这一页的唯一入口。
         漏掉它，窄屏上从首页就进不了教案库 -->
    <template #top>
      <s-topbar />
    </template>

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
      -->
      <button v-if="unreadTasks > 0" type="button" class="banner" @click="goTasks">
        <span class="banner__t">有 {{ unreadTasks }} 件可以换额度的事</span>
        <span class="banner__b">去看看 ›</span>
      </button>

      <!--
        完善信息的提醒。**她填完就永久消失**（判据是后端那个 reason='完善信息'
        的发放记录，不是本地状态 —— 换设备打开也不该再冒出来）。

        ⚠️ 跟上面那条任务条**是两个不同的来源**，所以两条可能同时在。
        这不冲突：一条是「去做事换额度」，一条是「填档案换额度」。
      -->
      <button
        v-if="needProfile"
        type="button"
        class="banner"
        @click="profileSheet = true"
      >
        <span class="banner__t">完善信息，领 {{ PROFILE_REWARD.text }} 次教案额度</span>
        <span class="banner__b">去填 ›</span>
      </button>

      <span class="kicker">开始新教案</span>
      <h1 class="q">{{ greeting }}<span class="q__br">今天想做个什么活动？</span></h1>

      <!--
        模式切换。摆在输入框正上方 —— 她要在打字之前就看到自己是哪个模式，
        打完 200 字才发现选错了会很恼火。
        胶囊上**只有模式名，没有副标题**：解释放在点开的抽屉里
        （见 stores/prefs.js 里 MODES 那段注释说的例外）。
      -->
      <button type="button" class="mode" @click="openModeSheet">
        <span class="mode__t">{{ modeName }}</span>
        <span class="mode__c">⌄</span>
      </button>

      <div class="ask">
        <textarea
          ref="seedEl"
          v-model="seed"
          class="ask__ta"
          placeholder="例：我想做个浮与沉的活动"
          maxlength="200"
          rows="2"
          @input="autogrow($event.target)"
        />
        <div class="ask__seeds">
          <span class="ask__seeds-lb">试试</span>
          <button v-for="s in SEEDS" :key="s" type="button" class="chip" @click="pickSeed(s)">
            <span class="chip__t">{{ s }}</span>
          </button>
        </div>
      </div>

      <div class="act">
        <s-button
          label="开始"
          arrow
          :disabled="!seed.trim()"
          :loading="starting"
          loading-text="正在准备问题"
          @press="start"
        />
      </div>

      <span class="foot">{{ footText }}</span>
    </template>

    <!--
      模式选择抽屉。整行可点 = 整行是那个选择，跟「我的」里记忆那一行同一个形状。
      选完立刻关掉，不用再点一次「确定」—— 点了哪一行就是选了哪一行。
    -->
    <s-sheet :visible="modeSheet" title="怎么写这一份" @close="modeSheet = false">
      <button
        v-for="m in MODES"
        :key="m.key"
        type="button"
        class="mrow"
        :class="{ 'mrow--on': prefs.mode === m.key }"
        @click="pickMode(m.key)"
      >
        <span class="mrow__b">
          <span class="mrow__t">{{ m.label }}</span>
          <span class="mrow__d">{{ m.desc }}</span>
        </span>
        <img v-if="prefs.mode === m.key" class="mrow__ck" :src="checkInk" alt="已选" />
      </button>
    </s-sheet>

    <!--
      完善信息那个表单。四项，都要选/填了才提交 ——
      后端每一条都会报中文，但这里**先让按钮灰着**，
      因为四项都是必填，没有「填一部分也能过」的情况。
    -->
    <s-sheet :visible="profileSheet" title="完善信息" @close="profileSheet = false">
      <label class="f">
        <span class="f__k">出生年份</span>
        <input
          v-model="form.birthYear"
          class="f__in"
          type="tel"
          inputmode="numeric"
          maxlength="4"
          placeholder="比如 1995"
        />
      </label>

      <label class="f">
        <span class="f__k">最高学历</span>
        <select v-model="form.education" class="f__in">
          <option :value="null">选一个</option>
          <option v-for="e in EDUCATIONS" :key="e" :value="e">{{ e }}</option>
        </select>
      </label>

      <label class="f">
        <span class="f__k">教龄</span>
        <!-- 0 是有意义的值（刚入职），所以这个框允许它 -->
        <input
          v-model="form.teachingYears"
          class="f__in"
          type="tel"
          inputmode="numeric"
          maxlength="2"
          placeholder="几年"
        />
      </label>

      <label class="f">
        <span class="f__k">当前任教年级</span>
        <select v-model="form.ageGroup" class="f__in">
          <option :value="null">选一个</option>
          <option v-for="a in AGE_GROUPS" :key="a" :value="a">{{ a }}</option>
        </select>
      </label>

      <s-button
        label="填好了，领额度"
        arrow
        :disabled="!canSubmitProfile"
        :loading="profileSaving"
        @press="submitProfile"
      />
    </s-sheet>
  </s-page>
</template>

<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { ensureSession, gate, session } from '../../stores/session.js'
import { put } from '../../stores/handoff.js'
import { createConversation } from '../../api/conversations.js'
import { listTasks } from '../../api/tasks.js'
import { getQuota, saveProfile } from '../../api/me.js'
import { MODES, modeLabel, prefs, setMode } from '../../stores/prefs.js'
import { iconCheck } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { push, replace } from '../../utils/nav.js'
import { showApiError, stateKind, toast } from '../../utils/ui.js'
import { autogrow } from '../../utils/autogrow.js'

const checkInk = iconCheck(COLORS.ink, 2.6)

// 前三个是已经真跑过的主题（小班/中班/大班各一），第四个说明其余主题一样能走
const SEEDS = ['浮与沉', '影子', '搭高塔', '磁铁']

/* 完善信息那两项白名单。**跟后端同源**（services/roster.js 的
   EDUCATIONS / AGE_GROUPS）—— 后端也会校验，这里只是让下拉有东西可选。
   ⚠️ 改后端那两处记得同步这里，`test:api` 不查它们。 */
const EDUCATIONS = ['中专及以下', '大专', '本科', '硕士及以上']
const AGE_GROUPS = ['小班', '中班', '大班']
/** 跟后端 me.js 里那两个常量同源 —— 文案上要一致，别一边 10 一边 15 */
const PROFILE_REWARD = { text: 10, image: 5 }

const seed = ref('')
const seedEl = ref(null)
const starting = ref(false)
/** 未读任务数。为 0 时那条条带整个不出现 */
const unreadTasks = ref(0)

/* ---- 完善信息领额度 ---- */

/**
 * 还该不该给她看那条提醒。
 *
 * 🔴 **判据只有一个：后端给没给过那笔额度。**
 * 具体做法是从 `GET /me/quota` 的 `grants` 里找 `reason === '完善信息'`。
 *
 * ⚠️ **不许改判「四个字段填全了没有」** —— 她填完之后再从「我的」里把学历
 * 改一下，那个条件仍然成立，提醒就会**再冒出来一次**，而第二次点进去
 * 后端不会发额度（它认台账）。表现就是「点了没反应」，她会以为是坏的。
 *
 * `profileChecked` 是「这一次启动查过没有」，防止接口还没回来就画提醒 ——
 * 否则每个老师进首页都会先闪一下那条不该出现的条。
 */
const profileSheet = ref(false)
const profileChecked = ref(false)
const profileGranted = ref(false)
const profileSaving = ref(false)
const form = ref({ birthYear: '', education: null, teachingYears: '', ageGroup: null })

const needProfile = computed(() => (
  session.ready && profileChecked.value && !profileGranted.value
))

const canSubmitProfile = computed(() => {
  const y = Number(form.value.birthYear)
  const t = Number(form.value.teachingYears)
  return Number.isInteger(y) && y > 1900
    && form.value.education !== null
    /* ⚠️ `teachingYears` 空字符串不能过，但 `'0'` 要过 ——
       0 是刚入职的真实值。所以判的是「填了没有」而不是「是不是 0」 */
    && form.value.teachingYears !== '' && Number.isInteger(t) && t >= 0
    && form.value.ageGroup !== null
})

/**
 * 查有没有领过。**故意不 await、失败也不弹错** —— 跟任务那条同一个立场：
 * 首页的正事是那个输入框，为了一条提醒让首页停在加载态是把主次弄反了。
 * 查不到就不画那条提醒（fail-closed：宁可不提，不要提一条点了没反应的）。
 */
function refreshProfile() {
  getQuota()
    .then((d) => {
      profileGranted.value = (d.grants || []).some((g) => g.reason === '完善信息')
    })
    .catch(() => { profileGranted.value = true })
    .finally(() => { profileChecked.value = true })
}

async function submitProfile() {
  if (profileSaving.value || !canSubmitProfile.value) return
  profileSaving.value = true
  try {
    const d = await saveProfile({
      birthYear: Number(form.value.birthYear),
      education: form.value.education,
      teachingYears: Number(form.value.teachingYears),
      ageGroup: form.value.ageGroup,
    })
    profileSheet.value = false
    profileGranted.value = true
    /* 后端在已经领过时**不回 granted**（只改档案，不报错）——
       那不是失败，所以文案要跟着分。 */
    if (d.granted) {
      toast(`领到了 ${d.granted.text} 次教案、${d.granted.image} 次配图`)
    } else {
      toast('档案已更新')
    }
  } catch (err) {
    showApiError(err)
  } finally {
    profileSaving.value = false
  }
}

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

// 这里的 nickname 不是问卷里那个真实姓名 ——
// 真实姓名和手机号永不下发前端，接口里根本没有那两个字段
const greeting = computed(() => (session.teacher?.nickname ? `${session.teacher.nickname}，` : ''))

onMounted(() => routeByGate())

async function routeByGate() {
  await ensureSession()
  if (session.bootError) return
  const where = gate()
  if (where === 'redeem') return replace('redeem')
  if (where === 'agreement') return replace('agreement')
  // 进得了主流程才查任务。没激活的老师看任务没有意义，
  // 而且那个接口挂在 requireActivated 后面，查了只会拿到 403
  refreshTasks()
  refreshProfile()
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
  push('tasks')
}

function retry() {
  session.ready = false
  routeByGate()
}

function pickSeed(s) {
  seed.value = `我想做个${s}的活动`
  // 填进去之后高度要跟着变一次 —— input 事件只有她自己打字才有
  nextTick(() => autogrow(seedEl.value))
}

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
    /* push 不是 replace：顶栏那个「←」删掉之后，唯一的返回是浏览器后退 ——
       用 replace 的话她在对话流那一页按后退会**直接离开整个网站**。

       往下不再有跳转了：引导、生成、成稿、改一改都在 /c 这一页里往下长。 */
    push('conv', { id: data.conversation_id })
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
  width: 100%;
  background: $mint-soft;
  border: 1px solid $mint-line;
  border-radius: 12px;
  padding: 11px 13px;
  /* 居中之后第一个孩子的 margin-top 会把整列往下推，所以间距一律写在下边 */
  margin-bottom: 20px;
}

.banner__t {
  font-size: var(--fs-read);
  color: $mint-deep;
  font-weight: 600;
}

.banner__b {
  font-size: var(--fs-tag);
  color: $mint-deep;
  margin-left: 10px;
}

/*
  完善信息那个抽屉里的四项。样式跟 redeem.vue 的 `.f` 是同一套 ——
  两处都是「一列表单」，长得不一样会看起来像两个产品。
  ⚠️ 它的输入框同样用 --fs-card：iOS Safari 在输入框小于 16px 时会
  放大整个页面，而这里点进输入框的正是「她要填字」那一刻。
*/
.f {
  display: block;
  margin-bottom: 13px;
}

.f__k {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  margin-bottom: 6px;
}

.f__in {
  display: block;
  width: 100%;
  box-sizing: border-box;
  outline: none;
  border: 1px solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 12px 13px;
  font-size: var(--fs-card);
  color: $ink;
  /* select 在 iOS 上默认样式差很远，统一掉 */
  appearance: none;
  -webkit-appearance: none;
}

.f__in::placeholder {
  color: $ink-3;
}

.f__in:focus {
  border-color: $mint;
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
  margin: 7px 0 17px;
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
  border: 1px solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 4px 11px;
  margin-bottom: 8px;
}

.mode__t {
  font-size: var(--fs-sub);
  color: $ink-2;
  font-weight: 600;
}

.mode__c {
  font-size: var(--fs-tag);
  color: $ink-3;
  margin-left: 5px;
  line-height: 1;
}

/* 抽屉里的两行 */
.mrow {
  display: flex;
  align-items: center;
  width: 100%;
  text-align: left;
  border: 1px solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 12px 13px;
  margin-bottom: 8px;

  &--on {
    background: $amber-soft;
    border-color: $amber-line;
    box-shadow: 0 0 0 1px $amber-line;
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
  margin-top: 2px;
}

.mrow__ck {
  flex: none;
  width: 16px;
  height: 16px;
  margin-left: 8px;
}

.ask {
  border: 1px solid $rule-2;
  border-radius: $r-input;
  background: $white;
  padding: 15px 16px 12px;
  box-shadow: $shadow-card;
}

.ask__ta {
  display: block;
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-size: var(--fs-body);
  line-height: 1.55;
  color: $ink;
  min-height: 46px;
}

.ask__ta::placeholder {
  color: $ink-3;
}

.ask__seeds {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px dashed $rule;
}

.ask__seeds-lb {
  font-size: var(--fs-tag);
  color: $ink-3;
  margin-right: 5px;
}

.chip {
  border: 1px solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 3px 11px;
  margin: 3px 6px 3px 0;
}

.chip__t {
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.5;
}

.act {
  margin-top: 16px;
}

.foot {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  line-height: 1.6;
  text-align: center;
  margin-top: 11px;
}
</style>
