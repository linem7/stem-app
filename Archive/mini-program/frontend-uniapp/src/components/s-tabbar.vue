<template>
  <view class="s-tabbar">
    <view
      v-for="t in tabs"
      :key="t.name"
      class="s-tabbar__item"
      :class="{ 's-tabbar__item--on': t.name === active }"
      :style="{ color: t.name === active ? t.onColor : COLORS.ink3 }"
      @tap="go(t.name)"
    >
      <image class="s-tabbar__icon" :src="t.icon" mode="widthFix" />
      <text class="s-tabbar__label">{{ t.label }}</text>
    </view>
  </view>
</template>

<script setup>
import { computed } from 'vue'
import { COLORS } from '../utils/colors.js'
import { iconHome, iconLibrary, iconMe } from '../utils/icons.js'
import { switchTab } from '../utils/nav.js'

const props = defineProps({
  active: { type: String, default: 'home' },
})

// 一个语义只绑一个色（design-tokens 规则 4）：首页=暖阳黄、教案库=薄荷绿、我的=珊瑚粉。
// 选中时线也加粗，不只靠颜色区分。
const tabs = computed(() => [
  {
    name: 'home',
    label: '首页',
    onColor: COLORS.amberDeep,
    icon: iconHome(props.active === 'home' ? COLORS.amberDeep : COLORS.ink3, props.active === 'home'),
  },
  {
    name: 'library',
    label: '教案库',
    onColor: COLORS.mintDeep,
    icon: iconLibrary(
      props.active === 'library' ? COLORS.mintDeep : COLORS.ink3,
      props.active === 'library'
    ),
  },
  {
    name: 'me',
    label: '我的',
    onColor: COLORS.coralDeep,
    icon: iconMe(props.active === 'me' ? COLORS.coralDeep : COLORS.ink3, props.active === 'me'),
  },
])

function go(name) {
  if (name === props.active) return
  switchTab(name)
}
</script>

<style lang="scss" scoped>
.s-tabbar {
  flex: none;
  display: flex;
  border-top: 2rpx solid $rule;
  background: $paper;
  padding: 14rpx 0 10rpx;
  padding-bottom: calc(10rpx + constant(safe-area-inset-bottom));
  padding-bottom: calc(10rpx + env(safe-area-inset-bottom));
}

.s-tabbar__item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.s-tabbar__icon {
  width: 42rpx;
  height: 42rpx;
}

.s-tabbar__label {
  font-size: var(--fs-tag);
  letter-spacing: 0.03em;
  margin-top: 6rpx;
  color: inherit;
}

.s-tabbar__item--on .s-tabbar__label {
  font-weight: 600;
}
</style>
