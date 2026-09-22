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
        <div class="sh__grp-hd">
          <span class="sh__grp-t">{{ g.label }}</span>
          <!--
            打印用那一组的黑白开关（用户 2026-09-21 要的）。
            默认黑白 —— 省墨，而且头饰本来就是要孩子涂色的空心轮廓。
            但记录表有时想要彩色，所以给她一条切换的路。

            ⚠️ 只在打印用那一组出现。展示用是「贴出来看的东西」，
            做成黑白没有意义，摆一个用不上的开关只会让她犹豫。
          -->
          <button
            v-if="g.monoDefault"
            type="button"
            class="sh__mono"
            :class="{ 'sh__mono--off': !mono }"
            @click="mono = !mono"
          >
            {{ mono ? '黑白' : '彩色' }}
          </button>
        </div>
        <div class="sh__purposes">
          <button
            v-for="p in g.items"
            :key="p.key"
            type="button"
            class="sh__p"
            :class="{ 'sh__p--on': purpose === p.key }"
            @click="pickPurpose(g, p)"
          >
            <img v-if="purpose === p.key" class="sh__p-ck" :src="checkInk" alt="已选" />
            <span class="sh__p-t" :class="{ 'sh__p-t--on': purpose === p.key }">{{ p.cn }}</span>
          </button>
        </div>
      </div>

      <div class="sh__sec">
        <span class="sh__h">推荐</span>
        <!--
          🔴 **选中几样要说出来。** 多选之后「一张纸上会排几个格子」是她最该
          知道的事 —— 而她看不出自己选了几样（勾选是一回事，
          排成几格是另一回事）。这一行就是那句话。

          ⚠️ 只在**她选了**的时候出现。一条都没选时写「可以选好几样」
          是一句解释性小字，而这类小字这个项目删过很多次。
        -->
        <span v-if="picked.length" class="sh__note">
          选了 {{ picked.length }} 样，会排在一张纸上，印出来剪开
        </span>
        <!-- 旧教案兜底那条路要说一句，因为它的条目是从材料清单里来的 -->
        <span v-else-if="!hasPlans" class="sh__note">从材料清单里挑</span>
      </div>

      <!--
        **列表，不是胶囊**（用户 2026-09-21 定）。
        胶囊排不下「印出来干什么用」那行小字，而且一行只放得下两三个，
        名字一长就得换行 —— 排版跟着内容变。
        竖排列表还能左对齐，跟这一屏别的地方一致。

        ⚠️ **行首必须有一个真勾选框**，不能只靠底色 ——
        这个项目的规矩是「颜色不做状态的唯一载体」。
      -->
      <div v-if="hasPlans" class="plans">
        <!--
          **一条 = 一张纸**（2026-09-21 用户定）。
          模型已经把「能凑到一张纸上的几样」配好了，她只要挑一张 ——
          所以这里是**单选卡片**，不是多选列表。
          ⚠️ 点第二张会换掉第一张（单选），**不是拼在一起** ——
          勾两条本来就该是画两张、花两次配额。
        -->
        <button
          v-for="(p, i) in illustrables"
          :key="i"
          type="button"
          role="radio"
          :aria-checked="pickedPlan === i ? 'true' : 'false'"
          class="plan"
          :class="{ 'plan--on': pickedPlan === i }"
          @click="pickPlan(i)"
        >
          <span class="plan__box" :class="{ 'plan__box--on': pickedPlan === i }">
            <img v-if="pickedPlan === i" class="plan__ck" :src="checkInk" alt="" />
          </span>
          <span class="plan__body">
            <span class="plan__t">{{ p.title }}</span>
            <!-- 这一张纸上**画什么**。是她最需要看的一行 —— 卡片里必须留着 -->
            <span class="plan__what">{{ p.what }}</span>
            <span v-if="p.why" class="plan__why">{{ p.why }}</span>
          </span>
        </button>
      </div>

      <!--
        旧教案（没有 `illustrable`）走兜底那条路：从材料清单里**多选几样**，
        后端按顿号切分排成裁切网格。
        ⚠️ 这条路**不改成卡片** —— 那些条目是「材料」，不是「一张纸的方案」，
        硬套卡片形状会让她以为「选这样材料就是画这一张」。
      -->
      <div v-else class="list">
        <button
          v-for="item in options"
          :key="optionLabel(item)"
          type="button"
          role="checkbox"
          :aria-checked="isPicked(item) ? 'true' : 'false'"
          class="row"
          :class="{ 'row--on': isPicked(item) }"
          @click="choose(item)"
        >
          <span class="row__box" :class="{ 'row__box--on': isPicked(item) }">
            <img v-if="isPicked(item)" class="row__ck" :src="checkInk" alt="" />
          </span>
          <span class="row__body">
            <span class="row__t">{{ optionLabel(item) }}</span>
          </span>
          <span v-if="hasImageFor(item)" class="row__mark">有图</span>
        </button>
      </div>

      <!--
        「自己写」这栏**点上面的卡片会被填进来**（2026-09-21 用户要的）——
        所以它不是一个「或者」的备选，而是**她改那张纸的地方**。
        标签跟着改成「想改哪里直接改」，不然她会以为这是第三条路。
        ⚠️ 没有卡片可选时（旧教案）它仍是原来那个「自己描述」的入口。
      -->
      <span class="sh__sub sh__sub--gap">{{ hasPlans ? '想改哪里，直接改' : '或者自己写' }}</span>
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
import { computed, nextTick, onUnmounted, ref } from 'vue'
import {
  exportLessonPlan,
  pollImage,
  requestImage,
} from '../api/lessonPlans.js'
import { iconCheck } from '../utils/icons.js'
import { useUnsavedChanges } from '../utils/unsaved.js'
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
const pendingImage = ref(false)
const pendingName = ref('')

/* ============ 配图抽屉 ============ */
/**
 * 用途决定构图：记录表要能写字的大格子，头饰要两条能绕头的长带，
 * 故事图要一幅完整场景，环创要中间留白。这些不是风格微调，是完全不同的图。
 *
 * 🔴 **键必须跟后端 `imagePurpose.js` 的 `PURPOSES` 对上** ——
 * 对不上的表现是后端 `resolvePurpose` 悄悄退到「材料图」，
 * 然后她选「记录表」拿到一张材料图，而**不报错**。
 *
 * ⚠️ **分组（`print` / `show`）是界面的事，后端没有这个字段**（2026-09-21 定的）。
 * 后端只管「这个用途要什么构图」，而「它属于打印用还是展示用」是**给老师看的分类**。
 * 后端加一份就是同一个概念记两处，迟早分叉。
 *
 * ⚠️ 分组**不再等于黑白**（2026-09-21 用户改的）：
 * 打印用那三类**默认黑白**、但界面上能切彩色（`mono` 那个开关），
 * 所以后端那边「走哪个前缀」也改成跟着她选的颜色走了。
 */
const PURPOSE_GROUPS = [
  {
    key: 'print',
    label: '打印用',
    /** 这一组默认黑白（省墨、孩子能涂色），但可以切成彩色 */
    monoDefault: true,
    items: [
      { key: 'worksheet', cn: '记录表' },
      { key: 'headwear', cn: '头饰' },
      { key: 'backdrop', cn: '环创' },
    ],
  },
  {
    key: 'show',
    label: '展示用',
    /** 展示用默认彩色。**不给黑白开关** —— 贴出来看的东西做成黑白没意义 */
    monoDefault: false,
    items: [
      { key: 'material', cn: '材料图' },
      { key: 'story', cn: '故事图' },
    ],
  },
]
/** 当前选的是打印用那一组吗 —— 决定要不要发 `color` 给后端 */
const isPrintPurpose = computed(() => (
  PURPOSE_GROUPS.find((g) => g.monoDefault)?.items.some((p) => p.key === purpose.value) ?? false
))

/**
 * 用途的中文名。
 *
 * ⚠️ **`display`（展示图）已经不在上面那两个数组里，但这里必须留着它。**
 * 2026-09-21 用户把它从界面上删了（「它跟材料图是一类的」——
 * 而材料图多选本来就会排成网格，那正是展示图在干的事）。
 * 但**库里还有 3 张 `purpose='display'` 的图**，它们那一栏要显示「展示图 · xxx」。
 * 不留这一条的话，那三张的标签会掉成兜底的「配图」——
 * 而「配图」看不出它是什么，她只会以为图坏了。
 *
 * 🔴 **这份名单要包含「界面上能选的」+「历史图里有过的」**，不是只有前者。
 * 删选项时最容易忘的就是后半句。
 */
const PURPOSE_CN = {
  ...Object.fromEntries(PURPOSE_GROUPS.flatMap((g) => g.items).map((p) => [p.key, p.cn])),
  display: '展示图',
}
const purposeCn = (k) => PURPOSE_CN[k] || '配图'

const sheetOpen = ref(false)
/** 导出中。⚠️ **必须有** —— 一份 1.7MB，弱网下要好几秒，
    没有这个状态她会反复点，点几次就下几份 */
const exporting = ref(false)
const purpose = ref('material')

/**
 * 黑白还是彩色（2026-09-21 用户要的）。
 *
 * 打印用那三类默认黑白（省墨、孩子能涂色），但她随时能切彩色。
 * **这个值跟着用途走**：她切到「展示用」再切回来，黑白要还是黑白 ——
 * 所以它是独立于 `purpose` 的一个状态，不由用途重置。
 *
 * ⚠️ 只有打印用那几类会把它发给后端。展示用的图一律彩色
 * （见 `pickPurpose`），因为贴出来看的东西做成黑白没意义。
 */
const mono = ref(true)

/**
 * 选一个用途。
 *
 * ⚠️ **切换分组时黑白要跟着变**，不能沿用上一组的值 ——
 * 她从「展示用」切到「打印用」时，黑白该回到默认的 `true`，
 * 否则「展示用是彩色」这个状态会漏到打印用上去。
 * 反过来切到展示用时也一样，只是因为展示用不发这个参数，所以看不出区别 ——
 * 但那正是「看不出区别的地方最容易写错」。
 */
function pickPurpose(group, p) {
  purpose.value = p.key
  mono.value = Boolean(group.monoDefault)
}
const custom = ref('')
const customEl = ref(null)
useUnsavedChanges(() => sheetOpen.value && Boolean(custom.value.trim()))

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
 * 「画什么」那一栏的候选。
 *
 * 🔴 **优先用 `illustrable`**（2026-09-21 加的）—— 那是模型专门挑出来的
 * 「值得画成一张图的东西」，通常 1-3 条。
 *
 * ⚠️ **没有 `illustrable` 的旧教案要兜底回 `material`。**
 * 那个字段是这次才有的，库里存量教案一个都没有 —— 不兜底的话，
 * 老师对着一份旧教案点「配图」，抽屉里**一条候选都没有**，
 * 只能自己打字描述（而那是最不好用的那条路）。
 *
 * ⚠️ **两者不是一回事，别混着用**：
 *   `material`     给老师备料用的清单，混着「胶带 6 卷」这类耗材
 *   `illustrable`  值得画成图的，带一句「印出来干什么用」
 * 兜底那一路只能退回「短名」显示（`shortMat`），质量差但总比空着好。
 */
const illustrables = computed(() => c.value.illustrable || [])

/**
 * 「推荐」那一栏的候选 —— **旧教案那条路**（没有方案，只能从材料清单里挑）。
 *
 * ⚠️ 有方案的时候**不用这个**，直接用 `illustrables`。
 * 留着它是为了兜底：旧的教案没有 `illustrable` 字段，
 * 不兜底的话她点「配图」会看到**一栏空的**，只能自己打字。
 */
const options = computed(() => materials.value)

/** 旧教案那条路上，选项显示成什么（砍掉括号、取第一个逗号前） */
const optionLabel = (item) => (item && typeof item === 'object' ? item.what : shortMat(item))

/* 三条推荐**就是三张卡片**（2026-09-21 从「多选列表」改成「单选卡片」）。

   🔴 **为什么不是多选**：用户要的是「一条 = 一张纸的完整方案」——
   模型已经把「能凑到一张纸上的几样」替她配好了，她只要挑一张。
   而多选会让她以为「勾两条 = 拼成一张」，**那是错的**：
   勾两条本来是画两张、花两次配额。
   想自己拼的时候走底下那个「或者自己写」，那条路是明确的一段文字。

   ⚠️ 旧教案没有 `illustrable`，退回材料清单那条路 ——
   那种情况下没有「方案」可言，退回**多选**（勾几样排成裁切网格），
   因为那正是材料清单本来的用法。两条路的交互不一样，是有意的：
   有方案时她是在**挑一张纸**，没方案时她是在**挑几样东西**。 */

/** 选中的**那一条方案**的下标（单选）。-1 = 没选 */
const pickedPlan = ref(-1)

/** 旧教案那条路仍然多选（挑几样东西，不是挑一张纸） */
const picked = ref([])

/** 选中的方案对象，没有就是 null */
const chosenPlan = computed(() => illustrables.value[pickedPlan.value] || null)

/** 当前有没有模型配好的方案 */
const hasPlans = computed(() => illustrables.value.length > 0)

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

/**
 * 这条有没有画过。按名字比，不按下标 —— 改稿之后下标会错位。
 *
 * ⚠️ 用 `optionLabel` 而不是 `shortMat` —— 两条路传进来的东西形状不同
 * （`illustrable` 是对象、`material` 是字符串），而 `shortMat` 对对象
 * 会返回 `[object Object]`，那样**永远比不中，标签就永远不出现**。
 */
const hasImageFor = (item) => {
  const name = optionLabel(item)
  return readyImages.value.some((i) => i.label && i.label === name)
}

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
  /* ⚠️ `options` 而不是 `materials` —— 一份新教案的候选来自 `illustrable`，
     拿 `materials` 比的话**每一张图都会被标成「过时」**（标签对不上）。
     兜底那一路 `options` 就是 `materials`，所以旧教案的行为没变。 */
  !options.value.some((o) => optionLabel(o) === img.label)

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


/* 版本回退搬到 conv.vue 了 —— 在一条流里，「回到上一版」是流的事，不是这个 container 的事 */

/* ============ 材料配图 ============ */

function openSheet() {
  if (pendingImage.value) return
  if (leftImages.value <= 0) {
    // 上限不是成本判断：三张以上老师就不看了，越多越像商品目录、离教案越远
    alert('这份教案已经有 3 张配图了，够用了。')
    return
  }
  pickedPlan.value = -1
  picked.value = []
  custom.value = ''
  purpose.value = 'material'
  sheetOpen.value = true
}

/**
 * 挑一张方案（**单选**）。
 *
 * 🔴 **点一张就把它的内容填进「自己写」**（2026-09-21 用户要的）——
 * 因为模型写的那段虽然具体，但**她的班可能不一样**：
 * 小班格子要更大、这次不想画材料、想加一样东西…她多半要改几个字。
 * 填进去之后她就能直接改，而不用自己从头描述一遍。
 *
 * ⚠️ 这也让「两个来源」不再是二选一 —— 原来选了卡片就清空输入框，
 * 现在是**卡片负责起个头、输入框负责让她改**。所以：
 *   · 填进去的是方案的 `what`（那张纸画什么的完整描述），不是 title
 *   · 点另一张 = 换过去，输入框跟着换（她的改动会被覆盖，
 *     而这是对的 —— 她点的是「我要那一张」，不是「在原来那份上接着改」）
 *   · 再点同一张 = 取消，输入框**不清空**（她可能已经改了一半，
 *     而清掉是不可逆的；留着的话她按「画这张」还能画）
 */
function pickPlan(i) {
  pickedPlan.value = pickedPlan.value === i ? -1 : i
  const p = illustrables.value[i]
  /* 填进去的时候**带上「印出来干什么用」那一行** ——
     后端 `countSubjects` 按顿号切分数「这张纸排几样」，
     而 `why` 里那个「给孩子填」不含顿号，不会干扰计数。 */
  const text = p ? `${p.what}${p.why ? `（${p.why}）` : ''}` : ''
  custom.value = text
  // ⚠️ 必须同时写 DOM 那个 textarea —— 它是 `:value` 绑定的（不是 v-model），
  // 只改 `custom` 的话框里显示的还是旧内容，「填进去」这件事她看不见
  if (customEl.value) {
    customEl.value.value = text
    /* `nextTick` 里再判一次 —— 抽屉关掉时这个 ref 会变成 null，
       而 `autogrow(null)` 会抛。加一道保险比赌它不抛便宜。 */
    nextTick(() => { if (customEl.value) autogrow(customEl.value) })
  }
}

/** 旧教案那条路：点一样材料 —— 多选，再点一次取消 */
function choose(item) {
  const name = optionLabel(item)
  const at = picked.value.indexOf(name)
  if (at >= 0) picked.value.splice(at, 1)
  else picked.value.push(name)
  if (picked.value.length) {
    custom.value = ''
    if (customEl.value) customEl.value.value = ''
  }
}

/** 这一条材料勾了没有（旧教案那条路用） */
const isPicked = (item) => picked.value.includes(optionLabel(item))

function onCustomInput(e) {
  custom.value = e.target.value
  autogrow(e.target)

  /* 🔴 **改字不再取消卡片的选择**（2026-09-21 改）。
   *
   * 原来是这样：她一动输入框就把 `pickedPlan` 清成 -1。而点卡片会**把内容填进
   * 输入框**（见 `pickPlan`），所以「点一张卡片、改两个字」这个最自然的动作
   * 会让**卡片的高亮消失** —— 看起来像「我把选择弄丢了」，而实际上内容还在。
   * 更糟的是 `canDraw` 那时靠的是输入框非空，所以按钮还亮着 ——
   * 高亮没了、按钮还在，那个状态她读不懂。
   *
   * 现在的规则：**输入框和卡片是同一件事的两个视图** ——
   * 卡片负责起头、输入框负责改。改字不清卡片。
   *
   * ⚠️ 只有**旧教案那条路的多选**要清：那条路上「勾了哪几样」和
   * 「输入框里写什么」真的是两个来源（一个是材料清单、一个是自由描述），
   * 二选一才不会让她猜哪个生效。 */
  if (custom.value.trim()) picked.value = []
}

/**
 * 能不能画。
 *
 * ⚠️ 有方案时判「选中一张」；旧教案那条路判「勾了几样」而且**上限 9 样**
 * （跟后端 `countSubjects` 的上限一致）—— 超了会被后端截掉，
 * 而「我选了 10 样、只出来 9 个格子」她数不出来。
 */
const MAX_SUBJECTS = 9
const canDraw = computed(() => Boolean(
  custom.value.trim()
  || pickedPlan.value >= 0
  || (picked.value.length > 0 && picked.value.length <= MAX_SUBJECTS)
))

/**
 * 提交时那张图挂在教案哪一处。
 *
 * ⚠️ 有方案时**传 `illustrable.N`** —— 那是这一条方案在数组里的位置。
 * ⚠️ 旧教案那条路：只写**第一条**材料的下标，因为 `section_key` 的语义是
 * 「这张图挂在教案哪一处」，而一张排了 6 样的裁切纸对应不到单个下标。
 * 真正可靠的永远是 `note`（后端 `materialName` 里 `if (note) return note`
 * 直接短路），这个只是 note 丢了之后的兜底。
 */
function firstSectionKey() {
  if (hasPlans.value) {
    return pickedPlan.value >= 0 ? `illustrable.${pickedPlan.value}` : null
  }
  if (!picked.value.length) return null
  const at = materials.value.findIndex((x) => optionLabel(x) === picked.value[0])
  return at < 0 ? null : `preparation.material.${at}`
}

/**
 * 画一张。一次一张 —— 一张要 45 秒，让她排队等三张没意义，
 * 而且画完一张她可能就不想画了。
 */
async function draw() {
  if (pendingImage.value || !canDraw.value) return
  const free = custom.value.trim()

  /* 🔴 **`note` 就是提示词里那句「画什么」，它是后端唯一拿得到的内容。**
   *
   * 🔴 **输入框优先**（2026-09-21 改）。原来是「卡片优先、输入框为空」，
   * 而现在**点卡片会把内容填进输入框**（见 `pickPlan`）——
   * 所以输入框里那份就是她最终要的：卡片起头、她改过几个字。
   * 反过来（卡片优先）会**把她的改动吃掉**，而且看不出为什么。
   *
   * 三条来源，按优先级：
   *   ① `custom` —— 她自己写的，或者点卡片填进去之后改过的
   *   ② 旧教案那条路勾的几样，用「、」连起来 ——
   *      后端 `countSubjects` 就是按顿号切分**数出这张纸要排几样**的，
   *      然后排成裁切网格。换个分隔符也能认，但顿号是中文里最自然的那个
   *   ③ 兜底：选中那张方案的 `what`（她可能把输入框清空了）
   *
   * ⚠️ 这一句是「一张图排好几样」那条链路的**唯一入口** ——
   * 把它改成不切分的写法，多选会静默退化成「只画第一样」。 */
  const name = free
    || picked.value.join('、')
    || (hasPlans.value ? (chosenPlan.value?.what || '') : '')

  pendingImage.value = true
  pendingName.value = name
  sheetOpen.value = false
  try {
    const res = await requestImage(planId.value, {
      /* 🔴 **有方案时用途换成 `plan`**（2026-09-21 修）。
       *
       * 用户报的那张图：他选了「材料图」，写了一整段「上半记录表 + 下半材料图卡」，
       * 而材料图的规则写死「one single object drawn large and centered」——
       * **我们给的构图指令跟她的描述直接打架**，他写的记录表那半张被挤掉了。
       *
       * `plan` 那个用途**什么都不预设**，把构图完全交还给描述。
       * 所以：有方案走 `plan`，旧教案那条路（勾材料）才走她自己选的用途。 */
      purpose: hasPlans.value ? 'plan' : purpose.value,
      /* `plan: true` 告诉后端「note 是一段完整描述，别数它有几样、别排网格」——
         后端原来按顿号逗号数出「几样」再排裁切网格，
         而那段描述里的逗号是**句读**不是**并列**，数出 9 样排成 3×3。 */
      plan: hasPlans.value,
      /* 只有「打印用」那几类发这个参数 —— 展示用的图一律彩色，
         传 null 让后端按用途自带的 kind 判（跟改之前的行为一样）。
         ⚠️ 别写成 `mono.value ? false : true` 之后又对展示用也发 ——
         那样「展示用」会变成黑白，而贴出来看的东西做成黑白没意义。 */
      color: isPrintPurpose.value ? !mono.value : null,
      /* 自由描述时没有下标，后端允许缺省。
         🔴 **两条路的前缀不一样，不能都写 `material`**：
           有 `illustrable` 时下标指的是 `content_json.illustrable[i]`，
           写成 `material.i` 会指到另一个数组的另一个位置上去。

         ⚠️ 多选时只写**第一个**下标 —— `section_key` 是「这图挂在教案哪一处」
         那个语义（用来在改稿后判断「这张图是不是过时了」），
         而一张排了 6 样的裁切纸没法对应到单个下标。
         真正可靠的永远是 `note`（后端 `materialName` 里 `if (note) return note`
         直接短路），下标只是 note 丢了之后的兜底。 */
      sectionKey: free ? null : firstSectionKey(),
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

/**
 * 导出 Word。
 *
 * 🔴 **后端回的是文件本身，不是链接**（2026-09-21 改的）。
 * 原来那段注释是按对象存储写的（「传上去 → 回一个 1 小时有效的预签名 URL」），
 * 而用户定了不上对象存储 —— 那么当场生成、当场下载最省事，
 * 也少一类「链接过期了打不开」的故障。
 *
 * ⚠️ 接口是 `POST`，所以**不能用 `window.open` 或 `<a href>`** ——
 * 浏览器直开链接发不出 POST。只能 `fetch` 拿 blob，再用一个临时的
 * `<a download>` 触发保存。文件名从响应头的 `Content-Disposition` 里取，
 * 因为后端拼的时候带了班级和年龄班（她一天导好几份，都叫「教案.docx」
 * 的话在下载文件夹里分不出哪个是哪个）。
 */
async function doExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    const { blob, filename } = await exportLessonPlan(planId.value)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    /* 🔴 **必须 revoke**，否则那份 blob 会一直占着内存到页面关掉。
       一份 1.7MB，她连导几份就是十几 MB —— 手机上会被系统杀后台。 */
    URL.revokeObjectURL(url)
  } catch (err) {
    showApiError(err)
  } finally {
    exporting.value = false
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
/* 教案正文里「物质准备」那一栏（只读）。配图抽屉用的列表在下面 `.list`。 */
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

/* ============ 配图抽屉里「推荐」的卡片 ============ */
/*
  **一条 = 一张纸**，所以是一条**卡片**，不是列表里的一行。
  卡片能放下三行（名字 / 画什么 / 干什么用），而列表行只能放两行 ——
  而「这张纸上画什么」正是她要读的那一行，不能省。

  ⚠️ 卡片之间要有间距（下面 `.plan + .plan` 那个 margin-top）——
  贴着排会看起来像一个整体，而她要在几张之间挑一张。
*/
.plans {
  margin-top: 8px;
}

.plan {
  display: flex;
  align-items: flex-start;
  width: 100%;
  text-align: left;
  background: $paper-2;
  border: 1px solid $rule-2;
  border-radius: $r-card;
  padding: 11px 12px;
}

.plan + .plan {
  margin-top: 8px;
}

/* 选中：底色 + 边框 + **勾**，三重（颜色不做状态的唯一载体） */
.plan--on {
  background: $amber-soft;
  border-color: $amber-line;
}

/* 单选圈。跟多选的方框区分开 —— 形状本身在说「只能选一个」 */
.plan__box {
  flex: none;
  width: 18px;
  height: 18px;
  box-sizing: border-box;
  margin: 2px 10px 0 0;
  border: 1.5px solid $rule-2;
  border-radius: 50%;
  background: $white;
  display: flex;
  align-items: center;
  justify-content: center;
}

.plan__box--on {
  background: $amber;
  border-color: $amber-line;
}

.plan__ck {
  width: 11px;
  height: 11px;
}

.plan__body {
  display: block;
  flex: 1;
  min-width: 0;
}

.plan__t {
  display: block;
  font-size: var(--fs-body);
  font-weight: 600;
  color: $ink;
  line-height: 1.5;
}

/* 「这张纸上画什么」—— 卡片里最该读的一行 */
.plan__what {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.6;
  margin-top: 3px;
}

.plan__why {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.4;
  margin-top: 3px;
}

/* ============ 旧教案兜底：材料清单那条路（多选列表） ============ */
.list {
  display: block;
  margin-top: 8px;
}

.row {
  display: flex;
  align-items: flex-start;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-bottom: 1px solid $rule-2;
  padding: 10px 2px;
}

.row:last-child {
  border-bottom: none;
}

/* 类别的小标题（记录表 / 头饰 / 材料图） */
.list__grp {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  margin: 12px 0 2px;
}

.list__grp:first-child {
  margin-top: 2px;
}

/*
  🔴 **勾选框要画出来，不能只靠底色。**
  这个项目的规矩是「颜色不做状态的唯一载体」（design-tokens.md），
  而「勾了没有」正是最容易只靠颜色表达的那种状态 ——
  选中胶囊那次的教训就是靠色相差 1.51:1 区分，色觉障碍者拿不到那一维。
*/
.row__box {
  flex: none;
  width: 18px;
  height: 18px;
  box-sizing: border-box;
  margin: 1px 10px 0 0;
  border: 1.5px solid $rule-2;
  border-radius: 4px;
  background: $white;
  display: flex;
  align-items: center;
  justify-content: center;
}

.row__box--on {
  background: $amber;
  border-color: $amber-line;
}

.row__ck {
  width: 11px;
  height: 11px;
}

.row__body {
  display: block;
  flex: 1;
  min-width: 0;
}

.row__t {
  display: block;
  font-size: var(--fs-body);
  color: $ink;
  line-height: 1.5;
}

/** 勾上的那一行字重加一档 —— 又一处不靠颜色的状态载体 */
.row--on .row__t {
  font-weight: 600;
}

/** 「印出来干什么用」那行小字（「给孩子填」「剪下来戴」） */
.row__sub {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.4;
  margin-top: 1px;
}

/** 「有图」那个标记。跟文字同排，因为列表的行高够 */
.row__mark {
  flex: none;
  font-size: var(--fs-tag);
  color: $mint-deep;
  font-weight: 600;
  margin-left: 8px;
  align-self: center;
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

/* ============ 底下那两个动作（配图 / 导出 Word） ============ */
/*
  🔴 **这两个按钮原来没排成一行**（用户 2026-09-21 报：「横排放，宽度和高度一致」）。

  根因：`.pl__ops` **根本没有样式** —— 它是个块级 div，
  所以里面两个 `<button>` 各占一行；而 `.pl__b` 上那个 `flex: 1`
  是给 flex 子项用的，**在一个非 flex 父元素里完全没生效**。
  「两行堆着、宽度还不一样」就是这么来的。

  ⚠️ 教训：`flex: 1` 写在子元素上、而父元素没 `display: flex` 时，
  它**静默失效** —— 不报错、也不给提示。这类「某个属性悄悄没生效」
  只能靠肉眼看出来。
*/
.pl__ops {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.pl__b {
  flex: 1;
  /* 等宽之后高度还要一致 —— 两个按钮字一样多，不给 min-height 也行，
     但 `I配有图` 那种状态文字长短会变，给一个固定高度更稳 */
  min-height: 38px;
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

/* 分组标题那一行：左边「打印用」，右边黑白开关 */
.sh__grp-hd {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;
}

.sh__grp-t {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
}

/*
  黑白 / 彩色开关（只在「打印用」那一组出现）。
  ⚠️ **它不是胶囊、不跟用途按钮长得一样** —— 两者做同一件事的样子会让她
  以为「黑白」也是一个用途。做成一枚小字按钮，跟分组标题同排。
*/
.sh__mono {
  background: none;
  border: 1px solid $rule-2;
  border-radius: $r-chip;
  padding: 1px 8px;
  font-size: var(--fs-tag);
  color: $ink-2;
}

/* 切到彩色时用暖黄 —— 跟主行动一个色系，但不那么重 */
.sh__mono--off {
  background: $amber-soft;
  border-color: $amber-line;
  color: $amber-deep;
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
