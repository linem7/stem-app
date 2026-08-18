<template>
  <view v-if="visible" class="sheet">
    <!-- 蒙层。点它关掉 —— 老师误触时最自然的退出方式是点旁边 -->
    <view class="sheet__mask" @tap="$emit('close')" />
    <view class="sheet__panel">
      <view class="sheet__hd">
        <text class="sheet__title">{{ title }}</text>
        <view class="sheet__x" @tap="$emit('close')"><text class="sheet__x-t">关闭</text></view>
      </view>
      <scroll-view class="sheet__body" scroll-y>
        <view class="sheet__inner"><slot /></view>
      </scroll-view>
      <view v-if="hasFoot" class="sheet__foot"><slot name="foot" /></view>
    </view>
  </view>
</template>

<script setup>
/**
 * 底部抽屉。
 *
 * 起因：配图原来是「点按钮 → 材料清单变成可点 → 滚回页面上方去点」，
 * 老师点完按钮站在页面底部，要往上翻半屏才知道该干什么。
 * 抽屉从底下上来，选择就在拇指够得到的地方。
 */
defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '' },
  hasFoot: { type: Boolean, default: false },
})

defineEmits(['close'])
</script>

<style lang="scss" scoped>
.sheet {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 900;
}

.sheet__mask {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  background: rgba(58, 54, 48, 0.45);
}

/*
  高度由三段相加决定（顶栏 + 滚动区 + 底栏），**不要**在这里加 max-height。
  加了之后一旦三段之和超过它，被挤出去的是最下面的底栏 —— 主按钮直接跑到屏幕外面。
  真机上量到过：568 高的屏幕，78vh 的上限把「画这张」压出屏幕 10px。
  滚动区自己是有上限的（见 .sheet__body），所以面板不会顶穿屏幕。
*/
.sheet__panel {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  background: $paper;
  border-top-left-radius: 44rpx;
  border-top-right-radius: 44rpx;
  box-shadow: $shadow-float;
}

.sheet__hd {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 32rpx $sp-5 20rpx;
  border-bottom: 2rpx solid $rule;
}

.sheet__title {
  font-size: 34rpx;
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.01em;
}

.sheet__x {
  padding: 8rpx 20rpx;
  border-radius: $r-chip;
  border: 2rpx solid $rule-2;
  background: $paper-2;
}

.sheet__x-t {
  font-size: 25rpx;
  color: $ink-2;
}

/*
  这里**不能**写 flex:1 + height:0（页面级的 s-page 那样写是对的，因为它外层有 height:100vh）。
  抽屉面板的高度是 max-height 撑出来的，不是确定值 —— scroll-view 内层那个真正滚动的容器
  于是拿不到高度可继承，退回内容高度，既不裁剪也不滚动：内容直接漫出去压在底部按钮上。
  实测（H5 里量的）：外层 467px，内层 660px，多出来的 193px 盖住了最后一排选项和输入框。
  老师看到的就是「最后一个按钮被盖住了」。
  给一个确定高度才裁得住。flex-shrink 也要关掉，被压缩后同样会退化成不裁剪。
*/
.sheet__body {
  flex: none;
  height: 46vh;
}

.sheet__inner {
  padding: 26rpx $sp-5 20rpx;
}

.sheet__foot {
  flex: none;
  padding: 18rpx $sp-5 20rpx;
  padding-bottom: calc(20rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(20rpx + env(safe-area-inset-bottom));
  border-top: 2rpx solid $rule;
}
</style>
