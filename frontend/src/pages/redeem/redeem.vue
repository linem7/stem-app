<template>
  <s-page :dock="showDock">
    <template #top>
      <s-topbar />
    </template>

    <!-- ============ 第一步：输码 ============ -->
    <template v-if="step === 'code'">
      <span class="kicker">开始使用</span>
      <h1 class="q">把兑换码填进来</h1>

      <label class="f">
        <input
          v-model="code"
          class="f__in f__in--code"
          type="text"
          autocapitalize="characters"
          autocomplete="off"
          spellcheck="false"
          placeholder="STEM-XXXX-XXXX"
          @keyup.enter="submitCode"
        />
      </label>

      <p class="note">码在问卷提交完的那一页上，一串字母数字。</p>
    </template>

    <!-- ============ 第二步：从名单里找到自己 ============ -->
    <template v-else-if="step === 'pick'">
      <span class="kicker">{{ entries.length ? '还差一步' : '你在哪个园' }}</span>
      <h1 class="q">{{ entries.length ? '名单上哪一位是你？' : '你在哪个幼儿园？' }}</h1>

      <s-option
        v-for="(item, i) in (entries.length ? entries : kindergartens)"
        :key="item.id"
        :okey="letter(i)"
        :label="entries.length ? entryLabel(item) : item.name"
        :sub="entries.length ? item.note || '' : `还有 ${item.open} 个位置`"
        @press="entries.length ? pickEntry(item) : pickKg(item)"
      />

      <!-- 选错园所是一条死路的话，她只能刷新页面重来。给一条回去的路 -->
      <button v-if="entries.length" type="button" class="alt" @click="backToKg">
        换一个幼儿园
      </button>
    </template>

    <!-- ============ 第三步：手机号 + 密码 ============ -->
    <template v-else>
      <span class="kicker">最后一步</span>
      <h1 class="q">设一个手机号和密码</h1>

      <div class="who">
        <span class="who__t">{{ whoLine }}</span>
      </div>

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
        <span class="f__k">再填一遍手机号</span>
        <input
          v-model="phoneConfirm"
          class="f__in"
          type="tel"
          inputmode="numeric"
          autocomplete="tel"
          maxlength="11"
          placeholder="两边要一样"
        />
        <span class="f__hint">打错一位的话，你下次就登不进来了 —— 所以核对一下</span>
      </label>

      <label class="f">
        <span class="f__k">密码</span>
        <input
          v-model="password"
          class="f__in"
          type="password"
          autocomplete="new-password"
          maxlength="64"
          placeholder="至少 6 位"
        />
      </label>

      <p class="note">
        手机号只是你登录用的名字。我们不会拿它联系你、不会给 AI 看、也不会显示在任何页面上。
      </p>
    </template>

    <template #dock>
      <s-button
        v-if="step === 'code'"
        label="下一步"
        :disabled="!code.trim()"
        :loading="loading"
        @press="submitCode"
      />
      <s-button
        v-else-if="step === 'account'"
        label="完成，开始用"
        arrow
        :disabled="!canActivate"
        :loading="submitting"
        @press="submitActivate"
      />
      <button type="button" class="alt" @click="goLogin">已经有账号？用手机号登录</button>
    </template>
  </s-page>
</template>

<script setup>
/**
 * 激活页 —— 第一次用的人从这一页进。
 *
 * 三步在**同一页**上展开，不换路由：
 *   输码 → 从名单里选自己（园所 → 位置）→ 设手机号 + 密码
 *
 * 【为什么不拆成三个页面】
 * 换页会丢掉已经填的东西，而她中途可能退出去又回来（幼儿园里随时被叫走）。
 * 而且拆页之后「上一步」要做三次，每一次都是一个可能出错的跳转。
 * 一步一步往下展开，她看到的总是一个完整的、还没填完的表。
 *
 * 【为什么第一步是输码，不是登录】
 * 还没有账号的人比老用户多，而他们手上只有兑换码。
 * 这一页底下有一条通到登录页的路，登录页底下也有一条通回这里。
 *
 * 【码和名单都是后端说了算】
 * 前端**不做任何格式校验**（码的大小写、横线、空格都认），
 * 也不缓存名单 —— 拉名单必须先过一个有效的码，这是后端那道门，前端不替它把关。
 */
import { computed, onMounted, ref } from 'vue'
import { rosterOptions } from '../../api/auth.js'
import { activate, ensureSession, gate } from '../../stores/session.js'
import { replace } from '../../utils/nav.js'
import { showApiError, toast } from '../../utils/ui.js'

const step = ref('code') // code | pick | account
const code = ref('')
const loading = ref(false)
const submitting = ref(false)

const kindergartens = ref([])
const entries = ref([])
const kg = ref(null)
const entry = ref(null)

const phone = ref('')
const phoneConfirm = ref('')
const password = ref('')

/** 底部操作条只在两步上有按钮 —— 选名单那一步，点选项本身就是动作 */
const showDock = computed(() => step.value !== 'pick')

/* 跟兑换码那边同一个立场：只判「填了没有」，不判「填得对不对」。
   格式由后端说中文，比一个灰着的按钮有用 —— 灰按钮只会让她猜。 */
const canActivate = computed(() =>
  Boolean(phone.value.trim() && phoneConfirm.value.trim() && password.value)
)

/** 她选的那一行，回显给她确认。只有姓氏 —— 全名不下发是后端定的 */
const whoLine = computed(() => {
  if (!entry.value) return ''
  const parts = [kg.value?.name, entry.value.class_name, entry.value.position]
  if (entry.value.surname) parts.push(`${entry.value.surname}老师`)
  return parts.filter(Boolean).join(' · ')
})

function letter(i) {
  return String.fromCharCode(65 + i)
}

function entryLabel(e) {
  const parts = [e.class_name, e.position]
  if (e.surname) parts.push(`${e.surname}老师`)
  return parts.filter(Boolean).join(' · ')
}

onMounted(async () => {
  await ensureSession()
  const where = gate()
  if (where === 'main') replace('home')
  else if (where === 'agreement') replace('agreement')
})

async function submitCode() {
  if (loading.value || !code.value.trim()) return
  loading.value = true

  /* 🔴 取数据这一段**必须在调用 pickKg 之前结束**。

     原来写成一个大 try，`loading` 到 finally 才复位，中间直接 `await pickKg(...)`。
     而 pickKg 第一行是 `if (loading.value) return` —— 于是「只有一个园就直接跳过」
     这条自动跳转**永远走不到**：点「下一步」什么都不会发生，
     而且不报错、不 toast，看起来就是按钮坏了。
     只有「全库只有一个园有空位」时才会出现，本地测不出来。

     所以先拿数据、先复位 loading，再交给下一步。 */
  kindergartens.value = []
  try {
    const data = await rosterOptions(code.value.trim())
    kindergartens.value = data.kindergartens || []
  } catch (err) {
    showApiError(err)
    return
  } finally {
    loading.value = false
  }

  if (!kindergartens.value.length) {
    // 码是好的，但名单还没录进来（或者空位都被认领完了）
    toast('这个码还没有可以选的名单，找发码给你的人问一下')
    return
  }
  // 只有一个园就跳过这一步 —— 让她在一个只有一个选项的列表里点一下没有意义
  if (kindergartens.value.length === 1) {
    await pickKg(kindergartens.value[0])
    return
  }
  entries.value = []
  step.value = 'pick'
}

async function pickKg(k) {
  if (loading.value) return
  kg.value = k
  loading.value = true
  try {
    const data = await rosterOptions(code.value.trim(), k.id)
    entries.value = data.entries || []
    if (!entries.value.length) {
      toast('这个园现在没有可以选的位置了，找发码给你的人问一下')
      backToKg()
      return
    }
    // 同理：一个班里通常只有一个主班，只剩一个位置就直接替她选上
    if (entries.value.length === 1) {
      pickEntry(entries.value[0])
      return
    }
    step.value = 'pick'
  } catch (err) {
    showApiError(err)
  } finally {
    loading.value = false
  }
}

function pickEntry(e) {
  entry.value = e
  step.value = 'account'
}

function backToKg() {
  entries.value = []
  kg.value = null
  // 园所只剩一个时没有可退的地方，那就退回输码那一步
  step.value = kindergartens.value.length > 1 ? 'pick' : 'code'
}

async function submitActivate() {
  if (submitting.value || !canActivate.value) return
  submitting.value = true
  try {
    await activate({
      code: code.value.trim(),
      rosterEntryId: entry.value.id,
      phone: phone.value.trim(),
      phoneConfirm: phoneConfirm.value.trim(),
      password: password.value,
    })
    // 🔴 replace 不是 push：这次激活已经把码用掉了，
    // 后退回来会看到那一页，再点一次只会报错
    replace(gate() === 'agreement' ? 'agreement' : 'home')
  } catch (err) {
    showApiError(err)
  } finally {
    submitting.value = false
  }
}

function goLogin() {
  replace('login')
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

/* 回显她选中的那一行。是**数据**不是说明 —— 删掉她就要退回去确认自己选对没有 */
.who {
  background: $mint-soft;
  border: 1px solid $mint-line;
  border-radius: $r-card;
  padding: 11px 13px;
  margin-bottom: 15px;
}

.who__t {
  font-size: var(--fs-body);
  font-weight: 600;
  color: $mint-deep;
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
  🔴 输入框用 --fs-card（17px），不是 --fs-body（15px）。
  iOS Safari 在输入框字号小于 16px 时会把整个页面放大，而触发它的正是
  「她点进这个框」—— 页面会跳一下，底下的按钮可能被顶出屏幕。
  这一页每一步都靠输入框推进，跳一下的代价特别明显。
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

/* 兑换码是本页最该被看清的一格：字母间距拉开一点，好一个字符一个字符对 */
.f__in--code {
  letter-spacing: 0.08em;
  text-align: center;
}

.f__in::placeholder {
  color: $ink-3;
}

.f__in:focus {
  border-color: $mint;
}

.f__hint {
  display: block;
  font-size: var(--fs-sub);
  color: $ink-3;
  line-height: 1.65;
  margin-top: 6px;
}

.note {
  font-size: var(--fs-read);
  line-height: 1.75;
  color: $ink-3;
  margin-top: 14px;
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
