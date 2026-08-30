<template>
  <s-page :dock="true">
    <template #top>
      <s-topbar title="组件预览" />
    </template>

    <h1 class="pv__h1">组件预览</h1>

    <section class="pv__sec">
      <h2 class="pv__h2">字号档</h2>
      <div class="pv__row">
        <button
          v-for="s in FONT_SCALES"
          :key="s.key"
          type="button"
          class="pv__chip"
          :class="{ 'pv__chip--on': prefs.fontScale === s.key }"
          @click="setFontScale(s.key)"
        >
          <!-- 选中的胶囊一律多一个打勾：黄底和奶油底的亮度差只有 1.51:1，
               「哪个被选中」几乎全靠色相，而色相正是色觉障碍者拿不到的那一维 -->
          <img v-if="prefs.fontScale === s.key" class="pv__chip-i" :src="checkIcon" alt="已选" />
          {{ s.label }}
        </button>
      </div>
      <p class="pv__body">正文 15px 这一档，长段落读起来是这个密度。切上面三个档，整页跟着变。</p>
      <p class="pv__sub">次级说明用这一档。</p>
    </section>

    <section class="pv__sec">
      <h2 class="pv__h2">s-button</h2>
      <s-button label="写一份新的" arrow @press="toast('主行动')" />
      <div class="pv__gap" />
      <s-button label="存到相册" variant="mint" @press="toast('次级')" />
      <div class="pv__gap" />
      <s-button label="再看看" variant="plain" @press="toast('浅底')" />
      <div class="pv__gap" />
      <s-button label="还差一个年龄班" :disabled="true" />
      <div class="pv__gap" />
      <s-button label="正在写" :loading="true" loading-text="正在写…" />
      <div class="pv__gap" />
      <s-button label="不用了" variant="ghost" @press="toast('纯文字')" />
    </section>

    <section class="pv__sec">
      <h2 class="pv__h2">s-option</h2>
      <s-option
        v-for="o in options"
        :key="o.key"
        :okey="o.key"
        :label="o.label"
        :sub="o.sub"
        :selected="picked === o.key"
        :dim="picked !== '' && picked !== o.key"
        @press="picked = o.key"
      />
      <s-option okey="D" label="我自己说" :own="true" @press="toast('自己说')" />
    </section>

    <section class="pv__sec">
      <h2 class="pv__h2">s-why</h2>
      <s-why text="小班的注意力大约十分钟一轮，所以这个环节只安排一次尝试，剩下的时间留给她们自己摆弄材料。" />
    </section>

    <section class="pv__sec">
      <h2 class="pv__h2">s-skel</h2>
      <s-skel kind="title" />
      <s-skel kind="line" />
      <s-skel kind="line" w="60%" />
      <s-skel kind="card" />
    </section>

    <section class="pv__sec">
      <h2 class="pv__h2">s-state</h2>
      <s-state kind="empty" text="这里还什么都没有" action-label="写一份新的" @action="toast('空态')" />
      <s-state
        kind="error"
        text="出了点问题，再试一次"
        action-label="重试"
        :auto-retry="false"
        @action="toast('失败态')"
      />
    </section>

    <section class="pv__sec">
      <h2 class="pv__h2">提示与弹框</h2>
      <s-button label="来一句 toast" variant="plain" @press="toast('已经记下了')" />
      <div class="pv__gap" />
      <s-button label="停住的弹框" variant="plain" @press="alert('这份教案删掉就找不回来了。')" />
      <div class="pv__gap" />
      <s-button label="问一句" variant="plain" @press="askDelete" />
      <div class="pv__gap" />
      <s-button label="转两秒 loading" variant="plain" @press="spin" />
    </section>

    <template #dock>
      <s-button label="打开抽屉" @press="sheetOpen = true" />
    </template>

    <s-sheet :visible="sheetOpen" title="想画点什么" :has-foot="true" @close="sheetOpen = false">
      <s-option okey="A" label="材料图" sub="一件材料占满一张纸" />
      <s-option okey="B" label="记录表" sub="粗线大格子，印出来给孩子填" />
      <s-option okey="C" label="头饰" sub="中间图案，两条带子绕头" />
      <template #foot>
        <s-button label="画这张" @press="sheetOpen = false" />
      </template>
    </s-sheet>
  </s-page>
</template>

<script setup>
/**
 * 🔴 **临时页面，十个真页面搬完就删。**
 *
 * 这一轮只建地基（Vite 工程、请求层、九个组件、三个回归脚本），页面还没搬。
 * 没有它，`npm run dev` 起来是一片白 —— 而「组件到底长什么样」正是这一轮要看的东西。
 *
 * 删的时候记得把 router/routes.js 里 home 那一行指回真的首页。
 */
import { ref } from 'vue'
import { prefs, setFontScale, FONT_SCALES } from '../../stores/prefs.js'
import { toast, alert, confirm, showLoading, hideLoading } from '../../utils/ui.js'
import { iconCheck } from '../../utils/icons.js'

const checkIcon = iconCheck()
const picked = ref('')
const sheetOpen = ref(false)

const options = [
  { key: 'A', label: '小班（3–4 岁）', sub: '20 分钟 · 3 个环节' },
  { key: 'B', label: '中班（4–5 岁）', sub: '25 分钟 · 4 个环节' },
  { key: 'C', label: '大班（5–6 岁）', sub: '30 分钟 · 4 个环节' },
]

async function askDelete() {
  const ok = await confirm('删掉这份教案？删了就找不回来了。')
  toast(ok ? '删了' : '留着')
}

function spin() {
  showLoading('正在保存')
  setTimeout(hideLoading, 2000)
}
</script>

<style lang="scss" scoped>
.pv__h1 {
  margin: $sp-3 0 $sp-5;
  font-size: var(--fs-title);
  font-weight: 700;
  letter-spacing: -0.012em;
  color: $ink;
}

.pv__sec {
  margin-bottom: $sp-6;
}

.pv__h2 {
  margin: 0 0 $sp-3;
  font-size: var(--fs-card);
  font-weight: 600;
  color: $ink-2;
}

.pv__row {
  display: flex;
  gap: $sp-2;
  margin-bottom: $sp-3;
}

.pv__chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border-radius: $r-chip;
  border: 1px solid $rule-2;
  background: $paper-2;
  font-size: var(--fs-sub);
  color: $ink-2;
}

.pv__chip-i {
  width: 12px;
  height: 12px;
}

.pv__chip--on {
  background: $amber;
  border-color: $amber-line;
  color: $ink;
  font-weight: 600;
}

.pv__body {
  margin: 0 0 $sp-2;
  font-size: var(--fs-body);
  line-height: 1.7;
  color: $ink;
}

.pv__sub {
  margin: 0;
  font-size: var(--fs-sub);
  color: $ink-3;
}

.pv__gap {
  height: $sp-2;
}
</style>
