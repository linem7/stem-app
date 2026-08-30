<template>
  <button
    type="button"
    class="s-btn"
    :class="[`s-btn--${variant}`, { 's-btn--disabled': disabled || loading }]"
    :disabled="disabled || loading"
    @click="onPress"
  >
    <span class="s-btn__label">{{ loading ? loadingText || label : label }}</span>
    <img v-if="arrow && !loading" class="s-btn__arrow" :src="arrowSrc" alt="" />
  </button>
</template>

<script setup>
import { computed } from 'vue'
import { iconArrow } from '../utils/icons.js'
import { COLORS } from '../utils/colors.js'

const props = defineProps({
  label: { type: String, default: '' },
  /** primary=暖阳黄主行动 | mint=薄荷绿次级 | plain=浅底 | ghost=纯文字 */
  variant: { type: String, default: 'primary' },
  disabled: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  loadingText: { type: String, default: '' },
  arrow: { type: Boolean, default: false },
})

// 事件名是 press 不是 click，跟小程序时代保持一致 —— 页面搬过来时不用改
const emit = defineEmits(['press'])

// 主按钮是黄底墨字（约 8.4:1），比白字方案更亮也更清楚 —— design-tokens 规则 2。
// 禁用时箭头也得跟着变浅，否则深墨箭头挂在浅灰按钮上，看着像半亮半暗。
const arrowSrc = computed(() => {
  if (props.disabled || props.loading) return iconArrow(COLORS.disabledInk)
  return iconArrow(props.variant === 'mint' ? COLORS.white : COLORS.ink)
})

function onPress() {
  if (props.disabled || props.loading) return
  emit('press')
}
</script>

<style lang="scss" scoped>
.s-btn {
  width: 100%;
  border: none;
  border-radius: $r-card;
  padding: $sp-3 $sp-2;
  font-size: var(--fs-body);
  font-weight: 600;
  letter-spacing: 0.02em;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1.5;
}

.s-btn__label {
  font-weight: inherit;
}

.s-btn__arrow {
  width: 15px;
  height: 15px;
  margin-left: 7px;
}

/* 主行动 —— 暖阳黄底 + 墨字。那圈内描边和下沿实边是方向 B 的手感来源，别去掉 */
.s-btn--primary {
  background: $amber;
  color: $ink;
  box-shadow: inset 0 0 0 1.5px $amber-deep, 0 3px 0 $amber-line, 0 8px 18px rgba(138, 100, 16, 0.22);
}

/* 次级 —— 绿底配白字必须用 deep 档，$mint 本体配白字只有 2.4:1 */
.s-btn--mint {
  background: $mint-deep;
  color: $white;
  box-shadow: 0 3px 0 $mint-shadow, 0 8px 18px rgba(46, 110, 73, 0.22);
}

.s-btn--plain {
  background: $paper-2;
  color: $ink-2;
  box-shadow: inset 0 0 0 1px $rule;
}

.s-btn--ghost {
  background: transparent;
  color: $ink-3;
  font-size: var(--fs-sub);
  font-weight: 500;
  padding: $sp-2;
}

.s-btn--disabled {
  background: $disabled-bg;
  color: $disabled-ink;
  box-shadow: none;
  cursor: default;
}
</style>
