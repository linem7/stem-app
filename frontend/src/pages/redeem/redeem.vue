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

    <!-- ============ 第二步：从名单里找到自己（四级） ============ -->
    <template v-else-if="step === 'pick'">
      <!-- 第四级：班里有哪些位置 -->
      <template v-if="entries.length">
        <span class="kicker">还差一步</span>
        <h1 class="q">名单上哪一位是你？</h1>
        <s-option
          v-for="(item, i) in entries"
          :key="item.id"
          :okey="letter(i)"
          :label="entryLabel(item)"
          :sub="item.note || ''"
          @press="pickEntry(item)"
        />
        <button type="button" class="alt" @click="backToKg">换一个幼儿园</button>
      </template>

      <!-- 第三级：这个市有哪些园 -->
      <template v-else-if="kindergartens.length">
        <span class="kicker">{{ city }} · 选幼儿园</span>
        <h1 class="q">你在哪个幼儿园？</h1>
        <s-option
          v-for="(item, i) in kindergartens"
          :key="item.id"
          :okey="letter(i)"
          :label="item.name"
          :sub="`还有 ${item.open} 个位置`"
          @press="pickKg(item)"
        />
      </template>

      <!-- 第二级：这个省有哪些市 -->
      <template v-else-if="cities.length">
        <span class="kicker">{{ province }}</span>
        <h1 class="q">你在哪个市？</h1>
        <s-option
          v-for="(item, i) in cities"
          :key="item"
          :okey="letter(i)"
          :label="item"
          @press="pickCity(province, item)"
        />
      </template>

      <!-- 第一级：有哪些省 / 直辖市 -->
      <template v-else>
        <span class="kicker">你在哪里</span>
        <h1 class="q">你在哪个地区？</h1>
        <s-option
          v-for="(item, i) in regions"
          :key="item.province"
          :okey="letter(i)"
          :label="item.province"
          @press="pickProvince(item.province)"
        />
      </template>

      <!--
        「不在名单之内」—— **始终摆着**（用户 2026-09-21 定）。
        位置在四个层级的**底下**：她要是能在上面找到自己，就不会往下看；
        找不到时它就在那儿。挪到页面顶部会让所有人都先看到它。
      -->
      <button type="button" class="alt alt--self" @click="startSelf">
        不在名单之内 ›
      </button>
    </template>

    <!-- ============ 第二步半：不在名单之内，她自己填 ============ -->
    <template v-else-if="step === 'self'">
      <span class="kicker">没关系</span>
      <h1 class="q">填几项就能开始用</h1>

      <label class="f">
        <span class="f__k">你的姓名</span>
        <input
          v-model="self.realName"
          class="f__in"
          type="text"
          autocomplete="name"
          maxlength="32"
          placeholder="你的名字"
        />
      </label>

      <label class="f">
        <span class="f__k">你所在的幼儿园</span>
        <input
          v-model="self.kindergartenName"
          class="f__in"
          type="text"
          maxlength="64"
          placeholder="幼儿园全名"
        />
      </label>

      <!--
        地区用**下拉**不用手打（用户 2026-09-21 定）。
        自由填会脏成「北京 / 北京市 / 北京朝阳」，而研究上要按地区分组 ——
        那种数据分不了组，而且脏了之后补不回来。
      -->
      <label class="f">
        <span class="f__k">地区</span>
        <select
          class="f__in f__in--select"
          :value="self.province || ''"
          @change="pickSelfProvince($event.target.value)"
        >
          <option value="">选一个省 / 直辖市</option>
          <option v-for="r in regions" :key="r.province" :value="r.province">
            {{ r.province }}
          </option>
        </select>
      </label>

      <label v-if="self.province" class="f">
        <span class="f__k">市</span>
        <select v-model="self.city" class="f__in f__in--select">
          <option :value="null">选一个市</option>
          <option v-for="c in cities" :key="c" :value="c">{{ c }}</option>
        </select>
      </label>

      <label class="f">
        <span class="f__k">园所类型</span>
        <select v-model="self.ownership" class="f__in f__in--select">
          <option :value="null">选一个</option>
          <option v-for="o in OWNERSHIPS" :key="o" :value="o">{{ o }}</option>
        </select>
      </label>

      <button type="button" class="alt" @click="backFromSelf">‹ 回到名单</button>
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
      <!-- 自填那一步：她填的东西比白名单老师多，所以按钮要判的条件也多 -->
      <s-button
        v-else-if="step === 'self'"
        label="完成，开始用"
        arrow
        :disabled="!canSelfSubmit"
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

const step = ref('code') // code | pick | self | account
const code = ref('')
const loading = ref(false)
const submitting = ref(false)

/* 四级下拉：省 → 市 → 园 → 人。
   ⚠️ 这是**这一屏的内部状态**，不是路由，也没有自己的 step 值 ——
   不然 showDock / backToKg / canActivate 全都要跟着改。 */
const regions = ref([])
const cities = ref([])
const kindergartens = ref([])
const entries = ref([])
const province = ref(null)
const city = ref(null)
const kg = ref(null)
const entry = ref(null)

/* 「不在名单之内」那条路。用户 2026-09-21 定：
   地区**下拉选**（不是自由填，否则数据会脏成「北京/北京市/北京朝阳」），
   还要填姓名、园所名、园所类型。 */
const self = ref({ realName: '', kindergartenName: '', province: null, city: null, ownership: null })
const OWNERSHIPS = ['公办', '普惠民办', '民办']

const phone = ref('')
const phoneConfirm = ref('')
const password = ref('')

/* 底部操作条：选名单那几步点选项本身就是动作，自填那一步要填完才出现按钮。
   ⚠️ 'self' 也要显示 dock —— 她在那一步需要「完成，开始用」那个按钮 */
const showDock = computed(() => step.value !== 'pick')

/* 跟兑换码那边同一个立场：只判「填了没有」，不判「填得对不对」。
   格式由后端说中文，比一个灰着的按钮有用 —— 灰按钮只会让她猜。 */
const canActivate = computed(() =>
  Boolean(phone.value.trim() && phoneConfirm.value.trim() && password.value)
)

/**
 * 自填那条路能不能提交。
 *
 * 只判「填了没有」—— **地区选了没有也要判**，因为它决定研究能不能分组，
 * 而空着提交会在后端报一句「地区从下拉里选一下」，不如按钮灰着直接。
 * ⚠️ 但这里**不判格式**（园所类型是不是在白名单里由后端说），
 * 保持跟别处一致：格式错了报中文，比灰按钮有用。
 */
const canSelfSubmit = computed(() =>
  Boolean(self.value.realName.trim() && self.value.kindergartenName.trim()
    && self.value.province && self.value.city && self.value.ownership
    && canActivate.value)
)

/** 她选的那一行，回显给她确认。只有姓氏 —— 全名不下发是后端定的 */
const whoLine = computed(() => {
  if (step.value === 'self') {
    const parts = [self.value.kindergartenName, self.value.province, self.value.city]
    return parts.filter(Boolean).join(' · ')
  }
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

  /* 🔴 取数据这一段**必须在调用下一级之前结束**。

     原来写成一个大 try，`loading` 到 finally 才复位，中间直接 `await pickKg(...)`。
     而 pickKg 第一行是 `if (loading.value) return` —— 于是「只有一个园就直接跳过」
     这条自动跳转**永远走不到**：点「下一步」什么都不会发生，
     而且不报错、不 toast，看起来就是按钮坏了。
     只有「全库只有一个园有空位」时才会出现，本地测不出来。

     所以先拿数据、先复位 loading，再交给下一步。 */
  regions.value = []
  try {
    const data = await rosterOptions(code.value.trim())
    regions.value = data.regions || []
  } catch (err) {
    showApiError(err)
    return
  } finally {
    loading.value = false
  }

  if (!regions.value.length) {
    /* 码是好的，但一个园都还没有 —— 可能名单没录，也可能位置都被认领完了。
       ⚠️ 这里**不挡住她**：她可以走「不在名单之内」。 */
    step.value = 'pick'
    return
  }
  /* 只有一个省 + 一个市就一路跳到底 —— 让她在只有一个选项的列表里点一下没有意义。
     ⚠️ 跳的时候也要先复位 loading，理由同上 */
  if (regions.value.length === 1) {
    const only = regions.value[0]
    if (only.cities.length === 1) {
      await pickCity(only.province, only.cities[0])
      return
    }
    await pickProvince(only.province)
    return
  }
  step.value = 'pick'
}

/** 选了省 —— 只有一个市就直接跳，否则列出市 */
async function pickProvince(p) {
  province.value = p
  city.value = null
  kindergartens.value = []
  loading.value = true
  try {
    const data = await rosterOptions(code.value.trim(), { province: p })
    cities.value = data.cities || []
  } catch (err) {
    showApiError(err)
    return
  } finally {
    loading.value = false
  }
  if (cities.value.length === 1) {
    await pickCity(p, cities.value[0])
    return
  }
  step.value = 'pick'
}

/** 选了市 —— 拉这个市下面的园。只有一个园就替她选上 */
async function pickCity(p, c) {
  province.value = p
  city.value = c
  kindergartens.value = []
  loading.value = true
  try {
    const data = await rosterOptions(code.value.trim(), { province: p, city: c })
    kindergartens.value = data.kindergartens || []
  } catch (err) {
    showApiError(err)
    return
  } finally {
    loading.value = false
  }
  /* 这个市下面的园全满员了。**不报错** —— 她还可以走「不在名单之内」，
     而那正是这一屏底下始终摆着那个选项的理由。 */
  if (!kindergartens.value.length) { step.value = 'pick'; return }
  if (kindergartens.value.length === 1) {
    await pickKg(kindergartens.value[0])
    return
  }
  step.value = 'pick'
}

async function pickKg(k) {
  if (loading.value) return
  kg.value = k
  loading.value = true
  try {
    const data = await rosterOptions(code.value.trim(), { kindergartenId: k.id })
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
  self.value = { realName: '', kindergartenName: '', province: null, city: null, ownership: null }
  step.value = 'account'
}

/** 「不在名单之内」—— 她自己填。地区用下拉，所以要先有一份地区清单 */
async function startSelf() {
  entry.value = null
  kg.value = null
  /* 地区清单从第一级接口拿。**每次进来都重拉**，不用缓存 ——
     她走这条路说明名单里没有她，而名单可能刚被人改过 */
  loading.value = true
  try {
    const data = await rosterOptions(code.value.trim())
    regions.value = data.regions || []
  } catch (err) {
    showApiError(err)
    return
  } finally {
    loading.value = false
  }
  step.value = 'self'
}

/** 自填那条路上选了省，要拉市 */
async function pickSelfProvince(p) {
  self.value.province = p
  self.value.city = null
  cities.value = []
  loading.value = true
  try {
    const data = await rosterOptions(code.value.trim(), { province: p })
    cities.value = data.cities || []
  } catch (err) {
    showApiError(err)
  } finally {
    loading.value = false
  }
}

/**
 * 「换一个」—— 退一级。
 *
 * ⚠️ 每一级都要判「上一级还剩几个选项」，只剩一个就继续往上退 ——
 * 否则她会退到一个只有一个选项的列表上，而那个列表刚才已经替她跳过了。
 * 这是四级之后新增的复杂度，三级的时候只有一次这种判断。
 */
function backToKg() {
  entries.value = []
  kg.value = null
  if (kindergartens.value.length > 1) { step.value = 'pick'; return }
  kindergartens.value = []
  if (cities.value.length > 1) { step.value = 'pick'; return }
  cities.value = []
  if (regions.value.length > 1) { step.value = 'pick'; return }
  step.value = 'code'
}

/** 自填那条路的返回 —— 回到选园所那一屏 */
function backFromSelf() {
  step.value = 'pick'
}

async function submitActivate() {
  if (submitting.value) return
  const isSelf = step.value === 'self'
  if (isSelf ? !canSelfSubmit.value : !canActivate.value) return

  submitting.value = true
  try {
    await activate({
      code: code.value.trim(),
      rosterEntryId: isSelf ? null : entry.value.id,
      /* 自填那几样**只在自填那条路上传**。
         `activate` 里用 `self?.x` 取，传 undefined 会被 JSON.stringify
         整个丢掉，所以路径一不会带上多余的字段。 */
      self: isSelf ? {
        realName: self.value.realName.trim(),
        kindergartenName: self.value.kindergartenName.trim(),
        province: self.value.province,
        city: self.value.city,
        ownership: self.value.ownership,
      } : undefined,
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

/*
  「不在名单之内」—— 它跟上面那个「换一个」**不是同一类东西**：
  那个是退一步，这个是换一条路。所以多一条分隔线 + 深一点的字色，
  不然她会把它当成「返回」点。

  ⚠️ 位置在四个层级的**底下**：能，在上面找到自己的人根本不会往下看；
  找不到时它正好在那儿。挪到顶部会让所有人都先看到它。
*/
.alt--self {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid $rule-2;
  color: $ink-2;
  font-weight: 600;
}

/* select 要跟 input 长得一样。原生 select 在 iOS 上默认样式差很远，
   不统一的话这一屏会看起来像两个不同的人做的 */
.f__in--select {
  appearance: none;
  -webkit-appearance: none;
  background-image: none;
}
</style>
