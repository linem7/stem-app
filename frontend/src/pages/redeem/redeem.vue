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
        <button type="button" class="alt" @click="backToCity">‹ 换一个市</button>
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
        <!-- 🔴 回退。用户 2026-09-21 指出：走到某一级发现没有自己
             就只能刷新页面重来 —— 四级里原来只有最底那一级有回退 -->
        <button type="button" class="alt" @click="backToProvince">‹ 换一个地区</button>
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
        <!-- 第一级的回退是「退回输码」—— 上面没有更上一级了 -->
        <button type="button" class="alt" @click="backToCode">‹ 重新输兑换码</button>
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

      <!--
        **只要姓氏，不要全名**（用户 2026-09-21 定）。
        之后系统里就叫她「{姓氏}老师」。跟白名单那条路同一个立场：
        姓名只给姓氏 —— 认出自己只需要一个字，收集全名没有必要。
      -->
      <label class="f">
        <span class="f__k">你的姓氏</span>
        <input
          v-model="self.surname"
          class="f__in"
          type="text"
          autocomplete="off"
          maxlength="2"
          placeholder="比如 林"
        />
        <span class="f__hint">只用姓氏就够了，之后叫你 {{ self.surname || '某' }}老师</span>
      </label>

      <!--
        地区：**中国的省市，不限已有园所**（用户 2026-09-21 定）。
        白名单那条路的第一级是从园所表 DISTINCT 出来的（只有实际有园的省市），
        而她不在名单里，所以不该被那几个市框住 —— 她是哪儿的就得能选哪儿。

        ⚠️ **省市并排**（用户 2026-09-21 定）：选中省之后，右边的市**立刻**可用。
        分两行的话先选完省还要往下找第二个框，而它们本来是一件事（「你在哪」）。
        窄屏上两栏各占一半，长省名（新疆维吾尔自治区）会截断 —— 见下面
        `.f__2` 的注释。
      -->
      <div class="f">
        <span class="f__k">你所在的地区</span>
        <div class="f__2">
          <select v-model="self.province" class="f__in f__in--select">
            <option :value="null">请选择</option>
            <option v-for="p in CHINA" :key="p.n" :value="p.n">{{ p.n }}</option>
          </select>
          <select v-model="self.city" class="f__in f__in--select" :disabled="!self.province">
            <option :value="null">请选择</option>
            <option v-for="c in selfCities" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <!-- 选完把组合回显成「广东 - 广州」。她要在提交前看到这一条是什么 -->
        <span v-if="self.province && self.city" class="f__hint">
          {{ self.province }} - {{ self.city }}
        </span>
      </div>

      <label class="f">
        <span class="f__k">园所类型</span>
        <select v-model="self.ownership" class="f__in f__in--select">
          <option :value="null">请选择</option>
          <option v-for="o in OWNERSHIPS" :key="o" :value="o">{{ o }}</option>
        </select>
      </label>

      <button type="button" class="alt" @click="backFromSelf">‹ 回到名单</button>
    </template>

    <!-- ============ 第三步：手机号 + 密码 ============ -->
    <!-- 白名单老师（entry 有值）和自填的人（selfName 有值）走的是**同一个屏**，
         只是顶上那句回显不一样。分成两屏会让「手机号要输两遍」那套规矩
         在两处各写一遍 —— 而这个项目已经因为「同一件事写两份」踩过几次。 -->

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
        <!-- 不一致时当场说，不用等她点提交往返一次 -->
        <span v-if="phoneMismatch" class="f__bad">两边不一样，核对一下</span>
        <span v-else class="f__hint">打错一位的话，你下次就登不进来了 —— 所以核对一下</span>
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

      <!--
        回退（用户 2026-09-21 指出：这一屏原来没有回退）。

        ⚠️ **两条路回的地方不一样**，而且不能都退到「名单」——
        不在名单的人退到名单会看到一份没有她的列表，那是条死路。
        白名单老师退回去还能换一个位置。
      -->
      <button type="button" class="alt" @click="backFromAccount">
        {{ entry ? '‹ 回去换一个位置' : '‹ 回去改资料' }}
      </button>
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
      <!--
        自填那一步是「下一步」不是「完成」——
        2026-09-21 修：原来它直接调 activate，而那时手机号和密码还是空的，
        后端报「手机号看起来不对」，她就卡在这一屏了。
        自填的人跟白名单老师一样，**资料填完还要设账号**。
      -->
      <s-button
        v-else-if="step === 'self'"
        label="下一步"
        :disabled="!canSelfSubmit"
        @press="goAccount"
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
/* 完整的中国省市清单 —— **只给「不在名单」那条路用**。
   白名单那条路的地区是从园所表 DISTINCT 出来的（只有实际有园的省市），
   而她不在名单里，不该被那几个市框住。 */
import { CHINA } from '../../utils/chinaRegions.js'

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

/**
 * 「不在名单之内」那条路。
 *
 * 用户 2026-09-21 定的几处（第二轮修改）：
 *   · **只要姓氏，不要全名** —— 之后就叫「林老师」。跟白名单那条路一致：
 *     姓名只给姓氏，全名不下发也不收集
 *   · **不填所在幼儿园名称** —— 收集它没有用途，少收一样可识别信息就少一整套义务
 *   · **地区用中国的省市写法**，而且**不能只限于已有园所所在的那几个市**
 *     （见 `allRegions` 那段注释）
 */
const self = ref({ surname: '', province: null, city: null, ownership: null })
const OWNERSHIPS = ['公办', '普惠民办', '民办']

const phone = ref('')
const phoneConfirm = ref('')
const password = ref('')

/* 底部操作条：选名单那几步点选项本身就是动作，自填那一步要填完才出现按钮。
   ⚠️ 'self' 也要显示 dock —— 她在那一步需要「完成，开始用」那个按钮 */
const showDock = computed(() => step.value !== 'pick')

/**
 * 两遍手机号一致吗。
 *
 * 🔴 用户 2026-09-21 报：「没有对两次手机号码的一致性进行核对」。
 * 根因在后端（`phoneAgain && ...` 那个 falsy 判断把「第二遍填错」整条跳过了），
 * 但**前端也该当场告诉她** —— 让她填完整个表单、点提交、
 * 等一个来回才被告知「两边不一样」，是最不必要的等待。
 *
 * ⚠️ 判据是「两遍都填了、而且不相等」，**不是**「不相等就报错」——
 * 第二个框还空着的时候不该立刻冒红字（她正在打字）。
 *
 * ⚠️ **必须定义在 `canActivate` 之前** —— 后者引用它。
 * computed 是惰性的、不会立刻求值，但 `const` 有 TDZ，
 * 顺序反了会是「Cannot access before initialization」而不是算错。
 */
const phoneMismatch = computed(() => {
  const a = phone.value.trim()
  const b = phoneConfirm.value.trim()
  return Boolean(a && b && a !== b)
})

/* 跟兑换码那边同一个立场：只判「填了没有」，不判「填得对不对」。
   格式由后端说中文，比一个灰着的按钮有用 —— 灰按钮只会让她猜。
   ⚠️ 唯一的例外是「两遍手机号不一致」—— 那不是格式问题，是她刚打完
   而旁边没有打勾，见 `phoneMismatch`。 */
const canActivate = computed(() =>
  Boolean(phone.value.trim() && phoneConfirm.value.trim() && password.value)
  && !phoneMismatch.value
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
  Boolean(self.value.surname.trim()
    && self.value.province && self.value.city && self.value.ownership)
)

/** 她是走「不在名单」那条路吗 —— 两条路共用最后那屏，用这个分辨 */
const isSelfPath = computed(() => (
  step.value === 'self' || (step.value === 'account' && !entry.value)
))

/** 自填那条路：她选的省对应的市列表（从 CHINA 里取，不查库） */
const selfCities = computed(() => (
  CHINA.find((p) => p.n === self.value.province)?.c || []
))

/**
 * 她是谁 —— 回显给她确认。
 *
 * 两条路都有这一行，因为这一步（设手机号密码）是两条路共用的。
 * 白名单老师显示园所 + 班级岗位 + 姓氏；自填的人只有姓氏和地区
 * （**她不填园所名**，见下面 `self` 的注释）。
 */
const whoLine = computed(() => {
  if (isSelfPath.value) {
    const parts = [self.value.surname, self.value.province, self.value.city]
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
  // 清掉自填那条路的残留，免得两条路的数据串味
  self.value = { surname: '', province: null, city: null, ownership: null }
  step.value = 'account'
}

/**
 * 「不在名单之内」—— 她自己填。
 *
 * ⚠️ **不拉接口**：她选的省市来自 `CHINA`（前端那份完整中国省市清单），
 * 不来自库里的园所。她不在名单里，不该被「实际有园的省市」框住
 * —— 她是哪儿的就得能选哪儿（用户 2026-09-21 定）。
 */
function startSelf() {
  entry.value = null
  kg.value = null
  self.value = { surname: '', province: null, city: null, ownership: null }
  step.value = 'self'
}

/**
 * 自填那条路的「下一步」—— 进设账号那屏。
 *
 * 🔴 这是 2026-09-21 修的那个 bug：原来自填那屏的按钮直接调 `submitActivate`，
 * 而那时 `phone` / `password` 还是空的，后端报「手机号看起来不对」，
 * 她反复点都进不去。**资料和账号是两步**，两条路都一样。
 */
function goAccount() {
  if (!canSelfSubmit.value) return
  // entry 保持 null —— 最后一屏靠它分辨「这是自填的人」
  self.value.surname = self.value.surname.trim()
  step.value = 'account'
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

/**
 * 从「选市」退回「选地区」。
 *
 * 🔴 用户 2026-09-21 指出：**走到某一级发现没有自己，原来只能刷新页面重来** ——
 * 四级里只有最底那一级（选人）有回退，上面三级一个都没有。
 *
 * ⚠️ **不能直接 `step = 'pick'`。** 上面那几级是「按当前数据渲染哪一段」的，
 * 不清掉下一级的数据，`v-if` 会渲染到**更深的那一段**（因为
 * `kindergartens.length` 还非空），她会看到自己明明点了「换一个地区」
 * 却还停在选园所那一屏 —— 一个「点了没反应」的按钮。
 * 所以退一级必须**把它下面各级的数据全清掉**。
 */
function backToProvince() {
  cities.value = []
  province.value = null
  city.value = null
  kindergartens.value = []
  backToCodeOrRegions()
}

/** 从「选园所」退回「选市」 */
function backToCity() {
  /* ⚠️ **只清下面一级是不够的。**
     模板是按 `entries → kindergartens → cities → regions` 的顺序 `v-if` 的，
     所以「退到选市」意味着**必须把 cities 也清掉** —— 留着它的话
     `v-if` 仍然命中 `cities.length` 那一段，渲染回「② 选市」，
     而她点的正是「换一个市」，看起来就是点了没反应。
     （这个 bug 是我写完之后拿真逻辑跑了一遍才发现的。） */
  kindergartens.value = []
  entries.value = []
  cities.value = []
  city.value = null
  province.value = null
  backToCodeOrRegions()
}

/**
 * 退回第一级的入口。
 *
 * ⚠️ 只有一个地区时没有可退的地方（刚才已经替她跳过了），
 * 那就退回输码那一步 —— 否则她会退到一个只有一个选项的列表上。
 */
function backToCodeOrRegions() {
  if (regions.value.length > 1) { step.value = 'pick'; return }
  backToCode()
}

/** 退回输码那一步。清空所有层级的数据 —— 否则回来时会看到上一次的残留 */
function backToCode() {
  regions.value = []
  cities.value = []
  kindergartens.value = []
  entries.value = []
  province.value = null
  city.value = null
  kg.value = null
  step.value = 'code'
}

/** 自填那条路的返回 —— 回到选园所那一屏 */
function backFromSelf() {
  step.value = 'pick'
}

/**
 * 设账号那一屏的回退（用户 2026-09-21 指出这一屏原来没有回退）。
 *
 * ⚠️ 两条路回的地方不一样：
 *   · 白名单老师 → 回去换一个位置（`pick`）
 *   · 不在名单的人 → 回去改资料，**不能退到名单** ——
 *     名单上本来就没有她，退过去是一份空列表，那是条死路
 */
function backFromAccount() {
  step.value = entry.value ? 'pick' : 'self'
}

async function submitActivate() {
  if (submitting.value || !canActivate.value) return

  /* ⚠️ 判据是 `entry` 有没有值，**不是 `step === 'self'`** ——
     自填的人在设账号那一屏上 `step` 是 `'account'`，用它判会走错分支。 */
  const isSelf = !entry.value

  submitting.value = true
  try {
    await activate({
      code: code.value.trim(),
      rosterEntryId: isSelf ? null : entry.value.id,
      /* 自填那几样**只在自填那条路上传**。
         `activate` 里用 `self?.x` 取，传 undefined 会被 JSON.stringify
         整个丢掉，所以路径一不会带上多余的字段。 */
      self: isSelf ? {
        surname: self.value.surname,
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

/* 省市并排。两栏等宽 —— 不等宽的话「新疆维吾尔自治区」会把左栏撑开，
   而右栏的市名都很短，白占宽度。
   ⚠️ 窄屏上长省名会被截断（select 里没法换行），这是有意的取舍：
   并排的好处是「选中省、市立刻在右边出现」这件事一眼看得见，
   而截断的部分她点开下拉就看到了全称。 */
.f__2 {
  display: flex;
  gap: 8px;
}

.f__2 > .f__in {
  flex: 1;
  min-width: 0;
}

/* 禁用态：省还没选时右边的市是这个状态。灰掉是告诉她「先选左边」，
   而不是让她点开一个空列表 */
.f__in:disabled {
  background: $paper-2;
  color: $ink-3;
}

/* 不一致时的提示。**用珊瑚红**（design-tokens 里出错用的那一档），
   跟上面薄荷绿的 hint 明显不同色 —— 换行位置一样的两种字，
   只靠措辞区分的话她会读成同一件事 */
.f__bad {
  display: block;
  font-size: var(--fs-sub);
  color: $coral-deep;
  line-height: 1.65;
  margin-top: 6px;
}
</style>
