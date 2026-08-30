<template>
  <!--
    一份教案 = 对话流里的**一个 container**（2026-08-30 用户定）。
    有边界、有底、有自己的操作 —— 她一眼看得出「这一整块是一份教案」，
    而不是一段跟上下文混在一起的长文字。
  -->
  <article class="pl">
      <h1 class="title">{{ c.title || plan.title }}</h1>

      <div class="chips">
        <span class="chip chip--age"><span class="chip__t">{{ plan.age_group }}</span></span>
        <span class="chip"><span class="chip__t">{{ plan.duration_min }} 分钟</span></span>
        <span class="chip chip--saved">
          <span class="chip__dot" />
          <span class="chip__t chip__t--saved">已保存</span>
        </span>
        <span v-if="plan.version > 1" class="chip chip--ver">
          <span class="chip__t">第 {{ currentVersion }} 版</span>
        </span>
      </div>

      <!--
        版本条搬出去了（2026-08-30 合成对话流）：改稿是覆盖式的，退路必须摆在明面上 ——
        但在一条流里，退路就是**上面那几条**。每一版在流里各占一行，
        由 conv.vue 画，这个 container 只管画「现在是哪一版」。
      -->

      <!--
        旧格式教案的兜底（2026-08-20 改版）。

        库里还有一批改版前生成的教案，它们没有 objectives / key_points / preparation。
        用户定的是「直接不管」——但**不管不等于渲染成一屏空板块**：那看起来像坏了。
        所以认出旧格式就退回显示存好的 Markdown 原文，并说明一句为什么长这样。
      -->
      <template v-if="isLegacy">
        <div class="legacy">
          <span class="legacy__t">这份是旧格式的教案，按原样显示。新写的教案会用现在的格式。</span>
        </div>
        <p class="legacy__md">{{ plan.content_md }}</p>
      </template>

      <template v-else>
      <!-- ============ 设计意图 ============ -->
      <!--
        每个板块下面那条「为什么这样设计 ›」= 学习模式的教案解读。
        **默认折叠**（用户 2026-08-20 定）：这一屏已经很长，她第二次打开这份教案
        想找的是「第三环节我要干什么」，常驻穿插会让她每次都从解读里翻过去。
        开合状态在 s-why 自己身上，这一页不加任何 handler —— 理由见那个组件的注释。
      -->
      <template v-if="c.intent">
        <div class="sec"><span class="sec__h">设计意图</span></div>
        <p class="para">{{ c.intent }}</p>
        <s-why :text="wh.intent" />
        <div class="hr" />
      </template>

      <!-- ============ STEAM 五域 ============ -->
      <div class="sec">
        <span class="sec__h">STEAM 五域标注</span>
        <span class="sec__m">{{ 5 - skipped.length }} 域有内容{{ skipped.length ? ` · ${skipped.length} 域刻意不做` : ' · 五域齐全' }}</span>
      </div>

      <div v-for="k in STEAM_KEYS" :key="k">
        <!--
          「刻意不做」不是缺漏，是判断。小班的 STEAM 不必五域齐全，
          模型天然想凑满显得完整，规则是宁可诚实标注缺席也不要虚假齐全。
          所以这里要显式呈现，不能悄悄跳过。
        -->
        <div v-if="skipped.includes(k)" class="skip">
          <div class="skip__hd">
            <span class="bd" :class="`bd--${k}`"><span class="bd__t">{{ k }}</span></span>
            <span class="skip__name">{{ STEAM_CN[k] }}</span>
            <span class="skip__cap"><span class="skip__cap-t">刻意不做</span></span>
          </div>
          <span class="skip__why">{{ skipWhy(k) }}</span>
        </div>
        <div v-else class="steam">
          <span class="bd" :class="`bd--${k}`"><span class="bd__t">{{ k }}</span></span>
          <span class="steam__t">{{ steamText(k) }}</span>
        </div>
      </div>

      <!-- 五域的解读挂在整组下面，不是每一域一条 ——
           她真想知道的是「为什么这次不凑齐五个」，那是一个关于整组的判断 -->
      <s-why :text="wh.steam" />

      <div class="hr" />

      <!-- ============ 活动目标 ============ -->
      <!-- 三条，三个维度各一条。维度用中性胶囊不配色 ——
           色板里一个语义只绑一个色，不该为了三个维度再发明三种颜色 -->
      <div class="sec">
        <span class="sec__h">活动目标</span>
        <span class="sec__m">{{ (c.objectives || []).length }} 条</span>
      </div>
      <div v-for="(o, i) in c.objectives || []" :key="`obj-${i}`" class="obj">
        <span v-if="o.dimension" class="obj__d"><span class="obj__d-t">{{ o.dimension }}</span></span>
        <span class="obj__t">{{ o.text }}</span>
      </div>
      <s-why :text="wh.objectives" />

      <!-- ============ 重点与难点 ============ -->
      <template v-if="c.key_points && (c.key_points.focus || c.key_points.difficulty)">
        <div class="hr" />
        <div class="sec"><span class="sec__h">活动重点与难点</span></div>
        <div v-if="c.key_points.focus" class="kp">
          <span class="kp__lb">重点</span>
          <span class="kp__t">{{ c.key_points.focus }}</span>
        </div>
        <div v-if="c.key_points.difficulty" class="kp">
          <span class="kp__lb kp__lb--hard">难点</span>
          <span class="kp__t">{{ c.key_points.difficulty }}</span>
        </div>
        <s-why :text="wh.key_points" />
      </template>

      <!-- ============ 活动准备 ============ -->
      <div class="hr" />
      <div class="sec">
        <span class="sec__h">活动准备</span>
        <span class="sec__m">{{ materials.length }} 样材料</span>
      </div>
      <!-- 经验准备排在物质准备前面：它是老师最容易漏的一节，
           而且逻辑上先有经验才谈得上摆材料 -->
      <template v-if="((c.preparation && c.preparation.experience) || []).length">
        <span class="sub">经验准备</span>
        <div v-for="(x, i) in c.preparation.experience" :key="`exp-${i}`" class="dot">
          <span class="dot__t">{{ x }}</span>
        </div>
      </template>
      <span v-if="materials.length" class="sub sub--gap">物质准备</span>
      <div class="mats">
        <span v-for="(m, i) in materials" :key="`mat-${i}`" class="mat">
          <span class="mat__t">{{ shortMat(m) }}</span>
        </span>
      </div>
      <s-why :text="wh.preparation" />

      <!-- ============ 活动过程 ============ -->
      <div class="hr" />
      <div class="sec">
        <span class="sec__h">活动过程</span>
        <span class="sec__m">{{ (c.flow || []).length }} 环节 · {{ plan.duration_min }} 分钟</span>
      </div>
      <!--
        环节的解读是**逐环节**的（wh.flow_stages 按下标对齐 c.flow），
        整组的那条（wh.flow，讲的是「为什么是这个顺序」）挂在下面。
        `flow_stages` 可能比 flow 短 —— 模型只解读了前几个环节是允许的，
        取不到就是空串，那一块自己不出现。
      -->
      <div v-for="(f, i) in c.flow || []" :key="`flow-${i}`" class="flow">
        <div class="flow__h">
          <span class="flow__stage">{{ f.stage }}</span>
          <span class="flow__min">{{ f.minutes }} 分钟</span>
        </div>
        <p class="flow__d">{{ f.detail }}</p>
        <s-why :text="stageWhy(i)" label="为什么这个环节这么安排" />
      </div>
      <s-why :text="wh.flow" />

      <!-- ============ 活动延伸 ============ -->
      <template v-if="c.extension">
        <div class="hr" />
        <div class="sec"><span class="sec__h">活动延伸</span></div>
        <p class="para">{{ c.extension }}</p>
        <s-why :text="wh.extension" />
      </template>

      <!-- ============ 安全提示 ============ -->
      <div class="hr" />
      <div class="sec">
        <span class="sec__h">安全提示</span>
        <span class="sec__m">{{ (c.safety || []).length }} 条</span>
      </div>
      <div v-for="(x, i) in c.safety || []" :key="`safe-${i}`" class="dot dot--safe">
        <span class="dot__t">{{ x }}</span>
      </div>
      <s-why :text="wh.safety" />

      <!--
        ============ 以下不是教案正文 ============
        《指南》领域指标和教学实例都不是她抄进园里那份表格的东西：
        指标是这个活动碰到了《3-6岁儿童学习与发展指南》的哪些发展条目（研究要用），
        教学实例是一段示例对话。不划开她会以为这两块也得抄进去。
      -->
      <div class="hr hr--label" />
      <span class="divider">下面两块不属于教案正文</span>

      <!-- ============ 《指南》领域指标 ============ -->
      <div class="sec">
        <span class="sec__h">《指南》领域指标</span>
        <span class="sec__m">{{ (c.indicators || []).length }} 条</span>
      </div>
      <div v-for="(x, i) in c.indicators || []" :key="`ind-${i}`" class="dot">
        <span class="dot__t">{{ x }}</span>
      </div>

      <!-- ============ 教学实例 ============ -->
      <template v-if="(c.dialogue || []).length">
        <div class="hr" />
        <div class="sec">
          <span class="sec__h">教学实例（师生对话）</span>
          <span class="sec__m">{{ c.dialogue.length }} 句</span>
        </div>
        <div v-for="(d, i) in c.dialogue" :key="`dlg-${i}`" class="dlg">
          <span class="dlg__who" :class="{ 'dlg__who--c': d.speaker === 'C' }">{{ d.speaker === 'T' ? '老师' : '幼儿' }}</span>
          <span class="dlg__t">{{ d.text }}</span>
        </div>
      </template>
      </template>

      <!-- ============ 活动材料图 ============ -->
      <!-- 集中放在最后。老师是照着这一节去准备东西的，穿插在流程里反而要来回翻 -->
      <div class="hr" />
      <div class="sec">
        <span class="sec__h">配图</span>
        <span class="sec__m">{{ readyImages.length ? `${readyImages.length}/3 张` : '最多 3 张' }}</span>
      </div>

      <div v-for="img in readyImages" :key="img.id" class="mimg">
        <img class="mimg__i" :src="img.url" :alt="img.label || '配图'" @click="preview(img.url)" />
        <div class="mimg__bar">
          <!-- 用途和名字并作一行。像素尺寸删了：老师不看这个，而且没画完时后端还没回宽高，
               原来会渲染成一个光秃秃的「×」 -->
          <span class="mimg__cap">{{ imgCap(img) }}</span>
          <!-- 存下来是为了打印，所以给的是原图不是缩略图 -->
          <button type="button" class="mimg__save" @click="saveOne(img)">
            <span class="mimg__save-t">存下来</span>
          </button>
        </div>
        <!-- 教案改过之后材料清单可能已经不含它了。图不删 —— 她当初觉得值得画才画的 ——
             但要标一句，让她自己判断还用不用得上 -->
        <span v-if="isStale(img)" class="mimg__stale">清单里已经没这一样了</span>
      </div>

      <div v-if="pendingImage" class="imgwait">
        <span class="imgwait__t">正在画「{{ pendingName }}」…约 45 秒</span>
      </div>
      <div v-else-if="!readyImages.length" class="imgph">
        <span class="imgph__t">还没有配图，点底下「配图」</span>
      </div>

      <!-- ============ 评价 ============ -->
      <!-- 「教案是否真的适龄可用」是这个产品最大的未知数，这里是它的持续数据源 -->
      <div class="rate">
        <span class="rate__q">这份教案能直接用吗？</span>
        <div class="rate__ops">
          <button
            v-for="r in RATINGS"
            :key="r.key"
            type="button"
            class="rop"
            :class="{ 'rop--on': rating === r.key }"
            @click="sendRating(r.key)"
          >
            <!-- 选中态不许只靠颜色（黄底压白底 1.61:1）—— design-tokens 规则 3 -->
            <img v-if="rating === r.key" class="rop__ck" :src="checkInk" alt="已选" />
            <span class="rop__t">{{ r.label }}</span>
          </button>
        </div>
        <span v-if="rating" class="rate__done">记下了 —— 这条会跟着这一版存下来。</span>
      </div>

    <!--
      container 自己的那一条操作。「哪里不对？我来改」**不在这里** ——
      它在整条流的最底下（conv.vue 的输入框），因为改稿产生的是流里下一条，
      不是这一份教案内部的事。
    -->
    <div class="pl__ops">
      <button type="button" class="pl__b" @click="openSheet">
        <span class="pl__b-t">{{ pendingImage ? '画着…' : '配图' }}</span>
      </button>
      <button type="button" class="pl__b" @click="doExport">
        <span class="pl__b-t">导出 Word</span>
      </button>
    </div>

    <!--
      配图抽屉。原来是「点按钮 → 材料清单变可点 → 往上滚半屏去点」，
      老师点完按钮人在页面最底下，根本看不到该干什么。抽屉从底下上来，
      选择就在拇指够得着的地方。
    -->
    <s-sheet :visible="sheetOpen" title="配一张图" has-foot @close="sheetOpen = false">
      <!--
        分成「打印用」和「展示用」两组，不是五个平铺的卡片。
        这两组出来的东西根本不是一类：打印用的是黑白线稿（要剪、要写、省墨），
        展示用的是彩色插画（贴墙上看）。后端也是照这个分的（imagePurpose.js 的 kind），
        选错了拿到的东西没法用 —— 所以这个区分要摆在明面上。
      -->
      <div class="sh__sec"><span class="sh__h">印出来干什么用</span></div>
      <div v-for="g in PURPOSE_GROUPS" :key="g.key" class="sh__grp">
        <span class="sh__grp-t">{{ g.label }}</span>
        <div class="sh__purposes">
          <button
            v-for="p in g.items"
            :key="p.key"
            type="button"
            class="sh__p"
            :class="{ 'sh__p--on': purpose === p.key }"
            @click="purpose = p.key"
          >
            <img v-if="purpose === p.key" class="sh__p-ck" :src="checkInk" alt="已选" />
            <span class="sh__p-t" :class="{ 'sh__p-t--on': purpose === p.key }">{{ p.cn }}</span>
          </button>
        </div>
      </div>

      <div class="sh__sec"><span class="sh__h">画什么</span></div>
      <div class="mats">
        <button
          v-for="(m, i) in materials"
          :key="i"
          type="button"
          class="mat mat--pick"
          :class="{ 'mat--on': pickedIndex === i, 'mat--has': hasImageFor(m) }"
          @click="choose(i, m)"
        >
          <span class="mat__t">{{ shortMat(m) }}</span>
          <span v-if="hasImageFor(m)" class="mat__mark">有图</span>
        </button>
      </div>

      <span class="sh__sub sh__sub--gap">或者自己写</span>
      <textarea
        ref="customEl"
        :value="custom"
        class="sh__ta"
        placeholder="例：海洋主题背景墙，中间留白"
        maxlength="200"
        rows="2"
        @input="onCustomInput"
      />

      <template #foot>
        <!-- 45 秒留着：不说她会以为卡住了。分钱成本是我的事，不是她的 -->
        <s-button
          label="画这张 · 约 45 秒"
          arrow
          :disabled="!canDraw"
          :loading="pendingImage"
          loading-text="正在画"
          @press="draw"
        />
        <span class="sh__foot">还能配 {{ leftImages }} 张</span>
      </template>
    </s-sheet>
  </article>
</template>

<script setup>
/**
 * 一份教案 —— 对话流里的一个 container（2026-08-30 用户定）。
 *
 * 它**不自己拉教案**：正文由 conv.vue 传进来，因为那条流还要用同一份数据
 * 判断「写完没有」「现在第几版」。自己再拉一次就是两份事实，迟早对不上。
 *
 * 但配图和评价归它自己管 —— 那两样只跟这一份教案有关，
 * 摆到流那一层等于让流去记「哪一份教案的哪张图画到哪了」。
 * 画完一张图要刷新正文，所以往外抛一个 `reload`。
 */
import { computed, onUnmounted, ref } from 'vue'
import {
  exportLessonPlan,
  pollImage,
  rateLessonPlan,
  requestImage,
} from '../api/lessonPlans.js'
import { iconCheck } from '../utils/icons.js'
import { COLORS } from '../utils/colors.js'
import { downloadImage } from '../utils/saveImage.js'
import { alert, showApiError, toast } from '../utils/ui.js'
import { autogrow } from '../utils/autogrow.js'

const props = defineProps({
  /** 后端 GET /lesson-plans/:id 的整个对象 */
  plan: { type: Object, required: true },
  /** 这是第几版。只用来在胶囊上显示，版本切换归 conv.vue */
  currentVersion: { type: Number, default: 1 },
})

const emit = defineEmits(['reload'])

const checkInk = iconCheck(COLORS.ink, 2.6)
const planId = computed(() => props.plan?.id || 0)

const STEAM_KEYS = ['S', 'T', 'E', 'A', 'M']
const STEAM_CN = { S: '科学', T: '技术', E: '工程', A: '艺术', M: '数学' }
const RATINGS = [
  { key: 'usable', label: '直接能用' },
  { key: 'needs_edit', label: '改改能用' },
  { key: 'unusable', label: '用不了' },
]

const rating = ref('')
const pendingImage = ref(false)
const pendingName = ref('')

/* ============ 配图抽屉 ============ */
// 用途决定构图：记录表要能写字的大格子，头饰要两条能绕头的长带，
// 展示图要网格分隔，背景墙要中间留白。这些不是风格微调，是完全不同的图。
// 键必须跟后端 imagePurpose.js 对上，分组也跟那边的 kind 对上。
const PURPOSE_GROUPS = [
  {
    key: 'print',
    label: '打印用',
    items: [
      { key: 'worksheet', cn: '记录表' },
      { key: 'headwear', cn: '头饰' },
    ],
  },
  {
    key: 'show',
    label: '展示用',
    items: [
      { key: 'material', cn: '材料图' },
      { key: 'display', cn: '展示图' },
      { key: 'backdrop', cn: '环创背景' },
    ],
  },
]
const PURPOSE_CN = Object.fromEntries(
  PURPOSE_GROUPS.flatMap((g) => g.items).map((p) => [p.key, p.cn])
)
const purposeCn = (k) => PURPOSE_CN[k] || '配图'

const sheetOpen = ref(false)
const purpose = ref('material')
const pickedIndex = ref(-1)
const pickedName = ref('')
const custom = ref('')
const customEl = ref(null)

const MAX_IMAGES = 3

let imageHandle = null

const c = computed(() => props.plan?.content_json || {})

/**
 * 改版前生成的教案（2026-08-20 之前）。
 *
 * 判据用 `objectives` 而不是别的：它是新结构里**必然存在**的字段
 * （后端硬校验要求正好 3 条），所以「没有它」就一定是旧格式。
 * 拿 `materials` 反过来判断不行 —— 新结构里那个字段也可能被模型顺手写出来。
 */
const isLegacy = computed(() => Boolean(props.plan) && !Array.isArray(c.value.objectives))

/**
 * 物质准备。新结构在 `preparation.material`，旧的在 `materials`。
 *
 * 两个都读是为了**配图抽屉** —— 她对着一份旧教案点「配图」时，
 * 抽屉里得列得出材料，否则那一屏是空的、只能自己打字描述。
 */
const materials = computed(() => c.value.preparation?.material || c.value.materials || [])

/**
 * 教案解读（学习模式，api-spec 第 5 节）。
 *
 * 效率模式下后端**连这个键都不下发**，所以这里是个空对象，
 * 每个 `<s-why :text="">` 拿到空串就整块不渲染 —— 页面上一个字都不多。
 *
 * 不判断「是不是学习模式」：那等于把同一件事记在两个地方
 * （会话的 mode 和这份教案里有没有解读），而两处迟早不一致。
 * 判据只有一个 —— **有解读就显示**。
 */
const wh = computed(() => c.value.commentary || {})

/**
 * 第 i 个环节的解读。`flow_stages` 按下标对齐 `flow`，但**允许比它短** ——
 * 模型只解读前几个环节是被后端明确允许的（normalizeCommentary 会截到 flow 的长度）。
 * 取不到就返回空串，那一块 s-why 自己不渲染。
 */
function stageWhy(i) {
  const list = wh.value.flow_stages
  return (Array.isArray(list) && list[i]) || ''
}

/** 模型对没涉及的域会写「本次未涉及」，用它判断哪几域是刻意不做 */
const skipped = computed(() =>
  STEAM_KEYS.filter((k) => /未涉及|不涉及|^无$/.test(String(c.value.steam?.[k] || '')))
)

const readyImages = computed(() => (props.plan?.images || []).filter((i) => i.status === 'ready' && i.url))
const leftImages = computed(() => Math.max(0, MAX_IMAGES - readyImages.value.length))

onUnmounted(() => stopImagePoll())

function stopImagePoll() {
  if (imageHandle) {
    imageHandle.stop()
    imageHandle = null
  }
}

/* ============ 渲染小工具 ============ */

// 模型习惯在每域前加「科学：」这种前缀，标注块左边已经有色块和域名了，去掉重复
const steamText = (k) => String(c.value.steam?.[k] || '').replace(/^[科技工艺数][学术程]?[：:]\s*/, '')

/**
 * 「刻意不做」的理由。
 *
 * 后端目前只写「本次未涉及」，没有给理由（lessonGenerator.js 的提示词就是这么定的）。
 * 所以这里给的是**产品规则本身**的复述，不是替模型编教学理由 ——
 * 真正针对这次活动的一句话理由应该由后端产出，那要改 api-spec，先记着。
 */
const skipWhy = () =>
  `${props.plan?.age_group || '这个年龄班'}的孩子还做不到这一域要求的东西，与其硬凑一个做不了的环节，不如如实空着。`

// 材料常写成「大水盆（2个，直径约60cm...）」，胶囊里只留主名
const shortMat = (m) => String(m).replace(/（.*?）/g, '').split('，')[0]

/** 这样材料有没有画过。按名字比，不按下标 —— 改稿之后下标会错位 */
const hasImageFor = (m) => readyImages.value.some((i) => i.label && i.label === shortMat(m))

/**
 * 图下面那行字。
 *
 * label 是后端回的 prompt_cn，长度不设上限：老师自己描述能写 200 字，
 * 早期挂在流程段上的图更是整段教学文字。原样渲染会在图下面堆出一大段，
 * 还把「存下来」挤成两行。这里截断 —— 她要认的是哪张图，不是读一遍提示词。
 */
const imgCap = (img) => {
  const raw = String(img.label || '活动材料').trim()
  const name = raw.length > 12 ? `${raw.slice(0, 12)}…` : raw
  return `${name} · ${purposeCn(img.purpose)}`
}

/**
 * 这张图对不上现在的材料清单了。
 *
 * 必须同时满足「挂在某样材料上」——
 * 只看 purpose 会误判：老师自己描述的图 purpose 也可能是材料图，
 * 但它本来就不在材料清单里，标它「过时」是错的。
 *
 * 两种 section_key 都要认：改版前写的是 `material.N`，之后写 `preparation.material.N`。
 * **旧图的 section_key 一律不动**（「图片永不跟着版本走」是定死的规则），
 * 所以库里两种前缀会长期并存。
 */
const isStale = (img) =>
  /^(preparation\.)?material\.\d+$/.test(String(img.section_key || '')) &&
  Boolean(img.label) &&
  !materials.value.some((m) => shortMat(m) === img.label)

/**
 * 看大图。
 *
 * 小程序那边是 `uni.previewImage`（左右滑、双指放大）。网页里没有等价物，
 * 自己实现一个查看器不值得 —— 新标签页打开原图，浏览器自带缩放，
 * 而且**她本来就要把这张图存下来打印**，多一个标签页正好方便她右键另存。
 */
function preview(url) {
  window.open(url, '_blank', 'noopener')
}

/* ============ 动作 ============ */

async function sendRating(key) {
  const before = rating.value
  rating.value = key
  try {
    await rateLessonPlan(planId.value, { rating: key })
  } catch (err) {
    rating.value = before
    showApiError(err)
  }
}

/* 版本回退搬到 conv.vue 了 —— 在一条流里，「回到上一版」是流的事，不是这个 container 的事 */

/* ============ 材料配图 ============ */

function openSheet() {
  if (pendingImage.value) return
  if (leftImages.value <= 0) {
    // 上限不是成本判断：三张以上老师就不看了，越多越像商品目录、离教案越远
    alert('这份教案已经有 3 张配图了，够用了。')
    return
  }
  pickedIndex.value = -1
  pickedName.value = ''
  custom.value = ''
  purpose.value = 'material'
  sheetOpen.value = true
}

/** 选了材料就把自由输入清掉，反之亦然 —— 两个来源二选一，别让她猜哪个生效 */
function choose(index, material) {
  pickedIndex.value = pickedIndex.value === index ? -1 : index
  pickedName.value = pickedIndex.value >= 0 ? shortMat(material) : ''
  if (pickedIndex.value >= 0) {
    custom.value = ''
    if (customEl.value) customEl.value.value = ''
  }
}

function onCustomInput(e) {
  custom.value = e.target.value
  autogrow(e.target)
  if (custom.value.trim()) {
    pickedIndex.value = -1
    pickedName.value = ''
  }
}

const canDraw = computed(() => Boolean(custom.value.trim() || pickedName.value))

/**
 * 画一张。一次一张 —— 一张要 45 秒，让她排队等三张没意义，
 * 而且画完一张她可能就不想画了。
 */
async function draw() {
  if (pendingImage.value || !canDraw.value) return
  const free = custom.value.trim()
  const name = free || pickedName.value
  pendingImage.value = true
  pendingName.value = name
  sheetOpen.value = false
  try {
    const res = await requestImage(planId.value, {
      purpose: purpose.value,
      // 自由描述时没有材料下标，后端允许缺省。
      // 新结构里材料清单在 preparation.material 下（2026-08-20 改版），
      // 后端两种前缀都认，所以新图写新路径就行
      sectionKey: free ? null : `preparation.material.${pickedIndex.value}`,
      note: name,
    })
    imageHandle = pollImage(planId.value, res.image_id)
    const done = await imageHandle.promise
    imageHandle = null
    if (done.status === 'ready') {
      // 正文归 conv.vue 拉，画完让它重拉一次 —— 新那张图挂在教案对象上
      emit('reload')
      toast(`「${name}」画好了`)
    } else {
      toast('这张没画出来，可以再试一次')
    }
  } catch (err) {
    // 没配图片模型时后端返回 NOT_IMPLEMENTED、超 3 张返回 IMAGE_LIMIT_EXCEEDED，
    // 文案都由后端给，前端照显示
    showApiError(err)
  } finally {
    pendingImage.value = false
    pendingName.value = ''
  }
}

/** 存下来。存的是原图（2048 长边）—— 她要的就是那个大的，拿去打印 */
function saveOne(img) {
  downloadImage(img.url, img.label || '配图')
}

async function doExport() {
  try {
    const res = await exportLessonPlan(planId.value)
    if (res?.url) {
      await navigator.clipboard.writeText(res.url)
      toast('下载链接已复制')
    }
  } catch (err) {
    showApiError(err)
  }
}
</script>

<style lang="scss" scoped>
/*
  container 本身。**要有边界**（2026-08-30 用户定）：一份教案两千多字，
  在一条流里没有边框就跟上下文糊成一片，她看不出「这一整块是一份教案」。

  底色比正文区深一档（$paper-2），不是白 —— 白块在这套奶油底上像一张贴上去的纸，
  而它是流里长出来的东西。
*/
.pl {
  display: block;
  border: 1px solid $rule-2;
  border-radius: $r-card;
  background: $paper-2;
  padding: $sp-4 $sp-4 $sp-3;
  margin: $sp-3 0;
}

.title {
  display: block;
  font-size: var(--fs-title);
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
  line-height: 1.4;
  margin: 8px 0 9px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 14px;
}

.chip {
  display: flex;
  align-items: center;
  border: 1px solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 3px 10px;
  margin: 0 6px 5px 0;

  &--age {
    background: $amber;
    border-color: $amber-line;
  }

  &--saved {
    background: $mint-soft;
    border-color: $mint;
  }

  &--ver {
    background: $sky-soft;
    border-color: $sky;
  }
}

.chip__t {
  font-size: var(--fs-tag);
  color: $ink-2;
  line-height: 1.5;
}

.chip--age .chip__t {
  color: $ink;
  font-weight: 600;
}

/* 「已保存」不只是绿点，旁边有字 —— 颜色不做状态的唯一载体 */
.chip__dot {
  width: 6px;
  height: 6px;
  border-radius: $r-chip;
  background: $mint;
  margin-right: 5px;
}

.chip__t--saved {
  color: $mint-deep;
  font-weight: 600;
}

.sec {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 8px;
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
  margin: 16px 0;

  /* 划开「教案正文」和「特征标注」那一道，比普通分隔线重一档 */
  &--label {
    height: 2px;
    background: $rule-2;
    margin: 22px 0 8px;
  }
}

.divider {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  margin-bottom: 12px;
}

/* 分节里的小标题（经验准备 / 物质准备） */
.sub {
  display: block;
  font-size: var(--fs-sub);
  font-weight: 600;
  color: $ink-2;
  margin-bottom: 6px;

  &--gap {
    margin-top: 12px;
  }
}

/* ============ 活动目标 ============ */
.obj {
  display: flex;
  align-items: flex-start;
  padding: 6px 0;
}

/* 维度用中性胶囊，不配色 —— 色板里一个语义只绑一个色，
   不该为了三个维度再发明三种颜色（design-tokens 规则 4） */
.obj__d {
  flex: none;
  border: 1px solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 1px 7px;
  margin-right: 8px;
  margin-top: 2px;
}

.obj__d-t {
  font-size: var(--fs-tag);
  font-weight: 600;
  color: $ink-2;
  line-height: 1.5;
}

.obj__t {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-read);
  line-height: 1.7;
  color: $ink-2;
}

/* ============ 重点难点 ============ */
.kp {
  display: flex;
  align-items: flex-start;
  margin-bottom: 6px;
}

.kp__lb {
  flex: none;
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $mint-deep;
  border: 1px solid $mint;
  border-radius: $r-chip;
  background: $mint-soft;
  padding: 1px 7px;
  margin-right: 8px;
  margin-top: 2px;

  /* 难点用珊瑚色 —— 它是「要当心的地方」，跟删除那一类的语义同源 */
  &--hard {
    color: $coral-deep;
    border-color: $coral;
    background: $paper-2;
  }
}

.kp__t {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-read);
  line-height: 1.7;
  color: $ink-2;
}

/* ============ 旧格式兜底 ============ */
.legacy {
  background: $sky-soft;
  border: 1px solid $sky-line;
  border-radius: 12px;
  padding: 10px 12px;
  margin-bottom: 12px;
}

.legacy__t {
  font-size: var(--fs-sub);
  color: $sky-deep;
  line-height: 1.7;
}

/* Markdown 原文。不做渲染 —— 为了一批旧教案实现一个 md 渲染器不值得 */
.legacy__md {
  display: block;
  margin: 0;
  white-space: pre-wrap;
  font-size: var(--fs-read);
  color: $ink-2;
  line-height: 1.8;
}

/* ============ STEAM ============ */
.steam {
  display: flex;
  align-items: flex-start;
  padding: 5px 0;
}

.bd {
  flex: none;
  width: 19px;
  height: 19px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 9px;
  margin-top: 2px;

  &--S,
  &--M {
    background: $mint;
  }

  &--T {
    background: $sky;
  }

  &--E {
    background: $amber;
  }

  &--A {
    background: $coral;
  }
}

.bd__t {
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink;
}

.steam__t {
  flex: 1;
  font-size: var(--fs-read);
  line-height: 1.6;
  color: $ink-2;
}

.skip {
  border: 1.5px dashed $rule-2;
  border-radius: 12px;
  padding: 10px 12px;
  margin: 6px 0 4px;
  background: $paper-2;
}

.skip__hd {
  display: flex;
  align-items: center;
  margin-bottom: 5px;
}

.skip__name {
  font-size: var(--fs-read);
  font-weight: 600;
  color: $ink;
  margin-right: 7px;
}

.skip__cap {
  background: $amber;
  border-radius: $r-chip;
  padding: 1px 8px;
}

.skip__cap-t {
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink;
}

.skip__why {
  font-size: var(--fs-tag);
  color: $ink-2;
  line-height: 1.7;
}

/* ============ 材料 ============ */
.mats {
  display: flex;
  flex-wrap: wrap;
}

.mat {
  display: flex;
  align-items: center;
  border: 1px solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 3px 10px;
  margin: 0 6px 6px 0;
}

.mat__t {
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.5;
}

/* 选材料配图时，材料变成可点的 —— 用实边框和暖底提示可点，不只靠颜色 */
.mat--pick {
  background: $amber-soft;
  border-color: $amber-line;

  .mat__t {
    color: $ink;
    font-weight: 600;
  }
}

.mat--has {
  background: $mint-soft;
  border-color: $mint;
}

.mat__mark {
  font-size: var(--fs-tag);
  color: $mint-deep;
  font-weight: 600;
  margin-left: 5px;
}

/* 抽屉里材料被选中 */
.mat--on {
  background: $amber;
  border-color: $amber-line;

  .mat__t {
    color: $ink;
    font-weight: 600;
  }
}

/* ============ 材料图 ============ */
.mimg {
  margin-bottom: 13px;
}

.mimg__i {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 12px;
  border: 1px solid $rule-2;
  background: $paper-2;
  cursor: zoom-in;
}

.mimg__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}

.mimg__cap {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sub);
  color: $ink-2;
  font-weight: 600;
}

.mimg__save {
  flex: none;
  border: 1px solid $mint;
  border-radius: $r-chip;
  background: $mint-soft;
  padding: 5px 12px;
  margin-left: 8px;
}

.mimg__save-t {
  font-size: var(--fs-sub);
  color: $mint-deep;
  font-weight: 600;
}

.mimg__stale {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  margin-top: 2px;
}

/* ============ 流程 ============ */
.flow {
  margin-bottom: 14px;
}

.flow__h {
  display: flex;
  align-items: baseline;
  margin-bottom: 3px;
}

.flow__stage {
  font-size: var(--fs-body);
  font-weight: 600;
  color: $ink;
  margin-right: 8px;
}

.flow__min {
  font-size: var(--fs-tag);
  color: $ink-3;
}

.flow__d {
  margin: 0;
  font-size: var(--fs-read);
  line-height: 1.75;
  color: $ink-2;
}

/* ============ 列表 ============ */
.dot {
  position: relative;
  padding-left: 15px;
  margin-bottom: 5px;
}

.dot::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 9px;
  width: 5px;
  height: 5px;
  border-radius: $r-chip;
  background: $mint;
}

.dot--safe::before {
  background: $coral;
}

.dot__t {
  font-size: var(--fs-read);
  line-height: 1.75;
  color: $ink-2;
}

.para {
  display: block;
  margin: 0;
  font-size: var(--fs-read);
  line-height: 1.75;
  color: $ink-2;
}

/* ============ 对话 ============ */
.dlg {
  margin-bottom: 6px;
}

.dlg__who {
  font-size: var(--fs-sub);
  font-weight: 700;
  color: $sky-deep;
  margin-right: 6px;

  &--c {
    color: $coral-deep;
  }
}

.dlg__t {
  font-size: var(--fs-read);
  line-height: 1.7;
  color: $ink-2;
}

/* ============ 配图 ============ */
.imgph,
.imgwait {
  border: 1px dashed $rule-2;
  border-radius: 12px;
  background: $paper-2;
  padding: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.imgwait {
  background: $sky-soft;
  border-style: solid;
  border-color: $sky-line;
}

.imgph__t,
.imgwait__t {
  font-size: var(--fs-sub);
  color: $ink-3;
}

.imgwait__t {
  color: $sky-deep;
}

/* ============ 评价 ============ */
.rate {
  background: $paper-2;
  border: 1px solid $rule-2;
  border-radius: 14px;
  padding: 12px 13px;
  margin-top: 18px;
}

.rate__q {
  display: block;
  font-size: var(--fs-body);
  font-weight: 600;
  color: $ink;
  margin-bottom: 10px;
}

.rate__ops {
  display: flex;
  gap: 7px;
}

.rop {
  flex: 1;
  border: 1px solid $rule-2;
  border-radius: 12px;
  background: $white;
  padding: 9px 4px;
  display: flex;
  align-items: center;
  justify-content: center;

  &--on {
    background: $amber;
    border-color: $amber-line;
  }
}

.rop__ck {
  width: 11px;
  height: 11px;
  margin-right: 4px;
}

.rop__t {
  font-size: var(--fs-sub);
  color: $ink-2;
}

.rop--on .rop__t {
  color: $ink;
  font-weight: 600;
}

.rate__done {
  display: block;
  font-size: var(--fs-tag);
  color: $mint-deep;
  margin-top: 8px;
}

/* ============ container 自己的操作 ============ */
.pl__ops {
  display: flex;
  gap: 6px;
  margin-top: $sp-4;
  padding-top: $sp-3;
  border-top: 1px solid $rule;
}

.pl__b {
  flex: 1;
  border: 1px solid $rule-2;
  border-radius: 13px;
  background: $paper;
  padding: 9px 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pl__b-t {
  font-size: var(--fs-sub);
  color: $ink-2;
}

/* ============ 配图抽屉 ============ */
.sh__sec {
  padding: 4px 0 7px;
}

.sh__h {
  font-size: var(--fs-sub);
  font-weight: 700;
  color: $ink-2;
  letter-spacing: 0.04em;
}

.sh__sub {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  margin-bottom: 7px;

  &--gap {
    margin-top: 13px;
  }
}

.sh__grp {
  margin-bottom: 4px;
}

.sh__grp-t {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  margin-bottom: 6px;
}

.sh__purposes {
  display: flex;
  flex-wrap: wrap;
}

.sh__p {
  display: flex;
  align-items: center;
  border: 1px solid $rule-2;
  border-radius: 12px;
  background: $white;
  padding: 9px 14px;
  margin: 0 7px 8px 0;

  &--on {
    background: $amber-soft;
    border-color: $amber-line;
    box-shadow: 0 0 0 1px $amber-line;
  }
}

.sh__p-ck {
  width: 11px;
  height: 11px;
  margin-right: 4px;
}

.sh__p-t {
  font-size: var(--fs-read);
  color: $ink-2;

  &--on {
    color: $ink;
    font-weight: 600;
  }
}

.sh__ta {
  display: block;
  width: 100%;
  outline: none;
  resize: none;
  border: 1px solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 11px 12px;
  font-size: var(--fs-body);
  line-height: 1.6;
  color: $ink;
  min-height: 55px;
}

.sh__ta::placeholder {
  color: $ink-3;
}

.sh__foot {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  text-align: center;
  margin-top: 6px;
}
</style>
