<template>
  <!--
    没有解读就整块不出现。判据是 `text` 有没有内容 ——
    效率模式下后端连 commentary 这个键都不下发，所以这里天然是空的。
    **不许再判断一次「是不是学习模式」**，那等于把同一件事记在两个地方。
  -->
  <div v-if="text" class="why">
    <button type="button" class="why__hd" :aria-expanded="open" @click="open = !open">
      <span class="why__q">{{ label }}</span>
      <!-- 收起时箭头朝右、展开时朝下。**形状变化是必需的**：
           光靠文字色变深说明不了「已经展开了」，而颜色不做状态的唯一载体 -->
      <img class="why__i" :class="{ 'why__i--on': open }" :src="chevron" alt="" />
    </button>
    <span v-show="open" class="why__b">{{ text }}</span>
  </div>
</template>

<script setup>
/**
 * 「为什么这样设计」—— 学习模式的教案解读，一个板块一块（api-spec 第 5 节）。
 *
 * 【为什么开合状态在组件里，不在页面里】
 *
 * 成稿页最多会挂十来块解读。要是状态放在 plan.vue，就得有一个
 * `openWhy` 对象 + 一个 `toggleWhy(key)` handler，而 plan.vue 已经 1400 多行。
 * 每块自己记自己开没开，页面那边一个 handler、一个 ref 都不用加。
 *
 * 代价是没有「全部展开」，而那个功能本来也不该有：
 * 默认折叠的全部意义就是页面不变长，一键全开等于把这个决定推翻。
 */
import { ref } from 'vue'
import { iconChevron } from '../utils/icons.js'
import { COLORS } from '../utils/colors.js'

defineProps({
  /** 这一段解读的正文。空字符串 = 这个板块模型没写，整块不出现 */
  text: { type: String, default: '' },
  /**
   * 那一行的抬头。
   *
   * 只有**逐环节**那几条要换成「为什么这个环节这么安排」——
   * 导出成一份文档之后环节卡片没了，最后一个环节的解读会紧挨着
   * 「整组为什么是这个顺序」，两条抬头一样就分不出哪条讲的是整体。
   * 屏幕和导出用同一套措辞，她对着看不会以为是两样东西
   * （导出侧在 `lessonGenerator.renderMarkdown` 的 pushWhy）。
   */
  label: { type: String, default: '为什么这样设计' },
})

const chevron = iconChevron(COLORS.mintDeep)
const open = ref(false)
</script>

<style lang="scss" scoped>
.why {
  margin: 8px 0 4px;
}

/*
  折叠时只有一行绿字 + 一个箭头，**不画卡片、不加底色**。
  解读是选读内容，收起来的时候它应该像一条链接，不像一个待处理的板块 ——
  一份教案里挂十来个浅绿盒子，正文就被切碎了。
*/
.why__hd {
  display: flex;
  align-items: center;
}

/* 绿字必须用 deep 档：$mint 本体压奶油底只有 2.4:1（design-tokens 规则 1） */
.why__q {
  font-size: var(--fs-sub);
  color: $mint-deep;
}

.why__i {
  width: 9px;
  height: 9px;
  margin-left: 4px;

  /* 展开后转成朝下 */
  &--on {
    transform: rotate(90deg);
  }
}

/*
  展开后才有底色。$ink-2 压 $mint-soft 是 5.19:1（contrast-test 第 2 节有这一对）。
  行高给到 1.7 —— 这几段是要读的，不是扫的。
*/
.why__b {
  display: block;
  margin-top: 6px;
  padding: 10px 12px;
  background: $mint-soft;
  border-radius: 10px;
  font-size: var(--fs-sub);
  line-height: 1.7;
  color: $ink-2;
}
</style>
