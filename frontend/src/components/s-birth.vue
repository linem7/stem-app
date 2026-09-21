<template>
  <!--
    出生年月 —— **两个并排的下拉，不弹任何框**。

    🔴 2026-09-21 用户改的：原来点开是一个底部抽屉（滚轮），两个问题：
      ① 「直接给年月的输入框就好了，不要弹出新的框」
      ② 它嵌在「完善信息」抽屉里，**两层抽屉套着** ——
         第二层的蒙层会跟第一层打架，表现是选完点「好了」之后
         底下那层也一起关了，她看不到「填好了」那个按钮、
         于是「填写完了也没法提交」
    现在没有第二层了，那类问题整个不存在。
  -->
  <div class="bd" :class="{ 'bd--sm': dense }">
    <label class="bd__c">
      <span class="bd__k">年</span>
      <!--
        🔴 **`:value` 和显示文字分开写，而且两边都别加单位。**
        2026-09-21 那个 bug：月份原来写 `<option :value="v">{{ v }} 月</option>`，
        而 `@change` 拿到的 `$event.target.value` 在有些渲染路径下是
        **显示文字 `"4 月"`** 而不是 value —— `Number("4 月")` 是 `NaN`，
        `NaN || null` 变成 null → 组件 emit 空串 →
        **界面上明明显示着「4 月」，传出去的值却是空的**。
        现在显示的就是 `4`（跟年份一样光秃秃的数字），
        加上 `toNum` 那道兜底，两条路都产不出错值。
      -->
      <select :value="y" class="bd__s" @change="onYear($event.target.value)">
        <option :value="null">请选择</option>
        <option v-for="v in years" :key="v" :value="v">{{ v }}</option>
      </select>
    </label>
    <label class="bd__c">
      <span class="bd__k">月</span>
      <select
        :value="m"
        class="bd__s"
        :disabled="!y"
        @change="onMonth($event.target.value)"
      >
        <option :value="null">请选择</option>
        <option v-for="v in 12" :key="v" :value="v">{{ v }}</option>
      </select>
    </label>
  </div>
</template>

<script setup>
/**
 * 出生年月选择器（2026-09-21 新增，同日改成内联两格）。
 *
 * 【为什么单独一个组件】
 * 两个地方要用它：首页那条「完善信息」提醒、以及「我的 → 个人档案」。
 * 写两遍的话「年份范围」和「月份怎么补零」这两件事会分叉，
 * 而它们分叉的表现是「一处能选 1995-1、另一处只能选 1995-01」，
 * 到了后端一条能过一条被拒。
 *
 * 【为什么是下拉不是打字】
 * 用户 2026-09-21 定：「让用户滚动或者点击的方式来键入，不然容易出现错误」。
 * 打字的错法她看不出来（1995-13、199-12、全角数字），
 * 而这两个下拉里根本选不出错的值 —— **月份是下拉，所以永远不会出现 `1995-1`**。
 *
 * 【输出的格式】
 * `YYYY-MM`（`1995-12`），跟库里 `teachers.birth_month` 完全一致。
 * 两个下拉各自变化时都会重算并 emit —— 调用方直接拿它去存，不做转换。
 *
 * 🔴 **`Number()` 那个转换不是可有可无的。**
 * `$event.target.value` 永远是**字符串**（`"12"`），而 `:value="v"` 上是数字。
 * 不转的话 `emitIfFull` 里 `String(m).padStart(2,'0')` 对数字和字符串都对，
 * 但 `!y.value` / `!m.value` 那种判空在 `"0"` 上会出错 ——
 * 现在月份从 1 起，看着碰不到，但把「年」也走一遍同样的路更安全，
 * 而且转换点集中在这里，比散在模板里可靠。
 */
import { computed, ref, watch } from 'vue'

const props = defineProps({
  /** 当前值 `YYYY-MM`，没有就空串 */
  modelValue: { type: String, default: '' },
  /** 紧凑版：给「个人档案」那一行用（那儿一行里要塞好几样） */
  dense: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const y = ref(null)
const m = ref(null)

/**
 * 年份从今年往回 60 年。
 *
 * 下限跟着「今年」走 —— 不写死 1955，否则这个组件三年后就只能选到
 * 「今年 63 岁」的人，而那是不知不觉发生的（没人会记得回来改）。
 * ⚠️ 后端那条校验的下限是写死的 1930，比这里宽 ——
 * 那是**故意的**：前端给一个合理的范围，后端只挡明显错的。
 */
const years = computed(() => {
  const now = new Date().getFullYear()
  const out = []
  for (let v = now - 60; v <= now; v += 1) out.push(v)
  return out.reverse()
})

/**
 * 从外面传进来的值回填。
 *
 * ⚠️ `immediate: true` 是必须的 —— 她打开「个人档案」时那一格要显示
 * **已经存过的**年月，而不是两个空的「请选择」。
 */
watch(
  () => props.modelValue,
  (v) => {
    const [yy, mm] = String(v || '').split('-')
    y.value = Number(yy) || null
    m.value = Number(mm) || null
  },
  { immediate: true }
)

/** 月份补零 —— 后端那条正则要 `0[1-9]|1[0-2]`，`1995-1` 会被拒 */
function emitIfFull() {
  if (!y.value || !m.value) return emit('update:modelValue', '')
  emit('update:modelValue', `${y.value}-${String(m.value).padStart(2, '0')}`)
}

/**
 * 🔴 **必须从 `$event.target.value` 里把数字挑出来，不能直接 `Number(v)`。**
 *
 * 这个 bug 真发生过（2026-09-21，用户在截图里报的）：当时月份的 option 是
 * `<option :value="v">{{ v }} 月</option>`，而 `@change` 拿到的
 * `$event.target.value` 在**有的浏览器/有的渲染路径**下会是**显示文字**
 * （`"4 月"`）而不是 value。`Number("4 月")` = `NaN`，
 * `NaN || null` = `null` → 组件 emit 空串 →
 * **界面上明明显示着「4 月」，传出去的值却是空的**，
 * 表现就是「填了年月却报格式错误」。
 *
 * 现在两道都做了：模板里 value 和文字分开（见那边的注释），
 * 这里再兜一次 —— 用正则抠出开头的数字。
 * **两道都守，因为它们防的是不同的东西**：模板防「value 写错」，
 * 这里防「浏览器给的字符串跟预期不一样」。
 */
function toNum(v) {
  const n = parseInt(String(v ?? '').match(/\d+/)?.[0] ?? '', 10)
  return Number.isInteger(n) ? n : null
}

function onYear(v) {
  y.value = toNum(v)
  emitIfFull()
}

function onMonth(v) {
  m.value = toNum(v)
  emitIfFull()
}
</script>

<style lang="scss" scoped>
.bd {
  display: flex;
  gap: 8px;
}

.bd__c {
  display: block;
  flex: 1;
  min-width: 0;
}

.bd__k {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  margin-bottom: 6px;
}

/*
  🔴 字号用 --fs-card（17px）。iOS Safari 在表单控件字号小于 16px 时
  会把整个页面放大 —— 跟 redeem 那几个输入框同一个理由。
  ⚠️ 紧凑版（「个人档案」那一行）降到 --fs-body，因为那一行里
  还有教龄、单位这些，17px 会挤。**但 16px 是下限**，不能更低。
*/
.bd__s {
  display: block;
  width: 100%;
  box-sizing: border-box;
  outline: none;
  border: 1px solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 12px 13px;
  font-size: var(--fs-card);
  color: $ink;
  appearance: none;
  -webkit-appearance: none;
}

.bd--sm .bd__s {
  padding: 8px 11px;
  font-size: var(--fs-body);
}

.bd__s:focus {
  border-color: $mint;
}

/* 年还没选时月份灰着 —— 告诉她「先选左边」，而不是让她点开一个空列表 */
.bd__s:disabled {
  background: $paper-2;
  color: $ink-3;
}
</style>
