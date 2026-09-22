<template>
  <div class="pf">
      <div class="pf__body">
        <div class="pf__r">
          <span class="pf__k">园所</span>
          <input v-model="kg" class="pf__in" placeholder="阳光幼儿园" maxlength="64" />
        </div>

        <!--
          年级 / 岗位 / 最高学历 / 职称都是「从几个里挑一个」，所以用同一套胶囊。
          挑中的那个**必须多一个打勾**：黄底压奶油底亮度差只有 1.51:1，
          光靠颜色分不出哪个选中了（design-tokens 规则 3）。
          再点一次同一个 = 取消，她可能就是不想标。

          🔴 **没选中 ≠ 选了「未评级」。** 没选是 NULL（她没填过），
          「未评级」是她主动选的一个值 —— 两件事，任何地方不许把 NULL 显示成「未评级」。
          学历和职称是研究要用的自变量，混了就没法分析。
        -->
        <div v-for="g in PICKS" :key="g.key" class="pf__r pf__r--wrap">
          <span class="pf__k">{{ g.label }}</span>
          <div class="pf__opts">
            <button
              v-for="o in g.options"
              :key="o"
              type="button"
              class="band"
              :class="{ 'band--on': picks[g.key] === o }"
              @click="onPick(g.key, o)"
            >
              <img v-if="picks[g.key] === o" class="band__ck" :src="checkInk" alt="已选" />
              <span class="band__t" :class="{ 'band__t--on': picks[g.key] === o }">{{ o }}</span>
            </button>
          </div>
        </div>

        <!--
          出生年月 —— 两个并排的下拉，**内联不弹框**（用户 2026-09-21 定）。
          用跟首页同一个组件，年份范围和补零规则只写一份 ——
          写两份会分叉，而分叉的表现是「一处能选 1995-1、另一处只能选 1995-01」。
        -->
        <div class="pf__r">
          <span class="pf__k">出生年月</span>
          <s-birth v-model="born" dense />
        </div>

        <div class="pf__r">
          <span class="pf__k">教龄</span>
          <input v-model="years" class="pf__in pf__in--n" type="number" inputmode="numeric" maxlength="2" />
          <span class="pf__u">年</span>
        </div>
      </div>

      <div class="pf__foot">
        <s-button label="改好了" :loading="saving" @press="save" />
      </div>
  </div>
</template>

<script setup>
/**
 * 个人档案 —— 「我的」弹窗里的一节。
 *
 * 七项：园所 / 年级 / 岗位 / 最高学历 / 职称 / **出生年月** / 教龄。
 *
 * **归在「我的记忆」底下、是第一条但不参与编号**（用户 2026-08-21 定）：
 * 那一节的副标题就是「写教案时会自动带上」，而园所、年级、职称正是每次都会带上的东西 ——
 * 它跟下面那些记忆是同一类信息，只是它有固定的格子。
 * 不给它编号是因为编号是给「一条条攒起来的记忆」的（她会说「第 3 条删掉」）。
 *
 * **没有「取消」**（用户 2026-08-21 定）：放弃就再点一次上面那一行「个人档案」收起来。
 * 多一个「取消」等于给同一件事留两个入口。
 */
import { reactive, ref, watch } from 'vue'
import { updateMe } from '../api/me.js'
import { session } from '../stores/session.js'
import { iconCheck } from '../utils/icons.js'
import { useUnsavedChanges } from '../utils/unsaved.js'
import { COLORS } from '../utils/colors.js'
import { showApiError, toast } from '../utils/ui.js'
import sBirth from './s-birth.vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
})

const emit = defineEmits(['close'])

const checkInk = iconCheck(COLORS.ink, 2.6)

const PICKS = [
  { key: 'age_group', label: '年级', options: ['小班', '中班', '大班'] },
  { key: 'position', label: '岗位', options: ['主班', '配班', '保育员', '园长', '其他'] },
  { key: 'education', label: '最高学历', options: ['中专及以下', '大专', '本科', '硕士及以上'] },
  {
    key: 'professional_title',
    label: '职称',
    options: ['未评级', '初级', '中级', '副高级', '正高级'],
  },
]

const kg = ref('')
const years = ref('')
/* 出生年月（2026-09-21 加）。**自由输入不是选项** ——
   它是 `YYYY-MM` 字符串，不是枚举，所以不放进 PICKS */
const born = ref('')
const picks = reactive({})
const saving = ref(false)
useUnsavedChanges(() => {
  if (!props.visible) return false
  const t = session.teacher || {}
  return saving.value || kg.value.trim() !== (t.kindergarten_name || '') ||
    String(years.value).trim() !== String(t.teaching_years ?? '') ||
    born.value !== (t.birth_month || '') || PICKS.some((g) => picks[g.key] !== (t[g.key] || ''))
})

/**
 * 每次**打开**都从 session 重新灌一遍，不留上次没保存的残留：
 * 她点开、改两个字、关掉，下次点开还看到那两个字，会以为已经存进去了。
 */
watch(
  () => props.visible,
  (on) => {
    if (!on) return
    const t = session.teacher || {}
    kg.value = t.kindergarten_name || ''
    // `?? ''` 不是 `|| ''`：教龄 0 是有意义的值（今年刚来的新老师），
    // 用 || 会把它显示成空的
    years.value = t.teaching_years ?? ''
    born.value = t.birth_month || ''
    for (const g of PICKS) picks[g.key] = t[g.key] || ''
  },
  { immediate: true }
)

/** 再点一次同一个 = 取消。她可能就是不想标这一项 */
function onPick(key, option) {
  picks[key] = picks[key] === option ? '' : option
}

async function save() {
  if (saving.value) return
  const t = session.teacher || {}
  const fields = {}

  const kgText = kg.value.trim()
  if (kgText !== (t.kindergarten_name || '')) fields.kindergarten_name = kgText || null

  for (const g of PICKS) {
    if (picks[g.key] !== (t[g.key] || '')) fields[g.key] = picks[g.key] || null
  }

  const raw = String(years.value).trim()
  const n = raw === '' ? null : Number(raw)
  if (n !== null && (!Number.isInteger(n) || n < 0 || n > 60)) {
    return toast('教龄填 0 到 60 之间的整数')
  }
  if (n !== (t.teaching_years ?? null)) fields.teaching_years = n

  /* 出生年月。**前端也判一次格式** —— 后端和数据库那条 CHECK 都会挡，
     但让一个 500 或者「出生年月像 1995-12 这样填」替她说出「你打错了」
     不如在本地就拦住。判据跟后端那条正则完全一致，两边别改歪一处。 */
  const bornText = born.value.trim()
  if (bornText && !/^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(bornText)) {
    return toast('出生年月像 1995-12 这样填')
  }
  if (bornText !== (t.birth_month || '')) fields.birth_month = bornText || null

  // 一个字都没动就直接关掉，不发请求
  if (!Object.keys(fields).length) return emit('close')

  saving.value = true
  try {
    // 后端返回的就是更新后的 teacher，直接接住，省一次 GET /me
    session.teacher = await updateMe(fields)
    emit('close')
    toast('改好了')
  } catch (err) {
    showApiError(err)
  } finally {
    saving.value = false
  }
}
</script>

<style lang="scss" scoped>
.pf {
  padding-bottom: $sp-2;
}

.pf__body {
  padding: 4px 0 0;
}

.pf__r {
  display: flex;
  align-items: center;
  padding: 8px 0;

  &--wrap {
    align-items: flex-start;
    flex-wrap: wrap;
  }
}

.pf__k {
  flex: none;
  width: 62px;
  font-size: var(--fs-sub);
  color: $ink-3;
  line-height: 1.6;
  padding-top: 3px;
}

.pf__in {
  flex: 1;
  min-width: 0;
  outline: none;
  border: 1px solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 8px 11px;
  font-size: var(--fs-body);
  color: $ink;

  &--n {
    flex: none;
    width: 72px;
  }
}

.pf__in::placeholder {
  color: $ink-3;
}

/*
  出生年月那个「输入框」其实是个按钮（点开是滚轮）。
  样式跟 `.pf__in` 对齐 —— 她不该看出这里跟别的格有什么不同，
  只是点下去弹的是滚轮不是键盘。
*/
.pf__pick {
  flex: 1;
  min-width: 0;
  outline: none;
  border: 1px solid $rule-2;
  border-radius: $r-btn;
  background: $white;
  padding: 8px 11px;
  font-size: var(--fs-body);
  color: $ink;
  text-align: left;
}

.pf__pick:active {
  border-color: $mint;
}

.pf__u {
  font-size: var(--fs-sub);
  color: $ink-3;
  margin-left: 6px;
}

.pf__opts {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
}

.band {
  display: flex;
  align-items: center;
  border: 1px solid $rule-2;
  border-radius: $r-chip;
  background: $paper-2;
  padding: 4px 10px;
  margin: 0 5px 5px 0;
}

.band--on {
  background: $amber;
  border-color: $amber-line;
}

.band__ck {
  width: 11px;
  height: 11px;
  margin-right: 3px;
}

.band__t {
  font-size: var(--fs-sub);
  color: $ink-2;
  line-height: 1.5;

  &--on {
    color: $ink;
    font-weight: 600;
  }
}

.pf__foot {
  padding-top: $sp-2;
}
</style>
