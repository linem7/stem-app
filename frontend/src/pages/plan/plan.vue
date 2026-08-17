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

      <template v-for="k in STEAM_KEYS" :key="k">
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
      </template>

      <!-- ============ 材料 ============ -->
      <view class="hr" />
      <view class="sec">
        <text class="sec__h">材料清单</text>
        <text class="sec__m">{{ picking ? `还能配 ${leftImages} 张` : `${(c.materials || []).length} 样` }}</text>
      </view>
      <text v-if="picking" class="pickhint">点一样材料，我给你画一张图</text>
      <view class="mats">
        <view
          v-for="(m, i) in c.materials || []"
          :key="i"
          class="mat"
          :class="{ 'mat--pick': picking, 'mat--has': hasImageFor(m) }"
          @tap="picking ? drawMaterial(i, m) : null"
        >
          <text class="mat__t">{{ shortMat(m) }}</text>
          <text v-if="hasImageFor(m)" class="mat__mark">有图</text>
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
        <text class="sec__h">活动材料图</text>
        <text class="sec__m">{{ readyImages.length ? `${readyImages.length}/3 张` : '最多 3 张' }}</text>
      </view>

      <view v-for="img in readyImages" :key="img.id" class="mimg">
        <image class="mimg__i" :src="img.url" mode="widthFix" @tap="preview(img.url)" />
        <text class="mimg__cap">{{ img.label || '活动材料' }}</text>
        <!-- 教案改过之后材料清单可能已经不含它了。图不删 —— 她当初觉得值得画才画的 ——
             但要标一句，让她自己判断还用不用得上 -->
        <text v-if="img.label && !inMaterials(img.label)" class="mimg__stale">
          现在的材料清单里已经没有这一样了，图先留着
        </text>
      </view>

      <view v-if="pendingImage" class="imgwait">
        <text class="imgwait__t">正在画「{{ pendingName }}」…可以先去忙，画好了回来看</text>
      </view>
      <view v-else-if="!readyImages.length" class="imgph">
        <text class="imgph__t">还没有材料图。底下点「配图」，从材料清单里挑</text>
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
        <view class="row__b" :class="{ 'row__b--on': picking }" @tap="togglePicking">
          <text class="row__t" :class="{ 'row__t--on': picking }">
            {{ pendingImage ? '画着…' : picking ? '不配了' : '配图' }}
          </text>
        </view>
        <view class="row__b" @tap="doExport"><text class="row__t">导出</text></view>
        <view class="row__b" @tap="backToLibrary"><text class="row__t">教案库</text></view>
      </view>
    </template>
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
/** 配图选材料模式。选完一样就画一张，一次一张（一张要 30 秒，排队等没意义） */
const picking = ref(false)
const versions = ref([])
const currentVersion = ref(1)

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
/** 这张图对应的材料还在不在现在的清单里 */
const inMaterials = (label) => (c.value.materials || []).some((m) => shortMat(m) === label)

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

function togglePicking() {
  if (pendingImage.value) return
  if (!picking.value && leftImages.value <= 0) {
    // 上限不是成本判断：三张以上老师就不看了，越多越像商品目录、离教案越远
    uni.showModal({
      title: '',
      content: '这份教案已经有 3 张材料图了，够用了。',
      showCancel: false,
      confirmText: '知道了',
    })
    return
  }
  picking.value = !picking.value
}

/**
 * 给一样材料画图。一次一张 —— 一张要 30 秒，让她排队等三张没意义，
 * 而且画完一张她可能就不想画了。
 */
async function drawMaterial(index, material) {
  if (pendingImage.value) return
  const name = shortMat(material)
  if (hasImageFor(material)) {
    toast('这一样已经有图了')
    return
  }
  pendingImage.value = true
  pendingName.value = name
  picking.value = false
  try {
    const res = await requestImage(planId.value, {
      sectionKey: `material.${index}`,
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
    // 两句文案都由后端给，前端照显示
    showApiError(err)
  } finally {
    pendingImage.value = false
    pendingName.value = ''
  }
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

.pickhint {
  display: block;
  font-size: $fs-sub;
  color: $amber-deep;
  line-height: 1.6;
  margin-bottom: 16rpx;
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
  display: block;
  font-size: 26rpx;
  color: $ink-2;
  font-weight: 600;
  margin-top: 12rpx;
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

.flow__img {
  width: 100%;
  border-radius: 24rpx;
  border: 2rpx solid $rule-2;
  margin-top: 16rpx;
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
</style>
