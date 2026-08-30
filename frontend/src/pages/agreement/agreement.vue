<template>
  <s-page dock>
    <template #top>
      <s-topbar :title="viewOnly ? '使用协议' : ''" />
    </template>

    <span class="kicker">{{ viewOnly ? '你签过的那份' : '开始之前' }}</span>
    <h1 class="q">先说清楚我们会记录什么</h1>

    <!-- 这段是整页最重要的一句。老师最怕的是园长看到她用 AI 写教案，
         所以「园方看不到」必须在最前面、最显眼，而不是埋在条款里 -->
    <div class="hero">
      <span class="hero__line">你的幼儿园和园长<span class="hero__b">看不到</span>这里的任何东西。</span>
      <span class="hero__line">你写了什么、用了多少次，只有这个项目的团队看得到，不会提供给园方。</span>
    </div>

    <div class="sec"><span class="sec__h">会记录的</span></div>
    <div class="dot"><span class="dot__t">你的姓名、幼儿园、班级、岗位 —— 合作园给的名单里那一行</span></div>
    <!--
      🔴 2026-08-31 改：**手机号这条不能再写「不存」**。

      小程序时代登录靠微信，库里真的没有手机号那一列，所以原文写的是「不存你的手机号」。
      转到网页之后登录改成手机号 + 密码（ADR-002），那句话就成了假话 ——
      而这一页开头自己写着「不实的隐私说明比没有更糟」。

      所以改成如实说明它存在、以及它被限制成了什么：
      三条铁律（不联系、不进 AI 提示词、不下发页面）是 CLAUDE.md 里定死的。
    -->
    <div class="dot">
      <span class="dot__t">
        你设的手机号 —— 它<span class="dot__b">只当登录的用户名</span>，
        我们不会用它联系你、不会把它交给 AI、也不会显示在任何页面上
      </span>
    </div>
    <div class="dot"><span class="dot__t">你在这里的对话、生成的教案和配图、用了多少次</span></div>

    <div class="sec"><span class="sec__h">用来做什么</span></div>
    <div class="dot"><span class="dot__t">确认你是谁、把额度发给你</span></div>
    <div class="dot"><span class="dot__t">研究和改进这个工具</span></div>

    <div class="sec"><span class="sec__h">不会做的</span></div>
    <div class="dot dot--safe">
      <span class="dot__t"><span class="dot__b">不收集孩子的任何信息</span> —— 姓名、照片、观察记录、发展评估，一概不收</span>
    </div>
    <div class="dot dot--safe"><span class="dot__t">不把你的数据给幼儿园、园长或任何第三方</span></div>
    <div class="dot dot--safe"><span class="dot__t">你的姓名不会出现在这个网站的任何页面上</span></div>

    <!--
      这一节原来在设置页。两处各写一份隐私说明会逐条重复 ——
      重复的两份迟早不一致，而不一致的隐私说明比没有更糟。
      协议才是老师首次进来真正签过的那份，所以内容归到这里，「我的」里只留一个入口。
    -->
    <div class="sec"><span class="sec__h">你随时可以</span></div>
    <div class="dot"><span class="dot__t">在「我的」里改掉或删掉任何一条记忆 —— 它们会被带进每次生成，所以改删权在你手里</span></div>
    <div class="dot"><span class="dot__t">在教案库里删掉任何一份教案</span></div>
    <div class="dot">
      <span class="dot__t">
        在「我的」里<span class="dot__b">删掉全部数据</span> ——
        教案、配图、记忆和你的姓名一起删。删完这个账号就不能再用了，
        已经用于研究的那部分（你提交过的建议和评价）撤不回来，但不再关联到你
      </span>
    </div>

    <!--
      🔴 2026-08-31 改：原文写的是「经过**微信的**内容安全检查，这是**小程序平台**的要求」。
      网页端没有微信这一层，改成腾讯云文本内容安全（TMS，CLAUDE.md 定的）。

      ⚠️ **TMS 还没接**（后端 `services/contentSafety.js` 没写）。
      真实老师签这份协议之前必须接上，否则这一句是假话。
    -->
    <span class="meta">你输入的内容和 AI 写的内容会经过一道内容安全检查。</span>

    <template #dock>
      <s-button v-if="viewOnly" label="看完了" variant="plain" @press="back" />
      <s-button v-else label="知道了，开始用" arrow :loading="submitting" @press="submit" />
    </template>
  </s-page>
</template>

<script setup>
/**
 * 使用协议与隐私说明。
 *
 * 两种进法：
 *   激活流程里（`gate()` 判到「激活了但没同意」）—— 底下是「知道了，开始用」
 *   从「我的」点进来回头看一眼（`?view=1`）—— 底下是「看完了」
 *
 * 🔴 **没有 `view` 这个开关的话，已经同意过的老师一进来就被 gate 弹回首页** ——
 * 表现是「点了使用协议什么都没发生」，等于这份协议签完就再也找不到了。
 */
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { agree, ensureSession, gate } from '../../stores/session.js'
import { back, replace } from '../../utils/nav.js'
import { showApiError } from '../../utils/ui.js'

const route = useRoute()
const submitting = ref(false)
/** 只是回头看一眼（从「我的」进来），不是走激活流程 */
const viewOnly = ref(false)

onMounted(async () => {
  viewOnly.value = String(route.query.view || '') === '1'
  if (viewOnly.value) return
  await ensureSession()
  const where = gate()
  if (where === 'redeem') replace('redeem')
  else if (where === 'main') replace('home')
})

async function submit() {
  if (submitting.value) return
  submitting.value = true
  try {
    await agree()
    // 🔴 replace 不是 push：用 push 的话她按后退会回到这一页，
    // 而这一页会再走一遍 gate 把她弹回首页 —— 看起来像后退键坏了
    replace('home')
  } catch (err) {
    showApiError(err)
  } finally {
    submitting.value = false
  }
}
</script>

<style lang="scss" scoped>
.kicker {
  display: block;
  font-size: var(--fs-tag);
  letter-spacing: 0.02em;
  color: $ink-3;
  font-weight: 600;
  margin-top: 20px;
}

.q {
  display: block;
  font-size: var(--fs-title);
  font-weight: 700;
  color: $ink;
  letter-spacing: -0.012em;
  line-height: 1.45;
  margin: 6px 0 16px;
}

.hero {
  background: $mint-soft;
  border: 1px solid $mint-line;
  border-radius: $r-card;
  padding: 13px 14px;
}

.hero__line {
  display: block;
  font-size: var(--fs-body);
  line-height: 1.75;
  color: $ink;

  & + & {
    margin-top: 4px;
  }
}

.hero__b {
  font-weight: 700;
  color: $mint-deep;
}

.sec {
  padding: 0 0 8px;
  margin-top: 17px;
}

.sec__h {
  font-size: var(--fs-sub);
  font-weight: 700;
  color: $ink-2;
  letter-spacing: 0.04em;
}

.dot {
  position: relative;
  padding-left: 15px;
  margin-bottom: 5px;
}

.dot::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 9px;
  width: 5px;
  height: 5px;
  border-radius: $r-chip;
  background: $mint;
}

/* 「不会做的」这组用珊瑚色圆点 —— 与上面两组区分开，且不只靠颜色：文案本身就是否定句 */
.dot--safe::before {
  background: $coral;
}

.dot__t {
  font-size: var(--fs-read);
  line-height: 1.75;
  color: $ink-2;
}

.dot__b {
  font-weight: 700;
  color: $ink;
}

.meta {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  line-height: 1.7;
  margin-top: 16px;
}
</style>
