<template>
  <button
    type="button"
    class="opt"
    :class="{ 'opt--sel': selected, 'opt--own': own, 'opt--dim': dim && !selected }"
    :aria-pressed="selected"
    @click="$emit('press')"
  >
    <span class="opt__key"><span class="opt__key-t">{{ okey }}</span></span>
    <span class="opt__txt">
      <span class="opt__label">{{ label }}</span>
      <span v-if="sub" class="opt__sub">{{ sub }}</span>
    </span>
    <!-- 选中同时有底色、边框、字重和这个勾 —— 颜色不做状态的唯一载体 -->
    <img v-if="selected" class="opt__check" :src="checkIcon" alt="已选" />
  </button>
</template>

<script setup>
import { iconCheck } from '../utils/icons.js'

defineProps({
  /** A / B / C / D */
  okey: { type: String, default: '' },
  label: { type: String, default: '' },
  sub: { type: String, default: '' },
  selected: { type: Boolean, default: false },
  /** 「我自己说」那一项：虚线框 */
  own: { type: Boolean, default: false },
  /** 这题已经答过了，没选中的项降一档存在感，让视线落到还没答的题上 */
  dim: { type: Boolean, default: false },
})

defineEmits(['press'])

const checkIcon = iconCheck()
</script>

<style lang="scss" scoped>
.opt {
  display: flex;
  align-items: flex-start;
  text-align: left;
  width: 100%;
  background: $white;
  border: 1px solid $rule-2;
  border-radius: $r-btn;
  padding: 13px 13px 13px 12px;
  margin-bottom: 9px;
}

.opt__key {
  flex: none;
  width: 23px;
  height: 23px;
  border-radius: 8px;
  border: 1px solid $rule-2;
  background: $paper-2;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
  margin-right: 11px;
}

.opt__key-t {
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink-3;
  letter-spacing: 0.02em;
}

.opt__txt {
  flex: 1;
}

.opt__label {
  display: block;
  font-size: var(--fs-body);
  line-height: 1.55;
  color: $ink;
}

.opt__sub {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  margin-top: 2px;
  line-height: 1.5;
}

.opt__check {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 3px;
  margin-left: 6px;
}

.opt--sel {
  background: $amber-soft;
  border-color: $amber-line;
  box-shadow: 0 0 0 1px $amber-line, 0 2px 8px rgba(138, 100, 16, 0.14);

  .opt__key {
    background: $amber;
    border-color: $amber;

    .opt__key-t {
      color: $ink;
    }
  }

  .opt__label {
    font-weight: 600;
  }
}

.opt--own {
  background: transparent;
  border-style: dashed;

  .opt__label {
    color: $ink-3;
  }
}

/*
  答过的题里没选中的项要降存在感，但**不能用 opacity 压整块** ——
  那会连文字一起压掉：正文掉到约 3.2:1，「我自己说」那行更是到 2.1:1，
  低于 4.5:1 的下限。老师想回头看看别的选项写的什么就得凑近看。
  改成只降非文字层：底和边框往回收，文字最多降到 $ink-2。
*/
.opt--dim {
  background: $paper-2;
  border-color: $rule;

  .opt__label {
    color: $ink-2;
  }
}
</style>
