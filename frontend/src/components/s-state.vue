<template>
  <div class="st" :class="`st--${kind}`">
    <span class="st__t">{{ shownText }}</span>

    <!--
      断网时多一行活的状态，让她知道现在能不能再试。
      **只说否定的那一面，网通着就一个字都不说** —— 第一版写的是
      「net.online ? '网回来了' : '还是没有网络'」，那句「网回来了」是假话：
      `net.online` 默认 true，而 NETWORK 这个 code 里本来就包含
      「wifi 好得很，是后端连不上」。
      这一屏正是她最需要准确信息的时候，宁可少说一句。
    -->
    <span v-if="!net.online" class="st__live">还是没有网络</span>

    <div class="st__ops">
      <s-button
        v-if="actionLabel"
        :label="actionLabel"
        :variant="kind === 'empty' ? 'primary' : 'plain'"
        :arrow="kind === 'empty'"
        @press="$emit('action')"
      />
      <s-button v-if="altLabel" :label="altLabel" variant="ghost" @press="$emit('alt')" />
    </div>
  </div>
</template>

<script setup>
/**
 * 空 / 失败 / 无网 三个态共用的一块。
 *
 * 收口前这三个态在十屏里各写各的：教案库有虚线框的空态、首页只有一行 `.err` 加一个重试、
 * 任务页干脆把「拉失败」显示成「现在没有可以做的事」（**把失败伪装成空**，
 * 她会以为真没任务）。三个态长得不一样倒还好，坏的是**有的屏干脆没有**。
 *
 * 抽成一块之后，「哪一屏漏了哪个态」变成看得见的事 —— 页面里没有 <s-state> 就是没做。
 * `npm run test:tokens` 第 5 条盯着这件事。
 *
 * 文案一律从外面传进来，而且失败态必须传后端给的 `err.message`：
 * 话术统一在后端，改措辞不用重新发版（api-spec 第 0 节）。
 */
import { computed, watch } from 'vue'
import { net } from '../stores/net.js'

const props = defineProps({
  /** empty 一份都没有 | error 请求失败 | offline 没网 */
  kind: { type: String, default: 'error' },
  /** 主文案。error / offline 传后端或请求层给的 message */
  text: { type: String, default: '' },
  /** 主按钮。空态是「写一份新的」这类出路，失败态是「重试」 */
  actionLabel: { type: String, default: '' },
  /** 次要出路，比如空态里的「看全部」 */
  altLabel: { type: String, default: '' },
  /**
   * 网回来时自动触发一次 action。
   *
   * 默认开着，因为这几个态下的 action 全都是「重新拉一次」——
   * 幂等、便宜、而且正是她想要的。她在幼儿园走两步就没信号，
   * 不该为此记得回来点一下。
   *
   * 提交类动作绝不能挂在这上面（会重复提交），所以那些地方传 :auto-retry="false"。
   */
  autoRetry: { type: Boolean, default: true },
})

const emit = defineEmits(['action', 'alt'])

const FALLBACK = {
  empty: '这里还什么都没有',
  error: '出了点问题，再试一次',
  offline: '网络好像断了，检查一下再试',
}

const shownText = computed(() => props.text || FALLBACK[props.kind] || FALLBACK.error)

/**
 * 断 → 通 的那一下自动重来一次。
 *
 * 只在这个组件挂着的时候才有效 —— 也就是**只在她真的正对着一个失败的屏幕**时。
 * 页面正常显示时这个组件不在树里，watcher 也就不存在，不会有背后偷偷重拉。
 */
watch(
  () => net.online,
  (now, before) => {
    if (props.autoRetry && now && !before) emit('action')
  }
)
</script>

<style lang="scss" scoped>
.st {
  padding: 28px 16px;
  margin-top: 20px;
  border-radius: $r-card;
}

/* 空态用虚线框 + 次级底：它不是坏了，是还没开始 —— 那个「等着被填上」的形状是对的 */
.st--empty {
  border: 1.5px dashed $rule-2;
  background: $paper-2;
}

/*
  失败和无网**不画框**。给它加一个红框会把「拉不到列表」渲染成一场事故，
  而她多半只是网不好。一句话加一个按钮就够。
*/
.st--error,
.st--offline {
  padding: 40px 0 16px;
  margin-top: 0;
}

.st__t {
  display: block;
  font-size: var(--fs-read);
  color: $ink-2;
  line-height: 1.7;
  text-align: center;
  margin-bottom: 12px;
}

.st--empty .st__t {
  color: $ink-3;
}

.st__live {
  display: block;
  font-size: var(--fs-tag);
  color: $ink-3;
  text-align: center;
  margin: -7px 0 11px;
}

.st__ops {
  /* 按钮本来就是通栏的，这里只管上下间距 */
  margin: 0 auto;
}
</style>
