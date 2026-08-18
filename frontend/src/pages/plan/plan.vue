<template>
  <s-page :dock="Boolean(plan)">
    <template #top>
      <s-topbar :title="plan ? '教案成稿' : '教案'" />
    </template>

    <!-- 加载中 -->
    <template v-if="!plan && !loadError">
      <view class="sk sk--title" />
      <view class="sk sk--chips" />
      <view class="sk sk--para" />
      <view class="sk sk--para" />
      <view class="sk sk--para sk--short" />
    </template>

    <template v-else-if="loadError">
      <text class="err">{{ loadError.message }}</text>
      <s-button label="重试" variant="plain" @press="load" />
    </template>

    <template v-else>
      <text class="title">{{ c.title || plan.title }}</text>

      <view class="chips">
        <view class="chip chip--age"><text class="chip__t">{{ plan.age_group }}</text></view>
        <view class="chip"><text class="chip__t">{{ plan.duration_min }} 分钟</text></view>
        <view class="chip chip--saved">
          <view class="chip__dot" />
          <text class="chip__t chip__t--saved">已保存</text>
        </view>
        <view v-if="plan.version > 1" class="chip chip--ver">
          <text class="chip__t">第 {{ currentVersion }} 版</text>
        </view>
      </view>

      <!--
        版本条。改稿是覆盖式的，不给退路等于逼老师赌一把 —— 她会因此不敢提意见，
        而「改一改」正是这个产品的核心。所以退路必须摆在明面上。
      -->
      <view v-if="versions.length > 1" class="ver">
        <view class="ver__hd">
          <text class="ver__t">这是第 {{ currentVersion }} 版，共 {{ versions.length }} 版</text>
        </view>
        <text v-if="currentNote" class="ver__note">按你说的改的：「{{ currentNote }}」</text>
        <view class="ver__ops">
          <view v-if="prevVersion" class="ver__b" @tap="doRollback(prevVersion.version)">
            <text class="ver__b-t">回到第 {{ prevVersion.version }} 版</text>
          </view>
          <view v-if="latestVersion > currentVersion" class="ver__b" @tap="doRollback(latestVersion)">
            <text class="ver__b-t">回到最新的第 {{ latestVersion }} 版</text>
          </view>
        </view>
        <text class="ver__keep">来回切都行，配图不受影响。</text>
      </view>

      <!-- ============ STEAM 五域 ============ -->
      <view class="sec">
        <text class="sec__h">STEAM 五域标注</text>
        <text class="sec__m">{{ 5 - skipped.length }} 域有内容{{ skipped.length ? ` · ${skipped.length} 域刻意不做` : ' · 五域齐全' }}</text>
      </view>

      <!--
        这里必须用 <view v-for> 而不是 <template v-for>：
        <template v-for :key> 会编译成 <block wx:for wx:key>，而 WXML 不允许
        在 <block> 上写 wx:key —— uni 构建不报错，只有微信开发者工具才会拒，
        表现是「WXML 文件编译错误」一句话、不说哪一行。
      -->
      <view v-for="k in STEAM_KEYS" :key="k">
        <!--
          「刻意不做」不是缺漏，是判断。小班的 STEAM 不必五域齐全，
          模型天然想凑满显得完整，规则是宁可诚实标注缺席也不要虚假齐全。
          所以这里要显式呈现，不能悄悄跳过。
        -->
        <view v-if="skipped.includes(k)" class="skip">
          <view class="skip__hd">
            <view class="bd" :class="`bd--${k}`"><text class="bd__t">{{ k }}</text></view>
            <text class="skip__name">{{ STEAM_CN[k] }}</text>
            <view class="skip__cap"><text class="skip__cap-t">刻意不做</text></view>
          </view>
          <text class="skip__why">{{ skipWhy(k) }}</text>
        </view>
        <view v-else class="steam">
          <view class="bd" :class="`bd--${k}`"><text class="bd__t">{{ k }}</text></view>
          <text class="steam__t">{{ steamText(k) }}</text>
        </view>
      </view>

      <!-- ============ 材料 ============ -->
      <view class="hr" />
      <view class="sec">
        <text class="sec__h">材料清单</text>
        <text class="sec__m">{{ (c.materials || []).length }} 样</text>
      </view>
      <view class="mats">
        <view v-for="(m, i) in c.materials || []" :key="i" class="mat">
          <text class="mat__t">{{ shortMat(m) }}</text>
        </view>
      </view>

      <!-- ============ 流程 ============ -->
      <view class="hr" />
      <view class="sec">
        <text class="sec__h">教学流程</text>
        <text class="sec__m">{{ (c.flow || []).length }} 环节 · {{ plan.duration_min }} 分钟</text>
      </view>
      <view v-for="(f, i) in c.flow || []" :key="i" class="flow">
        <view class="flow__h">
          <text class="flow__stage">{{ f.stage }}</text>
          <text class="flow__min">{{ f.minutes }} 分钟</text>
        </view>
        <!-- 图不再穿插在流程里 —— 它是材料图，属于最后那一节 -->
        <text class="flow__d">{{ f.detail }}</text>
      </view>

      <!-- ============ 指标 ============ -->
      <view class="hr" />
      <view class="sec">
        <text class="sec__h">幼儿学习指标</text>
        <text class="sec__m">{{ (c.indicators || []).length }} 条</text>
      </view>
      <view v-for="(x, i) in c.indicators || []" :key="i" class="dot">
        <text class="dot__t">{{ x }}</text>
      </view>

      <!-- ============ 安全 ============ -->
      <view class="hr" />
      <view class="sec">
        <text class="sec__h">安全事项</text>
        <text class="sec__m">{{ (c.safety || []).length }} 条</text>
      </view>
      <view v-for="(x, i) in c.safety || []" :key="i" class="dot dot--safe">
        <text class="dot__t">{{ x }}</text>
      </view>

      <!-- ============ 师生对话 ============ -->
      <template v-if="(c.dialogue || []).length">
        <view class="hr" />
        <view class="sec">
          <text class="sec__h">教学实例（师生对话）</text>
          <text class="sec__m">{{ c.dialogue.length }} 句</text>
        </view>
        <view v-for="(d, i) in c.dialogue" :key="i" class="dlg">
          <text class="dlg__who" :class="{ 'dlg__who--c': d.speaker === 'C' }">{{ d.speaker === 'T' ? '老师' : '幼儿' }}</text>
          <text class="dlg__t">{{ d.text }}</text>
        </view>
      </template>

      <!-- ============ 延伸 ============ -->
      <template v-if="c.extension">
        <view class="hr" />
        <view class="sec"><text class="sec__h">延伸活动</text></view>
        <text class="para">{{ c.extension }}</text>
      </template>

      <!-- ============ 活动材料图 ============ -->
      <!-- 集中放在最后。老师是照着这一节去准备东西的，穿插在流程里反而要来回翻 -->
      <view class="hr" />
      <view class="sec">
        <text class="sec__h">配图</text>
        <text class="sec__m">{{ readyImages.length ? `${readyImages.length}/3 张` : '最多 3 张' }}</text>
      </view>

      <view v-for="img in readyImages" :key="img.id" class="mimg">
        <image class="mimg__i" :src="img.url" mode="widthFix" @tap="preview(img.url)" />
        <view class="mimg__bar">
          <!-- 用途和名字并作一行。像素尺寸删了：老师不看这个，而且没画完时后端还没回宽高，
               原来会渲染成一个光秃秃的「×」 -->
          <text class="mimg__cap">{{ imgCap(img) }}</text>
          <!-- 存下来是为了打印，所以给的是原图不是缩略图 -->
          <view class="mimg__save" @tap="saveOne(img)">
            <text class="mimg__save-t">存到相册</text>
          </view>
        </view>
        <!-- 教案改过之后材料清单可能已经不含它了。图不删 —— 她当初觉得值得画才画的 ——
             但要标一句，让她自己判断还用不用得上 -->
        <text v-if="isStale(img)" class="mimg__stale">清单里已经没这一样了</text>
      </view>

      <view v-if="pendingImage" class="imgwait">
        <text class="imgwait__t">正在画「{{ pendingName }}」…约 45 秒</text>
      </view>
      <view v-else-if="!readyImages.length" class="imgph">
        <text class="imgph__t">还没有配图，点底下「配图」</text>
      </view>

      <!-- ============ 评价 ============ -->
      <!-- 「教案是否真的适龄可用」是这个产品最大的未知数，这里是它的持续数据源 -->
      <view class="rate">
        <text class="rate__q">这份教案能直接用吗？</text>
        <view class="rate__ops">
          <view
            v-for="r in RATINGS"
            :key="r.key"
            class="rop"
            :class="{ 'rop--on': rating === r.key }"
            @tap="sendRating(r.key)"
          >
            <text class="rop__t">{{ r.label }}</text>
          </view>
        </view>
        <text v-if="rating" class="rate__done">记下了 —— 这条会跟着这一版存下来。</text>
      </view>
    </template>

    <template #dock>
      <s-button label="哪里不对？我来改" arrow @press="goRevise" />
      <view class="row">
        <view class="row__b" @tap="openSheet">
          <text class="row__t">{{ pendingImage ? '画着…' : '配图' }}</text>
        </view>
        <view class="row__b" @tap="doExport"><text class="row__t">导出</text></view>
        <view class="row__b" @tap="backToLibrary"><text class="row__t">教案库</text></view>
      </view>
    </template>

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
        选错了拿到的东西没法用 —— 所以这个区分要摆在明面上，而不是靠卡片下面一行小字解释。
      -->
      <view class="sh__sec"><text class="sh__h">印出来干什么用</text></view>
      <view v-for="g in PURPOSE_GROUPS" :key="g.key" class="sh__grp">
        <text class="sh__grp-t">{{ g.label }}</text>
        <view class="sh__purposes">
          <view
            v-for="p in g.items"
            :key="p.key"
            class="sh__p"
            :class="{ 'sh__p--on': purpose === p.key }"
            @tap="purpose = p.key"
          >
            <text class="sh__p-t" :class="{ 'sh__p-t--on': purpose === p.key }">{{ p.cn }}</text>
          </view>
        </view>
      </view>

      <view class="sh__sec"><text class="sh__h">画什么</text></view>
      <view class="mats">
        <view
          v-for="(m, i) in c.materials || []"
          :key="i"
          class="mat mat--pick"
          :class="{ 'mat--on': pickedIndex === i, 'mat--has': hasImageFor(m) }"
          @tap="choose(i, m)"
        >
          <text class="mat__t">{{ shortMat(m) }}</text>
          <text v-if="hasImageFor(m)" class="mat__mark">有图</text>
        </view>
      </view>

      <text class="sh__sub sh__sub--gap">或者自己写</text>
      <textarea
        :value="custom"
        class="sh__ta"
        placeholder="例：海洋主题背景墙，中间留白"
        placeholder-class="sh__ph"
        :maxlength="200"
        :auto-height="true"
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
        <text class="sh__foot">还能配 {{ leftImages }} 张</text>
      </template>
    </s-sheet>
  </s-page>
</template>

<script setup>
import { computed, ref } from 'vue'
import { onLoad, onShow, onUnload } from '@dcloudio/uni-app'
import {
  exportLessonPlan,
  getLessonPlan,
  getVersions,
  pollImage,
  rateLessonPlan,
  requestImage,
  rollback,
} from '../../api/lessonPlans.js'
import { navTo, reLaunch } from '../../utils/nav.js'
import { saveImageToAlbum } from '../../utils/saveImage.js'
import { showApiError, toast } from '../../utils/ui.js'

const STEAM_KEYS = ['S', 'T', 'E', 'A', 'M']
const STEAM_CN = { S: '科学', T: '技术', E: '工程', A: '艺术', M: '数学' }
const RATINGS = [
  { key: 'usable', label: '直接能用' },
  { key: 'needs_edit', label: '改改能用' },
  { key: 'unusable', label: '用不了' },
]

const planId = ref(0)
const conversationId = ref(0)
const plan = ref(null)
const loadError = ref(null)
const rating = ref('')
const pendingImage = ref(false)
const pendingName = ref('')
const versions = ref([])
const currentVersion = ref(1)

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

const MAX_IMAGES = 3

let imageHandle = null

const c = computed(() => plan.value?.content_json || {})

/** 模型对没涉及的域会写「本次未涉及」，用它判断哪几域是刻意不做 */
const skipped = computed(() =>
  STEAM_KEYS.filter((k) => /未涉及|不涉及|^无$/.test(String(c.value.steam?.[k] || '')))
)

const readyImages = computed(() => (plan.value?.images || []).filter((i) => i.status === 'ready' && i.url))
const leftImages = computed(() => Math.max(0, MAX_IMAGES - readyImages.value.length))

const latestVersion = computed(() => versions.value.reduce((m, v) => Math.max(m, v.version), 1))
const currentNote = computed(() => versions.value.find((v) => v.version === currentVersion.value)?.note || '')
/** 当前版本前面那一版。改稿后老师第一反应是「不如上一版」，所以这个入口要最直接 */
const prevVersion = computed(() => {
  const before = versions.value.filter((v) => v.version < currentVersion.value)
  return before.length ? before[before.length - 1] : null
})

onLoad((query) => {
  planId.value = Number(query?.id || 0)
  conversationId.value = Number(query?.conversation_id || 0)
  load()
})

// 从改一改回来时要拿最新那一版
onShow(() => {
  if (plan.value) load()
})

onUnload(() => stopImagePoll())

function stopImagePoll() {
  if (imageHandle) {
    imageHandle.stop()
    imageHandle = null
  }
}

async function load() {
  loadError.value = null
  try {
    plan.value = await getLessonPlan(planId.value)
    currentVersion.value = plan.value.current_version || plan.value.version || 1
    if (!conversationId.value) conversationId.value = plan.value.conversation_id || 0
    // 版本列表拉失败不该挡着她看教案 —— 大不了没有回退入口
    try {
      const v = await getVersions(planId.value)
      versions.value = v.versions || []
      currentVersion.value = v.current_version || currentVersion.value
    } catch (e) {
      versions.value = []
    }
  } catch (err) {
    loadError.value = err
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
const skipWhy = (k) =>
  `${plan.value?.age_group || '这个年龄班'}的孩子还做不到这一域要求的东西，与其硬凑一个做不了的环节，不如如实空着。`

// 材料常写成「大水盆（2个，直径约60cm...）」，胶囊里只留主名
const shortMat = (m) => String(m).replace(/（.*?）/g, '').split('，')[0]

/** 这样材料有没有画过。按名字比，不按下标 —— 改稿之后下标会错位 */
const hasImageFor = (m) => readyImages.value.some((i) => i.label && i.label === shortMat(m))

/**
 * 图下面那行字。
 *
 * label 是后端回的 prompt_cn，长度不设上限：老师自己描述能写 200 字，
 * 早期挂在流程段上的图更是整段教学文字。原样渲染会在图下面堆出一大段，
 * 还把「存到相册」挤成两行。这里截断 —— 她要认的是哪张图，不是读一遍提示词。
 */
const imgCap = (img) => {
  const raw = String(img.label || '活动材料').trim()
  const name = raw.length > 12 ? `${raw.slice(0, 12)}…` : raw
  return `${name} · ${purposeCn(img.purpose)}`
}

/**
 * 这张图对不上现在的材料清单了。
 *
 * 必须同时满足「挂在某样材料上」（section_key = material.N）——
 * 只看 purpose 会误判：老师自己描述的图 purpose 也可能是材料图，
 * 但它本来就不在材料清单里，标它「过时」是错的。
 */
const isStale = (img) =>
  String(img.section_key || '').startsWith('material.') &&
  Boolean(img.label) &&
  !(c.value.materials || []).some((m) => shortMat(m) === img.label)

function preview(url) {
  uni.previewImage({ urls: readyImages.value.map((i) => i.url), current: url })
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

function goRevise() {
  navTo('revise', { id: planId.value, conversation_id: conversationId.value })
}

function backToLibrary() {
  reLaunch('library')
}

/* ============ 版本回退 ============ */

async function doRollback(version) {
  try {
    await rollback(planId.value, version)
    await load()
    toast(`回到第 ${version} 版了`)
  } catch (err) {
    showApiError(err)
  }
}

/* ============ 材料配图 ============ */

function openSheet() {
  if (pendingImage.value) return
  if (leftImages.value <= 0) {
    // 上限不是成本判断：三张以上老师就不看了，越多越像商品目录、离教案越远
    uni.showModal({
      title: '',
      content: '这份教案已经有 3 张配图了，够用了。',
      showCancel: false,
      confirmText: '知道了',
    })
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
  if (pickedIndex.value >= 0) custom.value = ''
}

function onCustomInput(e) {
  custom.value = e.detail.value
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
      // 自由描述时没有材料下标，后端允许缺省
      sectionKey: free ? null : `material.${pickedIndex.value}`,
      note: name,
    })
    imageHandle = pollImage(planId.value, res.image_id)
    const done = await imageHandle.promise
    imageHandle = null
    if (done.status === 'ready') {
      await load()
      toast(`「${name}」画好了`)
    } else {
      toast('这张没画出来，可以再试一次')
    }
  } catch (err) {
    // 没配 MiniMax 时后端返回 NOT_IMPLEMENTED、超 3 张返回 IMAGE_LIMIT_EXCEEDED，
    // 文案都由后端给，前端照显示
    showApiError(err)
  } finally {
    pendingImage.value = false
    pendingName.value = ''
  }
}

/** 存到相册。存的是原图（2048 长边）—— 她要的就是那个大的，拿去打印 */
function saveOne(img) {
  saveImageToAlbum(img.url)
}

async function doExport() {
  try {
    const res = await exportLessonPlan(planId.value)
    if (res?.url) {
      uni.setClipboardData({ data: res.url })
      toast('下载链接已复制')
    }
  } catch (err) {
    showApiError(err)
  }
}
</script>

<style lang="scss" scoped>
.title {
  display: block;
  font-size: 42rpx;
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
  line-height: 1.4;
  margin: 16rpx 0 18rpx;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 28rpx;
}

.chip {
  display: flex;
  align-items: center;
  border: 2rpx solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 6rpx 20rpx;
  margin: 0 12rpx 10rpx 0;

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
  font-size: $fs-tag;
  color: $ink-2;
  line-height: 1.5;
}

.chip--age .chip__t {
  color: $ink;
  font-weight: 600;
}

/* 「已保存」不只是绿点，旁边有字 —— 颜色不做状态的唯一载体 */
.chip__dot {
  width: 12rpx;
  height: 12rpx;
  border-radius: 999rpx;
  background: $mint;
  margin-right: 10rpx;
}

.chip__t--saved {
  color: $mint-deep;
  font-weight: 600;
}

.sec {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 16rpx;
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
  margin: 32rpx 0;
}

/* ============ STEAM ============ */
.steam {
  display: flex;
  align-items: flex-start;
  padding: 10rpx 0;
}

.bd {
  flex: none;
  width: 38rpx;
  height: 38rpx;
  border-radius: 12rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 18rpx;
  margin-top: 4rpx;

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
  font-size: 22rpx;
  font-weight: 700;
  color: $ink;
}

.steam__t {
  flex: 1;
  font-size: 27rpx;
  line-height: 1.6;
  color: $ink-2;
}

.skip {
  border: 3rpx dashed $rule-2;
  border-radius: 24rpx;
  padding: 20rpx 24rpx;
  margin: 12rpx 0 8rpx;
  background: $paper-2;
}

.skip__hd {
  display: flex;
  align-items: center;
  margin-bottom: 10rpx;
}

.skip__name {
  font-size: 27rpx;
  font-weight: 600;
  color: $ink;
  margin-right: 14rpx;
}

.skip__cap {
  background: $amber;
  border-radius: $r-chip;
  padding: 2rpx 16rpx;
}

.skip__cap-t {
  font-size: $fs-tag;
  font-weight: 700;
  color: $ink;
}

.skip__why {
  font-size: $fs-tag;
  color: $ink-2;
  line-height: 1.7;
}

/* ============ 材料 ============ */
.mats {
  display: flex;
  flex-wrap: wrap;
}

.mat {
  border: 2rpx solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 6rpx 20rpx;
  margin: 0 12rpx 12rpx 0;
}

.mat__t {
  font-size: 25rpx;
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
  font-size: 22rpx;
  color: $mint-deep;
  font-weight: 600;
  margin-left: 10rpx;
}

/* ============ 版本条 ============ */
.ver {
  background: $sky-soft;
  border: 2rpx solid $sky-line;
  border-radius: 28rpx;
  padding: 24rpx 26rpx;
  margin-bottom: 30rpx;
}

.ver__hd {
  margin-bottom: 8rpx;
}

.ver__t {
  font-size: 27rpx;
  font-weight: 600;
  color: $sky-deep;
}

.ver__note {
  display: block;
  font-size: $fs-tag;
  color: $ink-2;
  line-height: 1.65;
  margin-bottom: 16rpx;
}

.ver__ops {
  display: flex;
  flex-wrap: wrap;
}

.ver__b {
  border: 2rpx solid $sky;
  border-radius: $r-chip;
  background: $white;
  padding: 12rpx 26rpx;
  margin: 0 14rpx 10rpx 0;
}

.ver__b-t {
  font-size: 25rpx;
  color: $sky-deep;
  font-weight: 600;
}

.ver__keep {
  display: block;
  font-size: 22rpx;
  color: $ink-3;
  line-height: 1.6;
}

/* ============ 材料图 ============ */
.mimg {
  margin-bottom: 26rpx;
}

.mimg__i {
  width: 100%;
  border-radius: 24rpx;
  border: 2rpx solid $rule-2;
  background: $paper-2;
}

.mimg__cap {
  flex: 1;
  min-width: 0;
  font-size: 26rpx;
  color: $ink-2;
  font-weight: 600;
}

.mimg__stale {
  display: block;
  font-size: 22rpx;
  color: $ink-3;
  line-height: 1.6;
  margin-top: 4rpx;
}

/* ============ 流程 ============ */
.flow {
  margin-bottom: 28rpx;
}

.flow__h {
  display: flex;
  align-items: baseline;
  margin-bottom: 6rpx;
}

.flow__stage {
  font-size: 29rpx;
  font-weight: 600;
  color: $ink;
  margin-right: 16rpx;
}

.flow__min {
  font-size: $fs-tag;
  color: $ink-3;
}

.flow__d {
  font-size: 27rpx;
  line-height: 1.75;
  color: $ink-2;
}

/* ============ 列表 ============ */
.dot {
  position: relative;
  padding-left: 30rpx;
  margin-bottom: 10rpx;
}

.dot::before {
  content: '';
  position: absolute;
  left: 4rpx;
  top: 18rpx;
  width: 10rpx;
  height: 10rpx;
  border-radius: 999rpx;
  background: $mint;
}

.dot--safe::before {
  background: $coral;
}

.dot__t {
  font-size: 27rpx;
  line-height: 1.75;
  color: $ink-2;
}

.para {
  display: block;
  font-size: 27rpx;
  line-height: 1.75;
  color: $ink-2;
}

/* ============ 对话 ============ */
.dlg {
  margin-bottom: 12rpx;
}

.dlg__who {
  font-size: 26rpx;
  font-weight: 700;
  color: $sky-deep;
  margin-right: 12rpx;

  &--c {
    color: $coral-deep;
  }
}

.dlg__t {
  font-size: 26rpx;
  line-height: 1.7;
  color: $ink-2;
}

/* ============ 配图 ============ */
.imgph,
.imgwait {
  border: 2rpx dashed $rule-2;
  border-radius: 24rpx;
  background: $paper-2;
  padding: 28rpx;
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
  font-size: $fs-sub;
  color: $ink-3;
}

.imgwait__t {
  color: $sky-deep;
}

/* ============ 评价 ============ */
.rate {
  background: $paper-2;
  border: 2rpx solid $rule-2;
  border-radius: 28rpx;
  padding: 24rpx 26rpx;
  margin-top: 36rpx;
}

.rate__q {
  display: block;
  font-size: 28rpx;
  font-weight: 600;
  color: $ink;
  margin-bottom: 20rpx;
}

.rate__ops {
  display: flex;
}

.rop {
  flex: 1;
  border: 2rpx solid $rule-2;
  border-radius: 24rpx;
  background: $white;
  padding: 18rpx 8rpx;
  margin-right: 14rpx;
  display: flex;
  align-items: center;
  justify-content: center;

  &:last-child {
    margin-right: 0;
  }

  &--on {
    background: $amber;
    border-color: $amber-line;
  }
}

.rop__t {
  font-size: 26rpx;
  color: $ink-2;
}

.rop--on .rop__t {
  color: $ink;
  font-weight: 600;
}

.rate__done {
  display: block;
  font-size: $fs-tag;
  color: $mint-deep;
  margin-top: 16rpx;
}

/* ============ 底部次级按钮 ============ */
.row {
  display: flex;
  margin-top: 14rpx;
}

.row__b {
  flex: 1;
  border: 2rpx solid $rule-2;
  border-radius: 26rpx;
  background: $paper-2;
  padding: 18rpx 8rpx;
  margin-right: 12rpx;
  display: flex;
  align-items: center;
  justify-content: center;

  &:last-child {
    margin-right: 0;
  }
}

.row__b--on {
  background: $amber;
  border-color: $amber-line;
}

.row__t {
  font-size: 26rpx;
  color: $ink-2;
}

.row__t--on {
  color: $ink;
  font-weight: 600;
}

/* ============ 骨架 ============ */
.sk {
  background: $paper-2;
  border-radius: $r-sm;
  margin-bottom: 20rpx;

  &--title {
    height: 56rpx;
    width: 70%;
    margin-top: 24rpx;
  }

  &--chips {
    height: 40rpx;
    width: 55%;
  }

  &--para {
    height: 140rpx;
    border-radius: 20rpx;
  }

  &--short {
    width: 60%;
  }
}

.err {
  display: block;
  font-size: $fs-body;
  color: $ink-2;
  line-height: 1.7;
  margin: 60rpx 0 32rpx;
}

/* ============ 配图抽屉 ============ */
.sh__sec {
  padding: 8rpx 0 14rpx;
}

.sh__h {
  font-size: 26rpx;
  font-weight: 700;
  color: $ink-2;
  letter-spacing: 0.04em;
}

.sh__sub {
  display: block;
  font-size: $fs-tag;
  color: $ink-3;
  margin-bottom: 14rpx;

  &--gap {
    margin-top: 26rpx;
  }
}

.sh__grp {
  margin-bottom: 8rpx;
}

.sh__grp-t {
  display: block;
  font-size: $fs-tag;
  color: $ink-3;
  margin-bottom: 12rpx;
}

.sh__purposes {
  display: flex;
  flex-wrap: wrap;
}

.sh__p {
  border: 2rpx solid $rule-2;
  border-radius: 24rpx;
  background: $white;
  padding: 18rpx 28rpx;
  margin: 0 14rpx 16rpx 0;

  &--on {
    background: $amber-soft;
    border-color: $amber-line;
    box-shadow: 0 0 0 2rpx $amber-line;
  }
}

.sh__p-t {
  font-size: 27rpx;
  color: $ink-2;

  &--on {
    color: $ink;
    font-weight: 600;
  }
}

.sh__ta {
  width: 100%;
  border: 2rpx solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 22rpx 24rpx;
  font-size: 28rpx;
  line-height: 1.6;
  color: $ink;
  min-height: 110rpx;
}

.sh__ph {
  color: $ink-3;
}

.sh__foot {
  display: block;
  font-size: 22rpx;
  color: $ink-3;
  text-align: center;
  margin-top: 12rpx;
}

/* 抽屉里材料可点 */
.mat--on {
  background: $amber;
  border-color: $amber-line;

  .mat__t {
    color: $ink;
    font-weight: 600;
  }
}

/* ============ 图片下方的操作条 ============ */
.mimg__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12rpx;
}

.mimg__save {
  flex: none;
  border: 2rpx solid $mint;
  border-radius: $r-chip;
  background: $mint-soft;
  padding: 10rpx 24rpx;
  margin-left: 16rpx;
}

.mimg__save-t {
  font-size: 25rpx;
  color: $mint-deep;
  font-weight: 600;
}
</style>
