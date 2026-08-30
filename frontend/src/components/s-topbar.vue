<template>
  <div class="s-topbar">
    <!--
      汉堡键。**每一页都要有**（首页也是）—— 窄屏上它是抽屉唯一的入口，
      漏掉一页，她在那一页就出不去了。
    -->
    <button type="button" class="s-topbar__menu" :aria-label="menuLabel" @click="toggleSide">
      <img class="s-topbar__menu-i" :src="menuIcon" alt="" />
    </button>
    <span v-if="title" class="s-topbar__title">{{ title }}</span>
    <div class="s-topbar__slot"><slot /></div>
  </div>
</template>

<script setup>
/**
 * 顶栏。
 *
 * 🔴 **没有返回箭头**（2026-08-30 用户定）。小程序里 navigationStyle: custom，
 * 那个「←」是唯一的返回入口；浏览器自带后退键和右滑返回，两样重复了。
 *
 * ⚠️ 由此推出两件事：
 *   1. 生成完跳成稿、激活完进首页、改稿完回成稿，**三处必须 nav.replace**
 *      （见 utils/nav.js）
 *   2. 从别人发的链接直接打开某一页时**没有历史记录**，后退会离开整个网站。
 *      那类页面仍然要有明确的「回首页」出口 —— 删掉的是那个通用的「←」，不是所有出口
 *
 * 左边这个汉堡键是**另一件事**：它开的是侧边栏（教案库），不是返回。
 */
import { computed } from 'vue'
import { iconMenu } from '../utils/icons.js'
import { shell, toggleSide } from '../stores/shell.js'

defineProps({
  title: { type: String, default: '' },
})

const menuIcon = iconMenu()

// 宽屏上它是收起/展开，窄屏上它是打开教案库那条抽屉 —— 读屏软件要听得出区别
const menuLabel = computed(() => {
  if (!shell.wide) return '打开教案库'
  return shell.collapsed ? '展开教案库' : '收起教案库'
})
</script>

<style lang="scss" scoped>
.s-topbar {
  flex: none;
  display: flex;
  align-items: center;
  padding: 5px $sp-5 7px;
  /* 固定高度，不用 min-height —— 标题一长就把整条撑高，下面的内容全被挤走 */
  height: 46px;
  overflow: hidden;
}

/* 触控区不小于 44px。左边负 margin 让图标本身跟正文左缘对齐 */
.s-topbar__menu {
  flex: none;
  width: 44px;
  height: 44px;
  margin-left: -13px;
  margin-right: 2px;
  border-radius: $r-sm;
  display: flex;
  align-items: center;
  justify-content: center;
}

.s-topbar__menu-i {
  width: 17px;
  height: 17px;
}

/* 教案标题可以很长（首页输入框放到 200 字），必须单行截断 */
.s-topbar__title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sub);
  font-weight: 600;
  color: $ink-2;
  letter-spacing: 0.02em;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.s-topbar__slot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-left: auto;
}
</style>
