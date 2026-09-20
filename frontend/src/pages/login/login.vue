<template>
  <s-page :dock="true">
    <template #top>
      <s-topbar />
    </template>

    <span class="kicker">欢迎回来</span>
    <h1 class="q">用手机号登录</h1>

    <label class="f">
      <span class="f__k">手机号</span>
      <input
        v-model="phone"
        class="f__in"
        type="tel"
        inputmode="numeric"
        autocomplete="tel"
        maxlength="11"
        placeholder="11 位手机号"
      />
    </label>

    <label class="f">
      <span class="f__k">密码</span>
      <input
        v-model="password"
        class="f__in"
        type="password"
        autocomplete="current-password"
        maxlength="64"
        placeholder="你激活时设的那个密码"
        @keyup.enter="submit"
      />
    </label>

    <!--
      「登录不了？」放在按钮**上面**，不是页面最底下。
      她正是进不去的时候才需要它，而那时候她的手指已经在按钮附近了。
      点开是一段边界说明 —— 属于允许留在界面上的两类小字之一。
    -->
    <button type="button" class="help__t" @click="helpOpen = !helpOpen">
      {{ helpOpen ? '知道了' : '登录不了？' }}
    </button>
    <div v-if="helpOpen" class="help">
      <p class="help__p">
        加 QQ <span class="help__b">442407121</span>，说一下你哪个幼儿园的、哪一步卡住了。
      </p>
      <p class="help__p">
        手机号打错、密码忘了、换号了 —— 都能改。为了不让人冒领，这几件事只能我们手工处理，
        大概一天内回你。
      </p>
    </div>

    <template #dock>
      <s-button
        label="登录"
        :disabled="!canSubmit"
        :loading="submitting"
        @press="submit"
      />
      <button type="button" class="alt" @click="goRedeem">
        第一次用？拿兑换码开始
      </button>
    </template>
  </s-page>
</template>

<script setup>
/**
 * 登录页 —— 手机号 + 密码。
 *
 * 【什么时候会走到这一页】
 * 换设备、清了浏览器数据、token 过期（180 天）。日常她是有 token 的，
 * 打开就直接进主流程，看不到这一页。
 *
 * 【为什么它不是入口页】
 * 还没有账号的人更多，而他们手上只有**兑换码**，没有手机号密码。
 * 所以没登录时 `gate()` 把她送到 /redeem，那一页底下通到这里；
 * 这一页底下也通回那边。两条路互相看得见，谁都不会走死。
 *
 * 【为什么手机号只在这里出现，别处都没有】
 * 它在这个系统里**只是用户名** —— 不用于联系、不进 AI 提示词、
 * 不下发到任何页面、不进日志。所以这一页不提供「用手机号找回密码」：
 * 那等于把「知道她的号」变成一把钥匙。
 */
import { computed, onMounted, ref } from 'vue'
import { ensureSession, gate, login } from '../../stores/session.js'
import { replace } from '../../utils/nav.js'
import { showApiError } from '../../utils/ui.js'

const phone = ref('')
const password = ref('')
const submitting = ref(false)
const helpOpen = ref(false)

/* 按钮只要两栏都填了就亮。
   **前端不判格式** —— 11 位是不是打错了、密码是不是短了，由后端回一句中文，
   她看到的是「手机号看起来不对，是 11 位数字」，比一个灰着的按钮有用得多。
   灰按钮只会让她猜自己哪里做错了。 */
const canSubmit = computed(() => Boolean(phone.value.trim() && password.value))

onMounted(async () => {
  await ensureSession()
  // 已经登录的人不该停在登录页（比如她自己按了后退）
  const where = gate()
  if (where === 'main') replace('home')
  else if (where === 'agreement') replace('agreement')
})

async function submit() {
  if (submitting.value || !canSubmit.value) return
  submitting.value = true
  try {
    await login(phone.value.trim(), password.value)
    // 登完按 gate 走：多半是 home，没签协议的会去协议页
    replace(gate() === 'agreement' ? 'agreement' : 'home')
  } catch (err) {
    // 密码错也走到这里。request 层已经保证这种 401 **不会**触发跳转，
    // 所以这句话会稳稳地留在屏幕上（见 utils/request.js 那段注释）
    showApiError(err)
  } finally {
    submitting.value = false
  }
}

function goRedeem() {
  replace('redeem')
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
  margin: 6px 0 18px;
}

.f {
  display: block;
  margin-bottom: 13px;
}

.f__k {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  margin-bottom: 6px;
}

/*
  🔴 输入框用 --fs-card（17px），**不是** --fs-body（15px）。
  iOS Safari 在输入框字号小于 16px 时会把整个页面放大，而她正是点进这个框
  才触发的 —— 页面会跳一下，按钮可能被顶到看不见的地方。
  这一页整个就是两个输入框，跳一下的代价特别明显。
  （首页那个对话框和档案里的输入框也有这个问题，见交接说明。）
*/
.f__in {
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
}

.f__in::placeholder {
  color: $ink-3;
}

.f__in:focus {
  border-color: $mint;
}

.help__t {
  display: inline-block;
  background: none;
  border: none;
  padding: 2px 0;
  font-size: var(--fs-sub);
  color: $mint-deep;
  text-decoration: underline;
}

.help {
  margin-top: 8px;
  background: $mint-soft;
  border: 1px solid $mint-line;
  border-radius: $r-card;
  padding: 12px 13px;
}

.help__p {
  font-size: var(--fs-read);
  line-height: 1.75;
  color: $ink-2;

  & + & {
    margin-top: 6px;
  }
}

.help__b {
  font-weight: 700;
  color: $ink;
}

.alt {
  display: block;
  width: 100%;
  background: none;
  border: none;
  padding: 11px 0 2px;
  font-size: var(--fs-sub);
  color: $ink-3;
  text-align: center;
}
</style>
