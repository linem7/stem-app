<template>
  <div v-if="visible" class="sheet">
    <!-- 蒙层。点它关掉 —— 老师误触时最自然的退出方式是点旁边 -->
    <div class="sheet__mask" @click="$emit('close')" />
    <div class="sheet__panel">
      <div class="sheet__hd">
        <span class="sheet__title">{{ title }}</span>
        <button type="button" class="sheet__x" @click="$emit('close')">
          <span class="sheet__x-t">关闭</span>
        </button>
      </div>
      <div class="sheet__body">
        <div class="sheet__inner"><slot /></div>
      </div>
      <div v-if="hasFoot" class="sheet__foot"><slot name="foot" /></div>
    </div>
  </div>
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
  inset: 0;
  z-index: 900;
}

.sheet__mask {
  position: absolute;
  inset: 0;
  background: rgba(58, 54, 48, 0.45);
}

/*
  跟页面一样套最大宽度居中，否则桌面浏览器上页面只有 480px、抽屉却横跨整屏。

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
  max-width: $page-max;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  background: $paper;
  border-top-left-radius: 22px;
  border-top-right-radius: 22px;
  box-shadow: $shadow-float;
}

.sheet__hd {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px $sp-5 10px;
  border-bottom: 1px solid $rule;
}

.sheet__title {
  font-size: var(--fs-card);
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.01em;
}

.sheet__x {
  padding: 4px 10px;
  border-radius: $r-chip;
  border: 1px solid $rule-2;
  background: $paper-2;
}

.sheet__x-t {
  font-size: var(--fs-sub);
  color: $ink-2;
}

/*
  给一个确定高度，滚动才裁得住 —— 面板本身的高度是内容撑出来的，
  百分比在这里没有可继承的东西。flex-shrink 也要关掉：
  被压缩后同样会退化成不裁剪，内容直接漫出去压在底部按钮上。
*/
.sheet__body {
  flex: none;
  height: 46vh;
  overflow-y: auto;
}

.sheet__inner {
  padding: 13px $sp-5 10px;
}

.sheet__foot {
  flex: none;
  padding: 9px $sp-5 10px;
  padding-bottom: calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid $rule;
}
</style>
