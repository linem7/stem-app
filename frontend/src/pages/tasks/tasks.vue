<template>
  <s-page tab="me">
    <template v-if="loading">
      <view class="sk sk--title" />
      <view class="sk sk--card" />
      <view class="sk sk--card" />
    </template>

    <template v-else>
      <view class="hd">
        <text class="q">可以换额度的事</text>
      </view>

      <!--
        任务和奖励是**断开的**：填完问卷不会自动到账，要等我核对之后发一个码给她。
        这句话必须写出来 —— 不写她填完会盯着额度看，发现没变以为坏了。
        这是「不写解释性小字」那条规则的例外：不说她会做错事（以为出 bug 了）。
      -->
      <view v-if="items.length" class="hint">
        <text class="hint__t">填完问卷之后，我会核对一下，再把兑换码发给你。额度不会自己到账。</text>
      </view>

      <view v-for="t in items" :key="t.id" class="task" :class="{ 'task--new': t.unread }">
        <view class="task__hd">
          <text class="task__t">{{ t.title }}</text>
          <text v-if="t.unread" class="task__new">新</text>
        </view>

        <text v-if="t.body" class="task__b">{{ t.body }}</text>

        <view class="task__meta">
          <text class="task__r">做完给 {{ t.reward_text }} 次教案 · {{ t.reward_image }} 张配图</text>
          <text class="task__d" :class="{ 'task__d--soon': t.days_left !== null && t.days_left <= 3 }">
            {{ deadlineText(t) }}
          </text>
        </view>

        <!--
          小程序里打不开外部网页，所以给复制按钮而不是一个点不动的链接。
          H5 预览时能直接打开，但那不是老师用的那一端 —— 按小程序的能力来做。
        -->
        <view v-if="t.survey_url" class="task__url" @tap="copyUrl(t)">
          <text class="task__url-t">{{ t.survey_url }}</text>
          <text class="task__url-b">复制链接</text>
        </view>
      </view>

      <text v-if="!items.length" class="none">
        现在没有可以做的事。有新的我会放在这里，首页也会提醒你。
      </text>

      <view class="foot" @tap="goRedeem">
        <text class="foot__t">拿到兑换码了？点这里兑换 ›</text>
      </view>
    </template>
  </s-page>
</template>

<script setup>
import { ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { listTasks, markTaskRead } from '../../api/tasks.js'
import { ensureSession } from '../../stores/session.js'
import { navTo } from '../../utils/nav.js'
import { showApiError, toast } from '../../utils/ui.js'

const loading = ref(true)
const items = ref([])

onShow(() => load())

async function load() {
  try {
    await ensureSession()
    const d = await listTasks()
    items.value = d.items || []
    // 进到这一页就把未读全标掉 —— 她已经看见了，首页那条条带不该再挂着。
    // 不 await：标已读失败不该让这一屏空着
    items.value.filter((t) => t.unread).forEach((t) => markTaskRead(t.id).catch(() => {}))
  } catch (err) {
    showApiError(err)
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

function copyUrl(t) {
  uni.setClipboardData({
    data: t.survey_url,
    success: () => toast('链接复制好了，去微信里粘贴打开'),
    fail: () => toast('复制没成功，长按上面那串字自己复制'),
  })
}

function goRedeem() {
  navTo('redeem', { topup: 1 })
}
</script>

<style lang="scss" scoped>
.hd {
  margin: 40rpx 0 20rpx;
}

.q {
  display: block;
  font-size: 42rpx;
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
}

.hint {
  background: $sky-soft;
  border-radius: 24rpx;
  padding: 20rpx 24rpx;
  margin-bottom: 24rpx;
}

.hint__t {
  font-size: $fs-sub;
  color: $ink-2;
  line-height: 1.7;
}

.task {
  border: 2rpx solid $rule;
  border-radius: 28rpx;
  background: $white;
  padding: 28rpx 30rpx;
  margin-bottom: 20rpx;
  box-shadow: $shadow-card;

  /* 未读的用暖阳黄描边。**颜色不是唯一载体** —— 旁边还有一个「新」字，
     因为黄色在奶油底上先天到不了 3:1（design-tokens.md） */
  &--new {
    border-color: $amber-line;
  }
}

.task__hd {
  display: flex;
  align-items: baseline;
}

.task__t {
  flex: 1;
  min-width: 0;
  font-size: 34rpx;
  font-weight: 700;
  color: $ink;
  line-height: 1.45;
}

.task__new {
  flex: none;
  font-size: 22rpx;
  font-weight: 600;
  color: $ink;
  background: $amber;
  border-radius: $r-chip;
  padding: 2rpx 14rpx;
  margin-left: 16rpx;
}

.task__b {
  display: block;
  font-size: 28rpx;
  color: $ink-2;
  line-height: 1.7;
  margin-top: 12rpx;
}

.task__meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  margin-top: 16rpx;
}

.task__r {
  font-size: 26rpx;
  color: $mint-deep;
  font-weight: 600;
}

.task__d {
  font-size: $fs-tag;
  color: $ink-3;

  &--soon {
    color: $coral-deep;
    font-weight: 600;
  }
}

.task__url {
  display: flex;
  align-items: center;
  border-top: 2rpx solid $rule;
  margin-top: 20rpx;
  padding-top: 20rpx;
}

.task__url-t {
  flex: 1;
  min-width: 0;
  font-size: 24rpx;
  color: $ink-3;
  /* 一行显示不完就截断 —— 问卷星的链接很长，换行会把卡片撑得很怪 */
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.task__url-b {
  flex: none;
  font-size: 25rpx;
  font-weight: 600;
  color: $amber-deep;
  border: 2rpx solid $amber-line;
  border-radius: $r-chip;
  background: $amber-soft;
  padding: 8rpx 22rpx;
  margin-left: 20rpx;
}

.none {
  display: block;
  font-size: $fs-sub;
  color: $ink-3;
  line-height: 1.7;
  padding: 20rpx 0;
}

.foot {
  padding: 32rpx 0 12rpx;
  display: flex;
  justify-content: center;
}

.foot__t {
  font-size: 27rpx;
  color: $amber-deep;
}

.sk {
  background: $paper-2;
  border-radius: 24rpx;
  height: 120rpx;
  margin-bottom: 20rpx;

  &--title {
    height: 56rpx;
    width: 45%;
    margin-top: 40rpx;
    border-radius: $r-sm;
  }

  &--card {
    height: 200rpx;
    border-radius: 28rpx;
  }
}
</style>
