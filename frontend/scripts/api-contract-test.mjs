/**
 * 前端请求层契约验证。
 *
 * 跑的是 src/api/ 和 src/utils/request.js 里**真正会上线的那份代码**，不是另写一遍 fetch ——
 * 所以路径写错、字段名对不上、信封拆错，这里都会红。
 *
 * 转成 web 之后请求层就是 fetch，node 20 自带，**不用再补任何平台桩**。
 * 本机存储（登录令牌、开发期假 openid）由 src/utils/storage.js 自己退到内存 Map。
 *
 * 前置：后端 npm start 起在 3000；后台账号见 backend/.env 的 ADMIN_PASSWORD。
 * 自造隔离数据，可反复跑。
 *
 *   node scripts/api-contract-test.mjs            # 不花模型额度
 *   node scripts/api-contract-test.mjs --generate # 连生成教案一起跑（花 DeepSeek 额度，约 30 秒）
 */

const BASE = process.env.API_BASE || 'http://localhost:3000'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456'
const WITH_GENERATE = process.argv.includes('--generate')

// 必须在 import 业务模块之前设好 —— utils/env.js 是在模块加载时读的
process.env.VITE_API_BASE = `${BASE}/v1`

/* ============ 断言 ============ */

let failed = 0
const L = console.log
const chk = (cond, msg) => {
  L(`  ${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failed++
}

async function expectError(label, code, fn) {
  try {
    await fn()
    chk(false, `${label} —— 本该报 ${code}，却成功了`)
  } catch (err) {
    chk(err.code === code, `${label} → ${err.code}${err.code === code ? '' : `（期望 ${code}）`}`)
  }
}

/* ============ 造一个隔离的兑换码 ============ */

const RND = String(Date.now()).slice(-8)

async function makeCode() {
  const adminLogin = await fetch(`${BASE}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  }).then((r) => r.json())
  if (!adminLogin.ok) throw new Error(`管理后台登录失败：${adminLogin.error?.message}`)
  const tok = adminLogin.data.token

  const post = async (p, body) => fetch(`${BASE}/admin/api${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  }).then((r) => r.json())

  // 激活要三样：码（一张入场券，不带身份）+ 从名单里选的位置 + 她自己设的手机号密码。
  // 园所/班级/岗位全部来自名单那一行，她一个字都不用填
  const kg = await post('/kindergartens', { name: `契约测试园_${RND}` })
  const imp = await post('/roster/import', {
    text: `契约测试老师${RND}, 中一班, 主班, 中班`,
    kindergarten_id: kg.data.id,
    dry_run: false,
  })
  if (!imp.ok) throw new Error(`导名单失败：${imp.error?.message}`)

  const made = await post('/codes', {
    kindergarten_id: kg.data.id, init_text: 20, init_image: 10, grant_reason: '前端契约测试',
  })
  if (!made.ok) throw new Error(`建码失败：${made.error?.message}`)
  return { code: made.data.code, slot: imp.data.created[0].id }
}

/* ============ 正式跑 ============ */

const { code, slot } = await makeCode()
L(`（本轮兑换码：${code}，名单位置 #${slot}）\n`)

/* 手机号每轮都不一样：上一轮的账号还在库里，撞号会走进「已经注册过了」那条分支。
   11 位，1 开头第二位 8，跟后端 /^1[3-9]\d{9}$/ 对得上。 */
const PHONE = `138${String(Date.now()).slice(-8)}`
const PASSWORD = 'contract123456'

const authApi = await import('../src/api/auth.js')
const meApi = await import('../src/api/me.js')
const convApi = await import('../src/api/conversations.js')
const feedbackApi = await import('../src/api/feedback.js')
const requestMod = await import('../src/utils/request.js')
const sessionMod = await import('../src/stores/session.js')

L('=== 1. 还没登录：这是一个正常状态，不是错误 ===')
const nobody = await sessionMod.ensureSession()
chk(nobody === null, 'session.teacher 是 null')
/* 🔴 这一条守的是「第一次来的人看到的界面」。
   静默登录那套没了之后，没 token 成了最常见的情况 ——
   要是 bootstrap 把「没登录」当失败，每个新老师一进来就先看到一个错误框。 */
chk(sessionMod.session.bootError === null, 'bootError 仍然是 null —— 不能把「没登录」当成失败')
chk(sessionMod.gate() === 'redeem', 'gate() → redeem（去激活页，那一页底下有去登录的路）')

/* ⚠️ 原来这里有一条「没激活时业务接口被 NOT_ACTIVATED 拦下」。现在测不了了 ——
   teachers 行只有 /auth/activate 一处会建，而它当场就置 activated_at，
   所以 `requireActivated` 的**前半段**（`!activated_at`）走不到。

   后半段（`!agreed_at`）还活着，而且是必须的 ——
   ops-test 的「激活了但没同意协议」那一节盯着它。 */

L('\n=== 2. 拉名单必须先有一个有效的码 ===')
// 后端靠这道门挡住「任何人打开网页就能看到一整个园的老师名单」
await expectError('乱填的码', 'VALIDATION_FAILED', () => authApi.rosterOptions('STEM-0000-0000'))
const opts = await authApi.rosterOptions(code)
chk(Array.isArray(opts.kindergartens) && opts.kindergartens.length > 0,
  `有码就拿到有空位的园：${opts.kindergartens?.length} 个`)
const picked = await authApi.rosterOptions(code, opts.kindergartens.find((k) => k.open > 0).id)
chk(picked.entries.every((e) => e.surname && !('real_name' in e)),
  '选择器只给姓氏，不给全名')

L('\n=== 3. 激活：码 + 名单 + 手机号 + 密码 ===')
await expectError('两次手机号不一样', 'VALIDATION_FAILED', () => authApi.activate({
  code, rosterEntryId: slot, phone: PHONE, phoneConfirm: '13900001111', password: PASSWORD,
}))
await expectError('手机号不是 11 位', 'VALIDATION_FAILED', () => authApi.activate({
  code, rosterEntryId: slot, phone: '12345', phoneConfirm: '12345', password: PASSWORD,
}))
await expectError('密码太短', 'VALIDATION_FAILED', () => authApi.activate({
  code, rosterEntryId: slot, phone: PHONE, phoneConfirm: PHONE, password: '123',
}))

// 故意把码写脏（小写、空格替代横线、前后带空格）—— 输入宽容由后端负责
const dirty = `  ${code.toLowerCase().replace(/-/g, ' ')} `
const activated = await sessionMod.activate({
  code: dirty, rosterEntryId: slot, phone: PHONE, phoneConfirm: PHONE, password: PASSWORD,
})
chk(sessionMod.session.teacher.activated === true, `脏码 "${dirty.trim()}" 也认得出来`)
chk(Boolean(activated.granted || activated.quota), '激活同时发了首笔额度')
chk(sessionMod.session.teacher.class_name === '中一班', '身份从名单那一行搬过来了')
chk(!('phone' in activated.teacher) && !('real_name' in activated.teacher),
  '响应里没有 phone / real_name（铁律）')
chk(requestMod.getToken().length > 20, '建完账号直接给了 token，不用再登一次')
chk(sessionMod.gate() === 'agreement', 'gate() → agreement')

L('\n=== 3.5 一个码只能兑一次 ===')
await expectError('拿刚用掉的码再激活', 'VALIDATION_FAILED', () => authApi.activate({
  code, rosterEntryId: slot, phone: `139${String(Date.now()).slice(-8)}`,
  phoneConfirm: `139${String(Date.now()).slice(-8)}`, password: PASSWORD,
}))

L('\n=== 3.6 换设备：清掉 token，用手机号 + 密码登回来 ===')
// 这一节是这轮功能的**核心验收**。前面建账号、发额度都只是它的前提。
requestMod.clearToken()
sessionMod.session.teacher = null
sessionMod.session.ready = false

await expectError('密码填错', 'UNAUTHORIZED', () => authApi.login(PHONE, 'wrongpass'))
/* 🔴 没注册过的号必须回**一模一样**的话。
   两句不一样就等于白送一个「查这个手机号在不在我们库里」的接口 ——
   而老师最怕的正是「园长知道我用了 AI 写教案」。 */
await expectError('没注册过的号（文案必须跟上面一模一样）', 'UNAUTHORIZED',
  () => authApi.login('13900009999', 'whatever'))

await sessionMod.login(PHONE, PASSWORD)
chk(sessionMod.session.teacher.activated === true, '登回来的是同一个账号')
chk(sessionMod.session.teacher.class_name === '中一班', '身份还在（班级对得上）')
chk(requestMod.getToken().length > 20, '新 token 落到了 storage')
chk(sessionMod.gate() === 'agreement', 'gate() → agreement（协议还没签）')

L('\n=== 4. 协议 ===')
await sessionMod.agree()
chk(sessionMod.session.teacher.agreed === true, 'agreed=true')
chk(sessionMod.gate() === 'main', 'gate() → main')

L('\n=== 5. 额度台账 ===')
const q = await meApi.getQuota()
chk(q.quota?.text?.left > 0, `文案额度 left=${q.quota?.text?.left}`)
chk(Array.isArray(q.grants) && q.grants.length > 0, `台账 ${q.grants?.length} 条，老师能对账`)

L('\n=== 6. 开会话 + 一屏 4 题 ===')
const conv = await convApi.createConversation('我想做个浮与沉的活动')
chk(Boolean(conv.conversation_id), `conversation_id=${conv.conversation_id}`)
chk(conv.questions?.length === 4, `一次给全 ${conv.questions?.length} 题`)
chk(conv.progress?.total === 4, `progress.total=${conv.progress?.total}`)
const ageQ = conv.questions.find((x) => x.key === 'age_group')
chk(Boolean(ageQ) && ageQ.required === true, '年龄班是唯一必答项')

L('\n=== 7. 每答一题即落库，且不限顺序 ===')
// 故意从第三题开始答，验证乱序
const venueQ = conv.questions.find((x) => x.key === 'venue')
const a1 = await convApi.answerQuestion(conv.conversation_id, {
  questionId: venueQ.id,
  selected: [venueQ.options[0].key],
})
chk(a1.progress?.answered === 1, `先答场地 → answered=${a1.progress?.answered}`)
chk(a1.can_finish === false, 'can_finish=false（年龄班还没答）')

const a2 = await convApi.answerQuestion(conv.conversation_id, {
  questionId: ageQ.id,
  selected: [ageQ.options.find((o) => o.label === '小班')?.key || ageQ.options[0].key],
})
chk(a2.can_finish === true, '答完年龄班 → can_finish=true')
// 引导页底部那个按钮是拿 required_left 判能不能按的，所以这条必须跟着归零，
// 否则「年龄班答了但按钮还是灰的」
chk(a2.progress?.required_left === 0, `required_left=${a2.progress?.required_left}（按钮据此解禁）`)
chk(typeof a2.ack === 'string' && a2.ack.length > 0, `ack 有话说：${String(a2.ack).slice(0, 24)}…`)

// 覆盖：同一题再答一次不该报错，也不该把 answered 加成 3
const a3 = await convApi.answerQuestion(conv.conversation_id, {
  questionId: venueQ.id,
  selected: [venueQ.options[venueQ.options.length - 1].key],
})
chk(a3.progress?.answered === 2, `重复提交是覆盖不是新增（answered=${a3.progress?.answered}）`)

L('\n=== 7.5 必答题不接受空答案 ===')
// 引导页原来写成「再点一下取消选择」，点在年龄班上就是这个 400。
// 现在前端对必答题不给取消，这条留着守住后端的行为不变。
await expectError('把年龄班取消掉', 'VALIDATION_FAILED', () =>
  convApi.answerQuestion(conv.conversation_id, { questionId: ageQ.id, selected: [] })
)

L('\n=== 8. 换年龄班重拉推荐答案 ===')
const re = await convApi.refetchQuestions(conv.conversation_id, '大班')
// api-spec 写的是「除年龄班外的三题」，后端实际把 4 题都返回了。
// 前端按 question id 合并，返回 3 题还是 4 题都不影响 —— 但这条记下来，是文档该跟实现对齐。
chk(re.questions?.length >= 3, `重拉到 ${re.questions?.length} 题（spec 写 3，实际 ${re.questions?.length}）`)
chk(
  re.questions.every((x) => conv.questions.some((y) => y.id === x.id)),
  '重拉的题 id 与首次一致，前端可按 id 原地换推荐答案'
)
/**
 * 关键：**字母不是稳定标识**。换班后 A/B/C 指向的文案会变，
 * 所以前端必须按 label 重新对位，不能把勾原样留在原字母上。
 *
 * 这一条**只能观察，不能断言**。原来写成硬断言（「同一字母指向的文案一定变了」），
 * 而选项是模型生成的 —— 某一轮它恰好给出一样的文案，这条就无辜地变红。
 * 它自己的失败文案都写着「这一轮字母恰好没变」，说明当时就知道会这样。
 * **一个会随机变红的断言，红两次之后整份脚本就没人看了**，
 * 所以改成打一行观察结果，把那条纪律留在注释里。
 */
const venueBefore = conv.questions.find((x) => x.key === 'venue')
const venueAfter = re.questions.find((x) => x.key === 'venue')
chk(
  venueBefore.options.length > 0 && venueAfter.options.length > 0,
  '换班后场地那题仍然有推荐答案'
)
const movedAt = venueBefore.options.findIndex(
  (o, i) => venueAfter.options[i] && venueAfter.options[i].label !== o.label
)
L(movedAt >= 0
  ? `    （这一轮 ${venueBefore.options[movedAt].key} 指向的文案变了：${venueBefore.options[movedAt].label} → ${venueAfter.options[movedAt].label}）`
  : '    （这一轮字母恰好指向同样的文案 —— 但它不稳定，前端仍然必须按 label 对位）')
const still = await convApi.getConversation(conv.conversation_id)
chk(still.progress?.answered === 2, '已填答案没被清空')

L('\n=== 8.5 断点续写：引导页靠 GET /conversations/:id 原样还原那一屏 ===')
chk(still.questions?.length === 4, `草稿会带回 ${still.questions?.length} 道题`)
chk(
  still.questions.every((q) => Array.isArray(q.options) && q.options.every((o) => o.key && o.label)),
  '每题都有 options，且每项有 key 和 label'
)
const restored = still.answers?.[venueQ.id]
chk(Boolean(restored), 'answers 按 question_id 归位')
chk(
  Array.isArray(restored?.selected) && 'custom_text' in restored,
  `字段名对得上：selected=${JSON.stringify(restored?.selected)}, custom_text=${restored?.custom_text}`
)

L('\n=== 9. 教案库 ===')
const lib = await convApi.listConversations({ status: 'all' })
chk(Array.isArray(lib.items), `拿到 ${lib.items?.length} 条`)
chk(Boolean(lib.counts), `counts=${JSON.stringify(lib.counts)}`)
chk(lib.items.some((i) => i.id === conv.conversation_id), '刚开的这条在库里（草稿也进库）')

L('\n=== 10. 记忆与反馈 ===')
const mem = await meApi.listMemories()
chk(Array.isArray(mem.items), `记忆 ${mem.items?.length} 条`)
const added = await meApi.addMemory('园里没有投影仪')
chk(Boolean(added.id ?? added.item?.id), '手动加记忆成功')
const fb = await feedbackApi.sendFeedback({ category: 'usability', text: '契约测试提交的建议' })
chk(fb.received === true, '产品建议已收到')

/* ============ 10.5 改档案走的是 POST 别名 ============ */
//
// 这一节的价值在于它跑的是**真的 src/api/me.js**：路径写错、字段名对不上，这里当场红。
//
// ⚠️ 「为什么是 POST 别名而不是 PATCH」这条理由**在 web 端已经不成立了**：
// 那是微信 wx.request 发不出 PATCH 留下的。现在 fetch 两个都发得出，
// 请求层也不再拦 PATCH。别名照旧通着，所以这里没改；
// 真要收敛成 PATCH，得先改 api-spec.md，跟后端那一批一起做。

L('\n=== 10.5 改档案（POST /me/update 别名）===')
{
  const KG = `契约测试园_${Date.now().toString().slice(-6)}`
  const updated = await meApi.updateMe({ kindergarten_name: KG, teaching_years: 3, age_group: '大班' })
  chk(updated.kindergarten_name === KG, 'updateMe 改园所名成功（说明走的是 POST 别名）')
  chk(updated.teaching_years === 3 && updated.age_group === '大班', '教龄和年龄班一起改')
  chk(updated.profile_completed === true, 'profile_completed 变成 true')

  const back = await meApi.getMe()
  chk(back.kindergarten_name === KG, '重新拉一次，改动确实落了库')
  chk(!('real_name' in back) && !('openid' in back), '真实姓名和 openid 从来不下发前端')

  // 清空要发 null 而不是 ''（后端靠「传了这个键」判断要不要改）
  const cleared = await meApi.updateMe({ teaching_years: null })
  chk(cleared.teaching_years === null, '传 null 能清空教龄')

  /*
    「我的」页那一行档案涵盖六项（用户 2026-08-21）。这里把六项一次全发出去，
    再逐项对回来 —— 少一项没下发，那一格在界面上就是永远空的，而且不报错。

    ⚠️ 前端那四份选项清单（me.vue 的 PICKS）是后端白名单的**副本**。
    这一节的价值就在于两份对不上时它会红：清单里多了一个后端不认的档，
    老师点它会吃一个 400，而那时候我们只会听到「保存不了」。
  */
  const SIX = {
    kindergarten_name: '契约测试幼儿园',
    age_group: '中班',
    position: '配班',
    education: '本科',
    professional_title: '一级教师',
    teaching_years: 6,
  }
  const full = await meApi.updateMe(SIX)
  const wrong = Object.entries(SIX).filter(([k, v]) => full[k] !== v).map(([k]) => k)
  chk(wrong.length === 0, `六项档案全部存下且回显一致${wrong.length ? '（对不上：' + wrong.join('、') + '）' : ''}`)

  // me.vue 里 PICKS 的每一档都要真能存进去 —— 副本和白名单对不上就在这里红
  const PICKS = {
    age_group: ['小班', '中班', '大班'],
    position: ['主班', '配班', '保育员', '园长', '其他'],
    education: ['中专及以下', '大专', '本科', '硕士及以上'],
    professional_title: ['未评定', '三级教师', '二级教师', '一级教师', '高级教师', '正高级教师'],
  }
  const rejected = []
  for (const [key, opts] of Object.entries(PICKS)) {
    for (const v of opts) {
      try {
        const r = await meApi.updateMe({ [key]: v })
        if (r[key] !== v) rejected.push(`${key}=${v}`)
      } catch (e) {
        rejected.push(`${key}=${v}`)
      }
    }
  }
  chk(rejected.length === 0,
    `me.vue 那四份选项清单的 ${Object.values(PICKS).flat().length} 个档后端全认${rejected.length ? '（被拒：' + rejected.join('、') + '）' : ''}`)
}

if (WITH_GENERATE) {
  L('\n=== 11. 生成教案（异步 + 轮询）===')
  const started = await convApi.startGenerate(conv.conversation_id)
  chk(started.status === 'generating', `立即返回 task_id=${started.task_id}`)
  let ticks = 0
  const { promise } = convApi.pollGenerate(conv.conversation_id, {
    onTick: (d) => {
      ticks++
      if (d.progress_hint) L(`    … ${d.progress_hint}`)
    },
  })
  const done = await promise
  chk(done.status === 'completed', `轮询 ${ticks} 次拿到结果：${done.status}`)
  chk(Boolean(done.lesson_plan_id), `lesson_plan_id=${done.lesson_plan_id}`)

  L('\n=== 12. 成稿屏要用的字段 ===')
  // 成稿屏整屏都是按 content_json 渲染的。字段名对不上不会报错，
  // 只会安静地少一整块（少了「安全事项」这种，老师根本不会发现）。
  const plansApi = await import('../src/api/lessonPlans.js')
  const p = await plansApi.getLessonPlan(done.lesson_plan_id)
  chk(Boolean(p.age_group && p.duration_min), `年龄班=${p.age_group}，时长=${p.duration_min} 分钟`)
  chk(typeof p.version === 'number', `version=${p.version}（第 2 版起要显示版本胶囊）`)
  const cj = p.content_json || {}
  for (const [key, label] of [
    ['title', '标题'],
    ['materials', '材料清单'],
    ['flow', '教学流程'],
    ['indicators', '学习指标'],
    ['safety', '安全事项'],
    ['steam', 'STEAM 五域'],
  ]) {
    const v = cj[key]
    const ok = Array.isArray(v) ? v.length > 0 : Boolean(v)
    chk(ok, `content_json.${key}（${label}）${Array.isArray(v) ? ` ${v.length} 条` : ''}`)
  }
  chk(
    (cj.flow || []).every((f) => f.stage && f.detail && typeof f.minutes === 'number'),
    'flow 每一环节都有 stage / minutes / detail'
  )
  chk(
    ['S', 'T', 'E', 'A', 'M'].every((k) => k in (cj.steam || {})),
    'steam 五个键齐全（缺席的写「本次未涉及」，前端据此画虚线框）'
  )
  const skipped = ['S', 'T', 'E', 'A', 'M'].filter((k) => /未涉及|不涉及/.test(String(cj.steam?.[k] || '')))
  L(`    （本次 ${p.age_group}：${skipped.length ? skipped.join('/') + ' 刻意不做' : '五域齐全'}）`)
  chk(Array.isArray(p.images), 'images 是数组（没配图时是空数组，不是 null）')

  L('\n=== 13. 教案评价 ===')
  const rated = await plansApi.rateLessonPlan(done.lesson_plan_id, { rating: 'needs_edit' })
  chk(Boolean(rated), '评价提交成功（绑这一版，重复提交是覆盖）')
} else {
  L('\n=== 11. 生成教案 —— 跳过（加 --generate 才跑，会花 DeepSeek 额度）===')
}

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`)
process.exit(failed === 0 ? 0 : 1)
