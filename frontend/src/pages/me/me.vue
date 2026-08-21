<template>
  <s-page tab="me">
    <template v-if="loading">
      <s-skel kind="title" />
      <s-skel kind="card" />
      <s-skel kind="card" />
    </template>

    <!--
      拉失败要占整屏。原来这一屏**没有失败态** —— 只弹一个一闪而过的 toast，
      然后照常渲染出 `0/0 次教案` 和一句「还没有记到什么」。
      那两样都是假的：额度可能还剩十几次，记忆可能有五条。
      而且原来的判据是「额度和记忆**都**挂了才报错」，
      所以只有额度挂掉时，她会看到一个安安静静的零。
    -->
    <s-state
      v-else-if="loadError"
      :kind="stateKind(loadError)"
      :text="loadError.message"
      action-label="重试"
      @action="load"
    />

    <template v-else>
      <!-- 昵称是微信昵称，**不是**问卷里那个真实姓名 ——
           真实姓名永不下发前端（016 迁移之后库里根本没有这一列） -->
      <view class="hd">
        <text class="q">{{ teacher.nickname || '老师' }}</text>
      </view>

      <!--
        额度。**用了多少 / 一共多少** 直接摆出来（n/m），不再藏在可展开的台账里 ——
        那个数字本身就是台账的结论，展开一列明细是把我的对账需求摊给她看。
        右边那个按钮换成「兑换」：额度只走兑换码这一条路，
        她在这一屏真正要做的是「我拿到码了，兑进来」。
      -->
      <view class="quota">
        <view class="quota__z">
          <text class="quota__n">{{ quota.text.used }}/{{ quota.text.granted }}</text>
          <text class="quota__u">次教案</text>
        </view>
        <view class="quota__sep" />
        <view class="quota__z">
          <text class="quota__n">{{ quota.image.used }}/{{ quota.image.granted }}</text>
          <text class="quota__u">张配图</text>
        </view>
        <view class="quota__more" @tap="onRedeemTap">
          <text class="quota__more-t">兑换</text>
        </view>
      </view>

      <!--
        可以换额度的事。**一行，点进去看详情** —— 这一屏已经够长了，
        把任务正文和问卷链接铺在这里会把记忆和提建议挤到看不见。
        没有任务时整行不出现（v-show 而不是 v-if：handler key 那个坑）。
      -->
      <view v-show="taskCount > 0" class="row row--task" @tap="goTasks">
        <view class="row__b">
          <text class="row__t">可以换额度的事</text>
          <text v-if="taskUnread" class="row__s">{{ taskUnread }} 件还没看</text>
        </view>
        <text class="row__v">{{ taskCount }} 件 ›</text>
      </view>

      <!-- ============ 记忆 ============ -->
      <view class="sec">
        <text class="sec__h">我的记忆</text>
        <text class="sec__m">写教案时会自动带上</text>
      </view>

      <!--
        档案是这一列的**第一条，但不参与编号**（用户 2026-08-21 定）。

        为什么它归在「我的记忆」底下：这一节的副标题就是「写教案时会自动带上」，
        而园所、年级、职称正是每次都会带上的东西 —— 它跟下面那些记忆是同一类信息，
        只是它有固定的格子、不是一句自由文字。

        为什么不给它编号：编号是给「一条条攒起来的记忆」的（她会说「第 3 条删掉」）。
        档案只有一份、删不掉，给它一个 00 或者把记忆挤到从 02 开始都是错的。
        所以它占一行、留出编号那一列的宽度对齐，但那一格是空的。

        **这一行只写「个人档案」四个字，不预览里面填了什么**（用户 2026-08-21 定）。
        原来这里摊着「阳光幼儿园 · 中班 · 主班 · 本科 · 一级教师 · 教龄 5 年」——
        六项连起来是一长串，在记忆那一列里读起来像第七条记忆，
        而且她要做的事就是「进去改」，摊在外面并不省她一次点击。
      -->
      <view class="mem mem--pf" @tap="onProfileTap">
        <text class="mem__t">个人档案</text>
        <!-- 收起时朝右、展开时朝下。**箭头必须跟着转**：这一行既是入口又是开关，
             展开区里已经没有「取消」了，靠再点一次这一行收起 ——
             箭头是唯一告诉她「这东西是可以收的」的东西。同 s-why 那套 -->
        <image class="mem__i" :class="{ 'mem__i--on': profileOpen }" :src="chevron" mode="widthFix" />
      </view>

      <!--
        档案编辑。**v-show 不是 v-if** —— v-if/v-else 一对占同一个模板位置，
        两个 handler 会拿到同一个缓存 key，微信端把点击派发错人（这一页撞过四次）。
      -->
      <view v-show="profileOpen" class="pf">
        <view class="pf__r">
          <text class="pf__k">园所</text>
          <input
            class="pf__in"
            :value="pfKg"
            placeholder="阳光幼儿园"
            placeholder-class="pf__ph"
            :maxlength="64"
            @input="onKgTyping"
          />
        </view>

        <!--
          年级 / 岗位 / 最高学历 / 职称都是「从几个里挑一个」，所以用同一套胶囊。
          挑中的那个**必须多一个打勾**：黄底压奶油底亮度差只有 1.51:1，
          光靠颜色分不出哪个选中了（design-tokens 规则 3）。
          再点一次同一个 = 取消，她可能就是不想标。
        -->
        <view v-for="g in PICKS" :key="g.key" class="pf__r pf__r--wrap">
          <text class="pf__k">{{ g.label }}</text>
          <view class="pf__opts">
            <view
              v-for="o in g.options"
              :key="o"
              class="band"
              :class="{ 'band--on': picks[g.key] === o }"
              @tap="onPickTap(g.key, o)"
            >
              <image v-if="picks[g.key] === o" class="band__ck" :src="checkInk" mode="widthFix" />
              <text class="band__t" :class="{ 'band__t--on': picks[g.key] === o }">{{ o }}</text>
            </view>
          </view>
        </view>

        <view class="pf__r">
          <text class="pf__k">教龄</text>
          <input
            class="pf__in pf__in--n"
            :value="pfYears"
            type="number"
            :maxlength="2"
            @input="onYearsTyping"
          />
          <text class="pf__u">年</text>
        </view>
        <!--
          只有「改好了」，**没有「取消」**（用户 2026-08-21 定）。
          放弃就再点一次上面那一行「个人档案」—— 那一行本来就是开关，
          多一个「取消」等于给同一件事留两个入口。
        -->
        <view class="pf__ops">
          <s-button label="改好了" :loading="savingProfile" @press="saveProfile" />
        </view>
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
              <text class="editops__c-t">取消</text>
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
        表现就是点「取消」反而又打开一次输入框。`npm run test:mp` 第 2 条查的正是这个。
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
          <s-button label="取消" variant="ghost" @press="cancelAdd" />
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
          <text class="row__s">教案、配图、记忆和你的姓名一起删掉</text>
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
            <!-- 打勾是必需的，不是装饰：黄底压奶油底只有 1.51:1，光靠颜色分不出选中 -->
            <image v-if="category === c.key" class="cat__ck" :src="checkInk" mode="widthFix" />
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

      <!--
        字号。**没有一句说明文字** —— 点下去整屏当场变大，那就是说明。
        写「调整界面文字大小」等于把她一秒就能看到的事替她描述一遍。

        三档是即时生效的，不需要「保存」：她点了看一眼，不合适再点一下。
        存在本机（不进后端），所以换设备会回到标准档 —— 那是两次点击的代价，
        换一次 api-spec 改动加一次迁移不值得。
      -->
      <view class="row row--fs">
        <text class="row__t">字号</text>
        <view class="fss">
          <view
            v-for="f in FONT_SCALES"
            :key="f.key"
            class="fs"
            :class="{ 'fs--on': prefs.fontScale === f.key }"
            @tap="pickFont(f.key)"
          >
            <!-- 选中态不许只靠颜色：黄底和奶油底的亮度差只有 1.51:1（design-tokens 规则 3） -->
            <image v-if="prefs.fontScale === f.key" class="fs__ck" :src="checkInk" mode="widthFix" />
            <text class="fs__t" :class="{ 'fs__t--on': prefs.fontScale === f.key }">{{ f.label }}</text>
          </view>
        </view>
      </view>

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
import { addMemory, deleteMyAccount, getQuota, listMemories, removeMemory, updateMe, updateMemory } from '../../api/me.js'
import { sendFeedback } from '../../api/feedback.js'
import { listTasks } from '../../api/tasks.js'
import { session } from '../../stores/session.js'
import { FONT_SCALES, prefs, setFontScale } from '../../stores/prefs.js'
import { iconCheck, iconChevron } from '../../utils/icons.js'
import { COLORS } from '../../utils/colors.js'
import { navTo, reLaunch } from '../../utils/nav.js'
import { showApiError, stateKind, toast } from '../../utils/ui.js'

const chevron = iconChevron(COLORS.ink3)
const checkInk = iconCheck(COLORS.ink, 2.6)

/**
 * 关于。只留文字模型和版本 ——
 * 「教学框架来自台湾 STEAM 教材」那条删了：那是我们的实现来源，
 * 对老师不构成任何可操作的信息。也不写图片模型：用哪家由后台定、会换。
 */
const ABOUT = [
  { k: '文字模型', v: 'DeepSeek' },
  { k: '版本', v: '内测 · 2026-08' },
]

/**
 * 档案里「从几个里挑一个」的四项。
 *
 * ⚠️ **这几份清单是后端的副本，不是源。** 后端白名单在
 * `backend/src/services/promptBuilder.js`（AGE_GROUPS）和
 * `backend/src/services/roster.js`（POSITIONS / EDUCATIONS / TITLES），
 * 传不在名单上的值会被 400 顶回来。**改一档记得两边一起改。**
 *
 * 顺序照后端那几个数组，别自己重排 —— 她两次打开看到的次序不一样会以为选错了。
 *
 * 「职称」里的**「未评定」是一个她主动选的值**，跟「没填过」不是一回事：
 * 没填过是空的、这一格不显示；选了未评定会显示出来。研究上这两者要分得开，
 * 所以不许在任何地方把空值显示成「未评定」。
 */
const PICKS = [
  { key: 'age_group', label: '年级', options: ['小班', '中班', '大班'] },
  { key: 'position', label: '岗位', options: ['主班', '配班', '保育员', '园长', '其他'] },
  { key: 'education', label: '最高学历', options: ['中专及以下', '大专', '本科', '硕士及以上'] },
  {
    key: 'professional_title',
    label: '职称',
    options: ['未评定', '三级教师', '二级教师', '一级教师', '高级教师', '正高级教师'],
  },
]

const CATEGORIES = [
  { key: 'quality', label: '教案质量' },
  { key: 'feature', label: '想要新功能' },
  { key: 'usability', label: '用着别扭' },
  { key: 'other', label: '其他' },
]

const loading = ref(true)
const loadError = ref(null)
const quota = reactive({ text: { granted: 0, used: 0, left: 0 }, image: { granted: 0, used: 0, left: 0 } })
const memories = ref([])
const taskCount = ref(0)
const taskUnread = ref(0)

const adding = ref(false)
const newFact = ref('')
const savingMem = ref(false)

/* ---- 档案编辑 ---- */
const profileOpen = ref(false)
const pfKg = ref('')
const pfYears = ref('')
/** 四个胶囊项的当前选择。用一个 reactive 而不是四个 ref —— 模板里按 key 取，少四个名字 */
const picks = reactive({ age_group: '', position: '', education: '', professional_title: '' })
const savingProfile = ref(false)

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

// 这里曾经有个 profileLine，把六项拼成「阳光幼儿园 · 中班 · 主班 · …」摊在列表上。
// 2026-08-21 撤掉了 —— 那一行只写「个人档案」，预览不省她一次点击（理由在模板那边）。

onShow(() => load())

async function load() {
  loadError.value = null
  try {
    const [q, m, t] = await Promise.allSettled([getQuota(), listMemories(), listTasks()])

    // 额度或记忆任一挂掉就整屏报错，**不再半屏渲染**。
    // 理由是这一屏没有「单独还有用的一半」：额度挂了那个大数字就是错的，
    // 记忆挂了那份列表就是错的，而这两样都是她照着做判断的东西。
    // 让她看着一个假数字，比让她看到「没拉到，重试」糟得多。
    const core = q.status === 'rejected' ? q : m.status === 'rejected' ? m : null
    if (core) {
      loadError.value = core.reason
      return
    }

    Object.assign(quota, q.value.quota || {})
    // 响应里还有 grants（发放明细）和 free_revisions，界面上不用了 ——
    // 真要查某一笔的来历，后台的老师详情有完整台账
    memories.value = m.value.items || []

    // 任务挂了不算失败：它只是一行入口，锦上添花。整屏为它红一次是把主次弄反了
    if (t.status === 'fulfilled') {
      taskCount.value = (t.value.items || []).length
      taskUnread.value = t.value.unread || 0
    }
  } finally {
    loading.value = false
  }
}

/* ============ 档案 ============ */

/**
 * 「个人档案」那一行 = 开关。点开，再点一次收起（用户 2026-08-21 定）。
 *
 * 展开区里没有「取消」，收起就靠再点这一行 —— 所以这个函数必须是 toggle，
 * 不能是「只负责打开」：那样她点第二下没反应，而唯一的出路是把表单填完。
 *
 * 每次**打开**都从 session 重新灌一遍，不留上次没保存的残留：
 * 她点开、改两个字、再点一次收起，下次点开还看到那两个字，会以为已经存进去了。
 */
function onProfileTap() {
  if (profileOpen.value) {
    // 收起 = 放弃这次改动。不存，也不提示 —— 她自己点的，不需要被告知
    profileOpen.value = false
    return
  }
  const t = teacher.value
  pfKg.value = t.kindergarten_name || ''
  pfYears.value = t.teaching_years == null ? '' : String(t.teaching_years)
  for (const g of PICKS) picks[g.key] = t[g.key] || ''
  profileOpen.value = true
  // 两个输入区同时开着不知道该往哪里打字，跟记忆那两块一个道理
  adding.value = false
  cancelEditMem()
}

/** 存好之后收起。**不给界面用** —— 界面上收起走 onProfileTap 那条 */
function shutProfileEdit() {
  profileOpen.value = false
}

function onKgTyping(e) {
  pfKg.value = e.detail.value
}

function onYearsTyping(e) {
  pfYears.value = e.detail.value
}

/** 再点一次同一个 = 取消选择。她可能就是不想标（尤其职称） */
function onPickTap(key, value) {
  picks[key] = picks[key] === value ? '' : value
}

/**
 * 存档案。
 *
 * 只发**真的改了**的字段：后端那几项各自要过校验，昵称和园所还要过一次内容安全，
 * 每次把三样都发过去等于每次都白跑一遍内容安全（一次微信调用）。
 *
 * 清空要发 `null` 而不是 `''` —— 后端 `push('age_group', v || null)` 那几行
 * 靠的是「传了这个键」，`undefined` 会被 `!== undefined` 判掉、整项不改。
 */
async function saveProfile() {
  if (savingProfile.value) return
  const t = teacher.value
  const fields = {}

  const kg = pfKg.value.trim()
  if (kg !== (t.kindergarten_name || '')) fields.kindergarten_name = kg || null

  for (const g of PICKS) {
    if (picks[g.key] !== (t[g.key] || '')) fields[g.key] = picks[g.key] || null
  }

  const yearsRaw = pfYears.value.trim()
  const years = yearsRaw === '' ? null : Number(yearsRaw)
  if (years !== null && (!Number.isInteger(years) || years < 0 || years > 60)) {
    return toast('教龄填 0 到 60 之间的整数')
  }
  if (years !== (t.teaching_years ?? null)) fields.teaching_years = years

  // 一个字都没动就直接收起来，不发请求
  if (!Object.keys(fields).length) return shutProfileEdit()

  savingProfile.value = true
  try {
    // 后端返回的就是更新后的 teacher DTO，直接接住，省一次 GET /me
    session.teacher = await updateMe(fields)
    shutProfileEdit()
    toast('改好了')
  } catch (err) {
    showApiError(err)
  } finally {
    savingProfile.value = false
  }
}

/* ============ 记忆 ============ */

// 都用具名函数，不写内联箭头：内联的在编译产物里更容易跟别处撞同一个 handler key
function onRedeemTap() {
  // topup=1：她已经激活过了，兑换页据此不让她再选身份、也不把她弹回首页
  navTo('redeem', { topup: 1 })
}

function goTasks() {
  navTo('tasks')
}

/** 具名函数、名字跟别的 handler 不像 —— uni 的 handler 缓存 key 只有 256 个桶，撞了微信会把点击派发错人 */
function pickFont(key) {
  setFontScale(key)
}

function startAdd() {
  adding.value = true
  cancelEditMem()
  profileOpen.value = false
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
  // 打开编辑就把「新增」和档案收起来，几个输入框同时开着不知道该往哪个打字
  adding.value = false
  profileOpen.value = false
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
    cancelText: '取消',
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
      '你的教案、配图、记忆和姓名都会被删掉，删完这个账号就不能再用了。' +
      '已经用于科研的那部分（你提交过的建议和评价）撤不回来，但不再关联到你。',
    confirmText: '我要删除',
    confirmColor: COLORS.coralDeep,
    cancelText: '取消',
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

</script>

<style lang="scss" scoped>
.hd {
  margin: 40rpx 0 28rpx;
}

.q {
  display: block;
  font-size: var(--fs-title);
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
}

/* ============ 档案编辑 ============ */
.pf {
  background: $white;
  border: 2rpx solid $rule-2;
  border-radius: 28rpx;
  padding: 24rpx 26rpx;
  margin-bottom: 24rpx;
}

.pf__r {
  display: flex;
  align-items: center;
  min-height: 72rpx;

  /*
    职称有六档，一行摆不下 —— 必须能换行，而且换行之后标签要回到第一行的顶上，
    不能垂直居中（居中的话「职称」两个字会飘到两行胶囊的中间）。
  */
  &--wrap {
    align-items: flex-start;
    padding: 12rpx 0;
  }
}

.pf__k {
  width: 120rpx;
  flex: none;
  font-size: var(--fs-sub);
  color: $ink-2;
}

.pf__in {
  flex: 1;
  min-width: 0;
  height: 64rpx;
  border-bottom: 2rpx solid $rule-2;
  font-size: var(--fs-body);
  color: $ink;

  /* 教龄只有两位数，占满一行会让「年」飘到很远的地方 */
  &--n {
    flex: none;
    width: 120rpx;
  }
}

.pf__ph {
  color: $ink-3;
}

.pf__u {
  font-size: var(--fs-sub);
  color: $ink-2;
  margin-left: 12rpx;
}

.pf__opts {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  /* 换行之后两行胶囊之间要有缝，靠 .band 的 margin-bottom 给（gap 在低版本微信里不稳） */
  margin-top: 2rpx;
}

.band {
  display: flex;
  align-items: center;
  border: 2rpx solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 8rpx 20rpx;
  margin: 0 10rpx 10rpx 0;

  &--on {
    background: $amber;
    border-color: $amber-line;
  }
}

.band__ck {
  width: 22rpx;
  height: 22rpx;
  margin-right: 8rpx;
}

.band__t {
  font-size: var(--fs-sub);
  color: $ink-2;

  &--on {
    color: $ink;
    font-weight: 600;
  }
}

/* 只有一个「改好了」，独占一行。放弃靠再点一次上面那行「个人档案」 */
.pf__ops {
  margin-top: 20rpx;
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

/*
  2026-08-20 重新配重：数字从 --fs-title（22px）降到 --fs-card（17px），
  「兑换」从 --fs-tag（12px）提到 --fs-body（15px）。

  原来这一块**喊的是数字、耳语的是动作**，而她进这一屏真正要做的事是兑换 ——
  那个数字只是她判断「要不要兑」的依据，不是主角。
  两者拉近到 17 : 15 之后，视线先落在数字上、手很自然落到按钮上。
*/
.quota__n {
  font-size: var(--fs-card);
  font-weight: 700;
  color: $amber-deep;
  line-height: 1.2;
}

.quota__u {
  font-size: var(--fs-tag);
  color: $ink-2;
  margin-left: 6rpx;
}

.quota__sep {
  width: 2rpx;
  height: 32rpx;
  background: $amber-line;
  margin: 0 22rpx;
}

/* 按钮变大了就得真有按钮的手感：留白加厚、加一道下沿实边 */
.quota__more {
  margin-left: auto;
  border: 2rpx solid $amber-line;
  border-radius: $r-chip;
  background: $white;
  padding: 12rpx 30rpx;
  box-shadow: 0 3rpx 0 $amber-line;
}

.quota__more-t {
  font-size: var(--fs-body);
  color: $amber-deep;
  font-weight: 600;
}

/* ============ 分节 ============ */
.sec {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 36rpx 0 16rpx;
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
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink-3;
  line-height: 1.7;
}

.mem__t {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-read);
  color: $ink-2;
  line-height: 1.65;
}

/*
  档案那一行。跟记忆行同一个形状（所以两者读起来是一列），只有两点不同：
  · 没有编号 —— 编号是给「一条条攒起来的记忆」的，档案只有一份、删不掉
  · 右边带一个箭头，因为它是个开关（点开表单，再点收起）

  ⚠️ **不给它加底色也不加边框。** 试过一下就知道为什么：它一有底色就从
  「这一列的第一条」变成「压在列表上面的一个卡片」，而用户要的正是前者。

  🔴 **不许缩进。** 「个人档案」四个字要跟下面 `01` `02` 那一列的**左边缘**齐平，
  不是跟记忆的正文齐平（用户 2026-08-21 两次提的，第一次我理解反了）。
  编号那一列定义了这个板块的视觉左边界；档案行往右让 44rpx 之后，
  它看起来就是「缩进的一条」，而它明明是这一列的第一条。

  所以这里**没有 padding-left**，也别用一个空的 `<text class="mem__n">` 去占位
  （那两种做法都是在重新制造缩进）。
*/
.mem--pf {
  align-items: center;
}

.mem__i {
  flex: none;
  width: 20rpx;
  height: 20rpx;
  margin-left: 12rpx;

  /* 展开时转成朝下。这是「可以收起来」的唯一提示 —— 展开区里没有取消按钮 */
  &--on {
    transform: rotate(90deg);
  }
}

.mem__none {
  display: block;
  font-size: var(--fs-sub);
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
  font-size: var(--fs-sub);
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
  font-size: var(--fs-body);
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
  display: flex;
  align-items: center;
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

.cat__ck {
  width: 22rpx;
  height: 22rpx;
  margin-right: 8rpx;
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
  width: 100%;
  border: 2rpx solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 24rpx 26rpx;
  font-size: var(--fs-body);
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
  font-size: var(--fs-read);
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
  font-size: var(--fs-body);
  color: $ink-2;
}

.row__v {
  font-size: var(--fs-sub);
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
  font-size: var(--fs-sub);
  color: $coral-deep;
}

.editops__c {
  padding: 10rpx 20rpx;
}

.editops__c-t {
  font-size: var(--fs-sub);
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
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  margin-top: 4rpx;
}

/* 任务那一行。整行可点，右边一个箭头 —— 跟底下「使用协议」那几行同一个形状，
   因为它们是同一类东西：跳出去看的入口 */
.row--task {
  border-bottom: 2rpx solid $rule;
  padding-bottom: 24rpx;
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
  font-size: var(--fs-sub);
  color: $coral-deep;
  font-weight: 600;
}

/* ============ 字号 ============ */
/* 跟底下「使用协议」那几行同一个行高形状，只是右边是三个胶囊而不是一个箭头 */
.row--fs {
  flex-wrap: wrap;
}

.fss {
  display: flex;
  margin-left: 20rpx;
}

.fs {
  display: flex;
  align-items: center;
  border: 2rpx solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 8rpx 22rpx;
  margin-left: 12rpx;

  &--on {
    background: $amber;
    border-color: $amber-line;
  }
}

.fs__ck {
  width: 22rpx;
  height: 22rpx;
  margin-right: 8rpx;
}

.fs__t {
  font-size: var(--fs-sub);
  color: $ink-2;

  &--on {
    color: $ink;
    font-weight: 600;
  }
}
</style>
