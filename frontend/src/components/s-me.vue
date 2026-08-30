<template>
  <div v-if="visible" class="me">
    <!-- 点旁边关掉 —— 误触时最自然的退出方式 -->
    <div class="me__mask" @click="$emit('close')" />

    <div class="me__box" role="dialog" aria-modal="true" aria-label="我的">
      <div class="me__hd">
        <!-- 昵称**不是**问卷里那个真实姓名 —— 真实姓名和手机号永不下发前端 -->
        <span class="me__title">{{ session.teacher?.nickname || '我的' }}</span>
        <button type="button" class="me__x" @click="$emit('close')">
          <span class="me__x-t">关闭</span>
        </button>
      </div>

      <div class="me__body">
        <template v-if="loading">
          <s-skel kind="card" />
          <s-skel kind="line" />
          <s-skel kind="line" w="60%" />
        </template>

        <!--
          拉失败要占住整块。原来这一屏**没有失败态** —— 只弹一个一闪而过的 toast，
          然后照常渲染出 `0/0 次教案` 和一句「还没有记到什么」。那两样都是假的。
        -->
        <s-state
          v-else-if="loadError"
          :kind="stateKind(loadError)"
          :text="loadError.message"
          action-label="重试"
          @action="load"
        />

        <!--
          宽屏上分两列（2026-08-31 用户提）。**不是手机的限制** ——
          竖着一条在 1440px 的屏幕上要滚四五屏，而这里每一节都很短。
          窄屏上两列自然堆成一列，内容一个字都不换。
        -->
        <template v-else>
          <div class="col">
          <!--
            额度。**用了多少 / 一共多少** 直接摆出来，不藏在可展开的台账里 ——
            那个数字本身就是台账的结论。
          -->
          <div class="quota">
            <div class="quota__z">
              <span class="quota__n">{{ quota.text.used }}/{{ quota.text.granted }}</span>
              <span class="quota__u">次教案</span>
            </div>
            <div class="quota__sep" />
            <div class="quota__z">
              <span class="quota__n">{{ quota.image.used }}/{{ quota.image.granted }}</span>
              <span class="quota__u">张配图</span>
            </div>
          </div>

          <!-- ============ 可以换额度的事 ============ -->
          <template v-if="tasks.length">
            <div class="sec">
              <span class="sec__h">可以换额度的事</span>
              <span class="sec__m">{{ tasks.length }} 件</span>
            </div>
            <!--
              任务和奖励是**断开的**：填完问卷不会自动到账，要等核对之后发一个码给她。
              这句话必须写出来 —— 不写她填完会盯着额度看，发现没变以为坏了。
              这是「不写解释性小字」那条规则的例外：不说她会以为出 bug 了。
            -->
            <div class="hint">
              <span class="hint__t">填完问卷之后，我会核对一下，再把兑换码发给你。额度不会自己到账。</span>
            </div>
            <div v-for="t in tasks" :key="t.id" class="task">
              <div class="task__hd">
                <span class="task__t">{{ t.title }}</span>
                <span v-if="t.unread" class="task__new">新</span>
              </div>
              <span v-if="t.body" class="task__b">{{ t.body }}</span>
              <div class="task__meta">
                <span class="task__r">做完给 {{ t.reward_text }} 次教案 · {{ t.reward_image }} 张配图</span>
                <span class="task__d" :class="{ 'task__d--soon': t.days_left !== null && t.days_left <= 3 }">
                  {{ deadlineText(t) }}
                </span>
              </div>
              <!-- 网页里直接就是一个能点开的链接。小程序时代只能给「复制链接」，
                   因为那边打不开外部网页 —— 这条限制在浏览器里不存在了 -->
              <a v-if="t.survey_url" class="task__url" :href="t.survey_url" target="_blank" rel="noopener">
                去填问卷 ›
              </a>
            </div>
          </template>

          <!-- ============ 记忆 ============ -->
          <div class="sec">
            <span class="sec__h">我的记忆</span>
            <span class="sec__m">写教案时会自动带上</span>
          </div>

          <!--
            档案是这一列的**第一条，但不参与编号**（用户 2026-08-21 定）。
            这一行只写「个人档案」四个字，**不预览里面填了什么** ——
            六项连起来是一长串，读起来像第七条记忆，而且她要做的事就是「进去改」。
          -->
          <button type="button" class="mrow mrow--pf" @click="profileOpen = !profileOpen">
            <span class="mrow__t">个人档案</span>
            <!-- 收起时朝右、展开时朝下。**箭头必须跟着转**：这一行既是入口又是开关，
                 展开区里没有「取消」，靠再点一次这一行收起 -->
            <img class="mrow__i" :class="{ 'mrow__i--on': profileOpen }" :src="chevron" alt="" />
          </button>
          <s-profile v-show="profileOpen" :visible="profileOpen" @close="profileOpen = false" />

          <!-- **点整行就是改**，不额外挂一个「改」字按钮 —— 一行只有一个动作。
               也不显示 mem_type：这一节叫「我的记忆」，每条都是记忆 -->
          <button v-for="(m, i) in memories" :key="m.id" type="button" class="mrow" @click="startEdit(m)">
            <span class="mrow__n">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="mrow__f">{{ m.fact }}</span>
          </button>

          <div v-if="editing" class="add">
            <textarea v-model="editFact" class="add__ta" maxlength="200" rows="2" @input="autogrow($event.target)" />
            <s-button label="改好了" :disabled="!editFact.trim()" :loading="savingEdit" @press="saveEdit" />
            <div class="editops">
              <button type="button" class="editops__x" @click="askDeleteMem">
                <span class="editops__x-t">删掉这条</span>
              </button>
              <button type="button" class="editops__c" @click="cancelEdit">
                <span class="editops__c-t">取消</span>
              </button>
            </div>
          </div>

          <span v-if="!memories.length" class="mnone">
            还没有记到什么。写过几份教案之后，我会把你反复提到的情况记在这儿。
          </span>

          <div v-if="adding" class="add">
            <textarea
              ref="addEl"
              v-model="newFact"
              class="add__ta"
              placeholder="例：园里没有投影仪"
              maxlength="100"
              rows="2"
              @input="autogrow($event.target)"
            />
            <s-button label="记下来" :disabled="!newFact.trim()" :loading="savingMem" @press="saveMem" />
            <s-button label="取消" variant="ghost" @press="adding = false" />
          </div>
          <button v-else type="button" class="memadd" @click="startAdd">
            <span class="memadd__t">＋ 再记一条</span>
          </button>

          </div>

          <div class="col">
          <!--
            注销。夹在记忆和提建议之间，**不挨着最底下那几行** ——
            两个可点区域上下贴着，很容易手滑点错，而这个动作不可逆。

            ⚠️ 宽屏分两列之后它落在右列顶上，跟左列的「再记一条」不再上下相邻，
            那个「手滑点错」的风险反而更小了。
          -->
          <div class="hr hr--first" />
          <div class="drow">
            <div class="drow__b">
              <span class="drow__t">删除我的全部数据</span>
              <span class="drow__s">教案、配图、记忆和你的姓名一起删掉</span>
            </div>
            <button type="button" class="del" @click="askDeleteAccount">
              <span class="del__t">删除</span>
            </button>
          </div>

          <!-- ============ 提建议 ============ -->
          <div class="hr" />
          <div class="sec">
            <span class="sec__h">提个建议</span>
            <span class="sec__m">我会挨条看</span>
          </div>

          <div v-if="sent" class="sent"><span class="sent__t">收到了，谢谢。</span></div>
          <template v-else>
            <div class="cats">
              <button
                v-for="c in CATEGORIES"
                :key="c.key"
                type="button"
                class="cat"
                :class="{ 'cat--on': category === c.key }"
                @click="category = category === c.key ? '' : c.key"
              >
                <!-- 打勾是必需的，不是装饰：黄底压奶油底只有 1.51:1 -->
                <img v-if="category === c.key" class="cat__ck" :src="checkInk" alt="已选" />
                <span class="cat__t" :class="{ 'cat__t--on': category === c.key }">{{ c.label }}</span>
              </button>
            </div>
            <textarea
              v-model="suggestion"
              class="sug"
              placeholder="哪里不好用、想要什么，直接说"
              maxlength="500"
              rows="2"
              @input="autogrow($event.target)"
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
            字号。**没有一句说明文字** —— 点下去整屏当场变大，那就是说明。
            三档即时生效，不需要「保存」。
          -->
          <div class="hr" />
          <div class="frow">
            <span class="frow__t">字号</span>
            <div class="fss">
              <button
                v-for="f in FONT_SCALES"
                :key="f.key"
                type="button"
                class="fs"
                :class="{ 'fs--on': prefs.fontScale === f.key }"
                @click="setFontScale(f.key)"
              >
                <img v-if="prefs.fontScale === f.key" class="fs__ck" :src="checkInk" alt="已选" />
                <span class="fs__t" :class="{ 'fs__t--on': prefs.fontScale === f.key }">{{ f.label }}</span>
              </button>
            </div>
          </div>

          <!--
            使用协议与隐私说明。**隐私说明只有一份，就在协议里** ——
            这里再抄一遍就是第二份，而重复的两份迟早不一致，
            不一致的隐私说明比没有更糟。所以这里只留一个入口。
          -->
          <button type="button" class="frow" @click="goAgreement">
            <span class="frow__t">使用协议与隐私说明</span>
            <img class="frow__i" :src="chevron" alt="" />
          </button>

          <div v-for="a in ABOUT" :key="a.k" class="frow">
            <span class="frow__t">{{ a.k }}</span>
            <span class="frow__v">{{ a.v }}</span>
          </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 「我的」—— 屏幕正中间的一个弹窗（2026-08-31 用户定）。
 *
 * 额度 / 可换额度的事 / 我的记忆（含个人档案）/ 注销 / 提建议 / 字号 / 版本。
 * 小程序时代这是一整页，网页上收成一个弹窗 —— 侧边栏左下角那一行是唯一入口。
 *
 * ⚠️ **兑换码入口和使用协议这一轮没有**：兑换页要等后端的手机号 + 密码身份模型，
 * 协议页还没搬。摆一个点了跳不动的入口比没有更糟。
 */
import { nextTick, reactive, ref, watch } from 'vue'
import { addMemory, deleteMyAccount, getQuota, listMemories, removeMemory, updateMemory } from '../api/me.js'
import { sendFeedback } from '../api/feedback.js'
import { listTasks, markTaskRead } from '../api/tasks.js'
import { session } from '../stores/session.js'
import { FONT_SCALES, prefs, setFontScale } from '../stores/prefs.js'
import { iconCheck, iconChevron } from '../utils/icons.js'
import { COLORS } from '../utils/colors.js'
import { alert, confirm, showApiError, stateKind, toast } from '../utils/ui.js'
import { autogrow } from '../utils/autogrow.js'
import { clearToken } from '../utils/request.js'
import { push } from '../utils/nav.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
})

const emit = defineEmits(['close'])

const chevron = iconChevron(COLORS.ink3)
const checkInk = iconCheck(COLORS.ink, 2.6)

/**
 * 关于。只留版本 ——「教学框架来自台湾 STEAM 教材」那条删了：
 * 那是我们的实现来源，对老师不构成任何可操作的信息。
 * 「文字模型: DeepSeek」也删了：用哪家由后台定、会换，留着等于留一句迟早变假的话。
 */
const ABOUT = [{ k: '版本', v: '内测 · 2026-08' }]

const CATEGORIES = [
  { key: 'quality', label: '教案质量' },
  { key: 'feature', label: '想要新功能' },
  { key: 'usability', label: '用着别扭' },
  { key: 'other', label: '其他' },
]

const loading = ref(true)
const loadError = ref(null)
const quota = reactive({
  text: { granted: 0, used: 0, left: 0 },
  image: { granted: 0, used: 0, left: 0 },
})
const memories = ref([])
const tasks = ref([])
const profileOpen = ref(false)

const adding = ref(false)
const addEl = ref(null)
const newFact = ref('')
const savingMem = ref(false)

const editing = ref(null)
const editFact = ref('')
const savingEdit = ref(false)

const category = ref('')
const suggestion = ref('')
const sending = ref(false)
const sent = ref(false)

watch(
  () => props.visible,
  (on) => {
    if (on) load()
  }
)

async function load() {
  loadError.value = null
  loading.value = true
  try {
    const [q, m, t] = await Promise.allSettled([getQuota(), listMemories(), listTasks()])

    /*
      额度或记忆任一挂掉就整块报错，**不再半屏渲染**。
      这一块没有「单独还有用的一半」：额度挂了那个数字就是错的，
      记忆挂了那份列表就是错的，而这两样都是她照着做判断的东西。
      让她看着一个假数字，比让她看到「没拉到，重试」糟得多。
    */
    const core = q.status === 'rejected' ? q : m.status === 'rejected' ? m : null
    if (core) {
      loadError.value = core.reason
      return
    }

    /*
      🔴 额度嵌在 `.quota` 里，不在响应根上（`GET /me/quota` 回的是
      `{ quota: {text, image}, grants, free_revisions }`）。
      写成 `Object.assign(quota, q.value)` 会让两个数字**静静地停在 0/0**，
      而 0/0 看起来完全正常 —— 她会以为自己一次都没用过，或者额度没发下来。
      这一条 CLAUDE.md 里记过一次（「报『没有数据』之前先确认查的是不是对的字段」）。
    */
    Object.assign(quota, q.value?.quota || {})
    memories.value = m.value?.items || []

    // 任务拉不到就当没有 —— 它是锦上添花，不该让整块报错
    tasks.value = t.status === 'fulfilled' ? t.value?.items || [] : []
    // 打开就把未读标掉：她已经看见了，首页那条条带不该再挂着。
    // 不 await：标已读失败不该影响这一块
    tasks.value.filter((x) => x.unread).forEach((x) => markTaskRead(x.id).catch(() => {}))
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

/** 剩几天比一个日期有用 —— 她要判断的是「今天还来不来得及」 */
function deadlineText(t) {
  if (t.days_left === null) return '不限时'
  if (t.days_left === 0) return '今天最后一天'
  return `还剩 ${t.days_left} 天`
}

/* ============ 记忆 ============ */

function startAdd() {
  adding.value = true
  newFact.value = ''
  nextTick(() => addEl.value?.focus())
}

async function saveMem() {
  const fact = newFact.value.trim()
  if (!fact || savingMem.value) return
  savingMem.value = true
  try {
    await addMemory(fact)
    adding.value = false
    newFact.value = ''
    await load()
    toast('记下了')
  } catch (err) {
    showApiError(err)
  } finally {
    savingMem.value = false
  }
}

function startEdit(m) {
  editing.value = m
  editFact.value = m.fact
}

function cancelEdit() {
  editing.value = null
  editFact.value = ''
}

async function saveEdit() {
  const fact = editFact.value.trim()
  const m = editing.value
  if (!fact || !m || savingEdit.value) return
  // 一个字没动就别发请求 —— 后端每次改都要过一遍内容安全检查
  if (fact === m.fact) return cancelEdit()
  savingEdit.value = true
  try {
    await updateMemory(m.id, fact)
    cancelEdit()
    await load()
    toast('改好了')
  } catch (err) {
    showApiError(err)
  } finally {
    savingEdit.value = false
  }
}

/** 记忆是会被喂进模型的东西，删除权必须完全在她手里；但也别手滑就没了 */
async function askDeleteMem() {
  const m = editing.value
  if (!m) return
  const ok = await confirm(`删掉「${m.fact}」？以后写教案就不带上它了。`, { confirmText: '删掉' })
  if (!ok) return
  try {
    await removeMemory(m.id)
    cancelEdit()
    await load()
    toast('删掉了')
  } catch (err) {
    showApiError(err)
  }
}

/* ============ 注销 ============ */

/**
 * 问两次不是啰嗦：第一次是**读**（说清后果），第二次才是**决定**。
 * 「不可逆」这件事必须出现在她按下去之前。
 */
async function askDeleteAccount() {
  const read = await confirm(
    '你的教案、配图、记忆和姓名都会被删掉，删完这个账号就不能再用了。' +
      '已经用于科研的那部分（你提交过的建议和评价）撤不回来，但不再关联到你。',
    { confirmText: '我要删除' }
  )
  if (!read) return
  const sure = await confirm('这一步之后就找不回来了。', { confirmText: '确认删除', cancelText: '再想想' })
  if (!sure) return
  try {
    await deleteMyAccount()
    // 数据已经没了，留在这儿只会看到一屏空壳
    clearToken()
    session.teacher = null
    emit('close')
    await alert('删完了。谢谢你用过这个东西。')
    window.location.href = '/'
  } catch (err) {
    showApiError(err)
  }
}

/** 回头看一眼那份协议。 让它别走 gate ——
    已经同意过的老师进去会被弹回首页，表现是「点了什么都没发生」 */
function goAgreement() {
  emit('close')
  push('agreement', { view: 1 })
}

/* ============ 建议 ============ */

async function submitSuggestion() {
  const text = suggestion.value.trim()
  if (!text || sending.value) return
  sending.value = true
  try {
    await sendFeedback({ category: category.value || 'other', text })
    sent.value = true
    suggestion.value = ''
    category.value = ''
  } catch (err) {
    showApiError(err)
  } finally {
    sending.value = false
  }
}
</script>

<style lang="scss" scoped>
.me {
  position: fixed;
  inset: 0;
  z-index: 950;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: $sp-4;
}

.me__mask {
  position: absolute;
  inset: 0;
  background: rgba(58, 54, 48, 0.45);
}

/*
  正中间。**给一个最大高度让它自己滚** —— 里面有七节，小屏上装不下。
  宽度在下面的 @media 里放开：窄屏一条 460，宽屏两列 820。
*/
.me__box {
  position: relative;
  width: 100%;
  max-width: 460px;
  max-height: 88dvh;
  display: flex;
  flex-direction: column;
  background: $paper;
  border-radius: $r-card;
  box-shadow: $shadow-card;
}

.me__hd {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px $sp-5 10px;
  border-bottom: 1px solid $rule;
}

.me__title {
  font-size: var(--fs-card);
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.01em;
}

.me__x {
  padding: 4px 10px;
  border-radius: $r-chip;
  border: 1px solid $rule-2;
  background: $paper-2;
}

.me__x-t {
  font-size: var(--fs-sub);
  color: $ink-2;
}

.me__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: $sp-3 $sp-5 $sp-5;
  padding-bottom: calc(#{$sp-5} + env(safe-area-inset-bottom));
}

/* ============ 额度 ============ */
.quota {
  display: flex;
  align-items: center;
  border: 1px solid $amber-line;
  border-radius: $r-card;
  background: $amber-soft;
  padding: 12px;
}

.quota__z {
  flex: 1;
  text-align: center;
}

.quota__n {
  display: block;
  font-size: var(--fs-title);
  font-weight: 700;
  color: $amber-deep;
  line-height: 1.2;
}

.quota__u {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-2;
  margin-top: 2px;
}

.quota__sep {
  width: 1px;
  height: 26px;
  background: $amber-line;
}

/* ============ 分节 ============ */
.sec {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: $sp-5 0 $sp-2;
}

.sec__h {
  font-size: var(--fs-sub);
  font-weight: 700;
  color: $ink-2;
  letter-spacing: 0.04em;
}

.sec__m {
  font-size: var(--fs-tag);
  color: $ink-3;
}

.hr {
  height: 1px;
  background: $rule;
  margin: $sp-5 0 0;
}

/* ============ 任务 ============ */
.hint {
  background: $sky-soft;
  border-radius: 10px;
  padding: 9px 11px;
  margin-bottom: $sp-2;
}

.hint__t {
  font-size: var(--fs-tag);
  color: $sky-deep;
  line-height: 1.7;
}

.task {
  border: 1px solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 11px 12px;
  margin-bottom: $sp-2;
}

.task__hd {
  display: flex;
  align-items: center;
  margin-bottom: 3px;
}

.task__t {
  flex: 1;
  font-size: var(--fs-body);
  font-weight: 600;
  color: $ink;
}

.task__new {
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink;
  background: $amber;
  border-radius: $r-chip;
  padding: 1px 7px;
}

.task__b {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.7;
  margin-bottom: 5px;
}

.task__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
}

.task__r {
  font-size: var(--fs-tag);
  color: $mint-deep;
  font-weight: 600;
}

.task__d {
  font-size: var(--fs-tag);
  color: $ink-3;

  /* 快到期用珊瑚色 —— 它是「要当心的地方」 */
  &--soon {
    color: $coral-deep;
    font-weight: 600;
  }
}

.task__url {
  display: inline-block;
  margin-top: 7px;
  font-size: var(--fs-sub);
  font-weight: 600;
  color: $sky-deep;
  text-decoration: none;
}

/* ============ 记忆 ============ */
.mrow {
  display: flex;
  align-items: flex-start;
  width: 100%;
  text-align: left;
  padding: 9px 0;
  border-bottom: 1px solid $rule;
}

.mrow__n {
  flex: none;
  width: 26px;
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink-3;
  padding-top: 2px;
}

.mrow__f {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sub);
  color: $ink;
  line-height: 1.6;
}

/* 🔴 档案那一行**跟编号列的左边缘对齐，不是跟记忆正文对齐**
   （用户 2026-08-21 定，2026-08-31 又指出一次）。
   缩进到正文那一列会让它看起来像第 0 条记忆的内容，而它是这一节的入口。 */
.mrow--pf {
  justify-content: space-between;
}

.mrow__t {
  font-size: var(--fs-sub);
  font-weight: 600;
  color: $ink;
}

.mrow__i {
  width: 9px;
  height: 9px;

  &--on {
    transform: rotate(90deg);
  }
}

.mnone {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  line-height: 1.7;
  padding: $sp-2 0;
}

.add {
  padding: $sp-2 0;
}

.add__ta {
  display: block;
  width: 100%;
  outline: none;
  resize: none;
  border: 1px solid $amber-line;
  border-radius: $r-btn;
  background: $white;
  padding: 10px 12px;
  font-size: var(--fs-body);
  line-height: 1.55;
  color: $ink;
  margin-bottom: $sp-2;
  min-height: 48px;
}

.add__ta::placeholder {
  color: $ink-3;
}

.editops {
  display: flex;
  justify-content: space-between;
  margin-top: $sp-2;
}

.editops__x-t {
  font-size: var(--fs-sub);
  color: $coral-deep;
}

.editops__c-t {
  font-size: var(--fs-sub);
  color: $ink-3;
}

.memadd {
  display: block;
  width: 100%;
  text-align: left;
  padding: 11px 0;
}

.memadd__t {
  font-size: var(--fs-sub);
  color: $amber-deep;
  font-weight: 600;
}

/* ============ 注销 ============ */
.drow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $sp-3 0;
}

.drow__b {
  flex: 1;
  min-width: 0;
}

.drow__t {
  display: block;
  font-size: var(--fs-sub);
  color: $ink;
}

/* 这句留得住：**不可逆动作的后果**必须出现在她按下去之前 */
.drow__s {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  margin-top: 2px;
}

.del {
  flex: none;
  border: 1px solid $coral;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 5px 13px;
  margin-left: $sp-3;
}

.del__t {
  font-size: var(--fs-sub);
  color: $coral-deep;
  font-weight: 600;
}

/* ============ 建议 ============ */
.sent {
  background: $mint-soft;
  border-radius: 10px;
  padding: 11px;
}

.sent__t {
  font-size: var(--fs-sub);
  color: $mint-deep;
  font-weight: 600;
}

.cats {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: $sp-2;
}

.cat {
  display: flex;
  align-items: center;
  border: 1px solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 4px 10px;
  margin: 0 5px 5px 0;
}

.cat--on {
  background: $amber;
  border-color: $amber-line;
}

.cat__ck {
  width: 11px;
  height: 11px;
  margin-right: 3px;
}

.cat__t {
  font-size: var(--fs-sub);
  color: $ink-2;

  &--on {
    color: $ink;
    font-weight: 600;
  }
}

.sug {
  display: block;
  width: 100%;
  outline: none;
  resize: none;
  border: 1px solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 10px 12px;
  font-size: var(--fs-body);
  line-height: 1.55;
  color: $ink;
  margin-bottom: $sp-2;
  min-height: 54px;
}

.sug::placeholder {
  color: $ink-3;
}

/* ============ 字号与版本 ============ */
.frow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  padding: $sp-3 0;
  border-bottom: 1px solid $rule;
}

.frow__t {
  font-size: var(--fs-sub);
  color: $ink;
}

.frow__v {
  font-size: var(--fs-sub);
  color: $ink-3;
}

.frow__i {
  width: 9px;
  height: 9px;
}

.fss {
  display: flex;
}

.fs {
  display: flex;
  align-items: center;
  border: 1px solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 4px 11px;
  margin-left: 5px;
}

.fs--on {
  background: $amber;
  border-color: $amber-line;
}

.fs__ck {
  width: 11px;
  height: 11px;
  margin-right: 3px;
}

.fs__t {
  font-size: var(--fs-sub);
  color: $ink-2;

  &--on {
    color: $ink;
    font-weight: 600;
  }
}

/* 窄屏上两列就是上下两块，第二块顶上那道分隔线是需要的 */
.hr--first {
  margin-top: $sp-5;
}

/* ============ 宽屏：两列 ============ */
/*
  竖着一条在 1440px 的屏幕上要滚四五屏，而这里每一节都很短 ——
  **这不是手机的限制**，是同一份内容换个排布（2026-08-31 用户提）。

  断点跟外壳同一个 900px：不另立一个断点，否则「什么时候变宽」在两处各写一份。
*/
@media (min-width: 900px) {
  .me__box {
    max-width: 820px;
  }

  .me__body {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 $sp-6;
    align-items: start;
  }

  /* 两列并排之后，右列顶上那道横线是多余的 —— 它上面已经没有东西了 */
  .hr--first {
    display: none;
  }
}
</style>
