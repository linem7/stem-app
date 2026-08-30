<template>
  <div>
    <div v-for="(q, qi) in questions" :key="q.id" class="qb" :class="{ 'qb--done': isAnswered(q.id) }">
      <div class="qb__h">
        <span class="qb__n" :class="{ 'qb__n--done': isAnswered(q.id) }">
          <img v-if="isAnswered(q.id)" class="qb__n-check" :src="checkMint" alt="已答" />
          <span v-else class="qb__n-t">{{ String(qi + 1).padStart(2, '0') }}</span>
        </span>
        <span class="qb__t">
          {{ q.title }}<span v-if="q.required" class="qb__must">必答</span>
        </span>
      </div>

      <span v-if="q.hint || q.multi" class="qb__hint">
        {{ q.hint || '' }}{{ q.multi ? (q.hint ? ' · 可多选' : '可多选') : '' }}
      </span>

      <!--
        学习模式才有的「为什么问这个」。效率模式下后端根本不下发这个字段，
        所以这里不需要判断模式 —— 有就画，没有就没有。

        放在选项**上面**：她要先知道为什么再选，选完再读就晚了。
        用天空蓝（中性提示 / 信息，design-tokens 规则 4），不用暖阳黄 ——
        黄是主行动的颜色，一段解释不该看起来像个按钮。
      -->
      <div v-if="q.why" class="why">
        <span class="why__t">{{ q.why }}</span>
        <span v-if="q.why_detail" class="why__d">{{ q.why_detail }}</span>
      </div>

      <s-option
        v-for="o in q.options"
        :key="`${q.id}-${o.key}`"
        :okey="o.key"
        :label="o.label"
        :sub="o.sub"
        :selected="state(q.id).selected.includes(o.key)"
        :dim="isAnswered(q.id)"
        @press="$emit('pick', q, o.key)"
      />

      <template v-if="q.allow_custom">
        <textarea
          v-if="state(q.id).ownOpen"
          :ref="(el) => setOwnRef(q.id, el)"
          :value="state(q.id).customText"
          class="own"
          placeholder="说说你的想法…"
          maxlength="300"
          rows="2"
          @input="onOwnInput(q, $event)"
          @blur="$emit('own-blur', q)"
        />
        <s-option
          v-else
          own
          :okey="customKey(q)"
          :label="state(q.id).customText || '我自己说 —— 点这里打字'"
          :dim="isAnswered(q.id)"
          @press="openOwn(q)"
        />
      </template>

      <!-- 这一题没存上。不能只弹个 toast 就算了：界面上还打着勾，
           她以为答好了，实际生成教案时这题是空的 -->
      <button v-if="state(q.id).failed" type="button" class="fail" @click="$emit('retry', q)">
        <span class="fail__t">这一题没存上，点这里重发</span>
      </button>

      <!-- 后端对这一题的一句话回应，让她知道自己选的被听进去了 -->
      <div v-else-if="state(q.id).ack" class="ack"><span class="ack__t">{{ state(q.id).ack }}</span></div>
    </div>
  </div>
</template>

<script setup>
/**
 * 一组可点选的问题。
 *
 * **引导那 4 题和改稿那 3 题是同一个东西**，所以只有这一份 ——
 * 小程序时代 guide.vue 和 revise.vue 各写了一遍（连样式一起），
 * 结果是改一处得记得改两处，而漏掉的那一处不会报错。
 *
 * 它只管画和收点击，**答案状态和落库都归调用方**：
 * 引导那边是每答一题即落库，改稿那边是三题一次性交上去 —— 两种持久化方式不一样，
 * 塞进组件里就要加一个 mode 开关，那是把两件事捆在一起。
 */
import { nextTick } from 'vue'
import { iconCheck } from '../utils/icons.js'
import { COLORS } from '../utils/colors.js'
import { autogrow } from '../utils/autogrow.js'

const props = defineProps({
  questions: { type: Array, default: () => [] },
  /** { [questionId]: { selected, customText, ownOpen, ack, failed } } */
  answers: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['pick', 'own-open', 'own-input', 'own-blur', 'retry'])

const checkMint = iconCheck(COLORS.mintDeep, 2.4)

const EMPTY = Object.freeze({ selected: [], customText: '', ownOpen: false, ack: '', failed: false })

/**
 * 读某题的答题状态。
 * **只读，不许在这里补建条目** —— 模板里到处都在调它，渲染期间往 reactive 上写
 * 会触发重新渲染，转成死循环。条目由调用方在拿到 questions 时一次建好。
 */
function state(qid) {
  return props.answers[qid] || EMPTY
}

const isAnswered = (qid) => state(qid).selected.length > 0 || Boolean(state(qid).customText)

/** 「我自己说」排在最后一个选项后面，A/B/C/D 顺着排下去 */
const customKey = (q) => String.fromCharCode(65 + (q.options?.length || 0))

/* 「我自己说」那几个输入框的 DOM 引用 —— 点开之后要立刻聚焦，
   否则她还得再点一次才能打字。 */
const ownEls = {}
function setOwnRef(qid, el) {
  if (el) {
    ownEls[qid] = el
    // 断点续写还原出来的那些要按内容长到该有的高度
    nextTick(() => autogrow(el))
  } else {
    delete ownEls[qid]
  }
}

function openOwn(q) {
  emit('own-open', q)
  nextTick(() => ownEls[q.id]?.focus())
}

function onOwnInput(q, e) {
  autogrow(e.target)
  emit('own-input', q, e.target.value)
}
</script>

<style lang="scss" scoped>
.qb {
  margin-bottom: 22px;
}

.qb__h {
  display: flex;
  align-items: center;
  margin-bottom: 3px;
}

.qb__n {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: $paper-2;
  border: 1px solid $rule-2;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 9px;

  &--done {
    background: $mint-soft;
    border-color: $mint;
  }
}

/* 12px 是 design-tokens 定的辅助文字下限，不能再小 */
.qb__n-t {
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink-3;
}

.qb__n-check {
  width: 13px;
  height: 13px;
}

.qb__t {
  flex: 1;
  font-size: var(--fs-card);
  font-weight: 600;
  line-height: 1.45;
  letter-spacing: -0.01em;
  color: $ink;
}

/* 必答用黄底墨字的胶囊，不是只把字变个色 —— 颜色不做状态的唯一载体 */
.qb__must {
  font-size: var(--fs-tag);
  font-weight: 700;
  color: $ink;
  background: $amber;
  border-radius: $r-chip;
  padding: 2px 7px;
  margin-left: 6px;
}

.qb__hint {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  line-height: 1.6;
  margin: 0 0 10px 31px;
}

/* 答过的题整体降一档存在感，视线自然落到还没答的那几题上 */
.qb--done .qb__t {
  color: $ink-2;
}

/* 天空蓝 = 中性提示/信息。缩进对齐题目文字（左边让出序号那 31px） */
.why {
  background: $sky-soft;
  border-left: 3px solid $sky;
  border-radius: 0 10px 10px 0;
  padding: 9px 11px;
  margin: 0 0 10px 31px;
}

.why__t {
  display: block;
  font-size: var(--fs-sub);
  font-weight: 600;
  color: $sky-deep;
  line-height: 1.6;
}

.why__d {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-2;
  line-height: 1.7;
  margin-top: 4px;
}

.own {
  display: block;
  width: 100%;
  outline: none;
  resize: none;
  border: 1px solid $amber-line;
  border-radius: $r-btn;
  padding: 12px 13px;
  font-size: var(--fs-body);
  line-height: 1.55;
  color: $ink;
  background: $white;
  margin-bottom: 9px;
  box-shadow: 0 0 0 1px $amber-line;
  min-height: 48px;
}

.own::placeholder {
  color: $ink-3;
}

.ack {
  background: $sky-soft;
  border-radius: 10px;
  padding: 8px 11px;
  margin-top: 2px;
}

.ack__t {
  font-size: var(--fs-tag);
  color: $ink-2;
  line-height: 1.65;
}

.fail {
  display: block;
  width: 100%;
  text-align: left;
  background: $paper-2;
  border: 1px solid $coral;
  border-radius: 10px;
  padding: 8px 11px;
  margin-top: 2px;
}

.fail__t {
  font-size: var(--fs-tag);
  color: $coral-deep;
  line-height: 1.65;
}
</style>
