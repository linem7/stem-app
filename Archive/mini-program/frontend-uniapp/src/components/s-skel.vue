<template>
  <view class="skel" :class="`skel--${kind}`" :style="w ? { width: w } : null" />
</template>

<script setup>
/**
 * 骨架屏的一块。
 *
 * 为什么要抽成组件：收口前十屏各自写了一份 `.sk`，圆角有 20 / 24 / 28rpx 三种、
 * 底色都是 $paper-2 但高度各写一遍。它们本该长得一样 ——
 * 骨架屏的作用是「让布局在数据到达前就站住」，形状不一致就等于每屏各跳一次。
 *
 * **不做闪烁动画**。小程序里那种流光要么用 animation 拖帧，
 * 要么在低端机上一顿一顿的，比静止的灰块更像坏了。
 * 静止的灰块已经说清了「正在拿」这件事，剩下的交给它出现得够快。
 */
defineProps({
  /**
   * title 大标题 | line 一行字 | chips 一排胶囊 | card 一张卡片
   * | para 一段话 | opt 一个选项行
   */
  kind: { type: String, default: 'line' },
  /** 覆盖宽度，例如最后一行留短一点（'60%'） */
  w: { type: String, default: '' },
})
</script>

<style lang="scss" scoped>
.skel {
  background: $paper-2;
  border-radius: $r-sm;
  margin-bottom: 20rpx;
}

/*
  高度用 rpx 写死，**故意不跟字号档一起放大**。
  骨架块代表的是「这里将会出现内容」，不是内容本身；
  跟着放大只会让加载时的页面比加载完更长，切换的那一下整页往上跳一截。
*/
.skel--title {
  height: 56rpx;
  width: 60%;
}

.skel--line {
  height: 40rpx;
}

.skel--chips {
  height: 40rpx;
  width: 55%;
}

.skel--card {
  height: 180rpx;
  border-radius: 28rpx;
}

.skel--para {
  height: 140rpx;
  border-radius: 20rpx;
}

.skel--opt {
  height: 96rpx;
  border-radius: $r-btn;
}
</style>
