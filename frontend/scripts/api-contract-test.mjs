/**
 * 前端请求层契约验证。
 *
 * 跑的是 src/api/ 和 src/utils/request.js 里**真正会上线的那份代码**，不是另写一遍 fetch ——
 * 所以路径写错、字段名对不上、信封拆错，这里都会红。
 *
 * 办法是给 node 补一个最小的 uni стуб（storage + request），其余原样 import。
 * 微信开发者工具驱动不了，这是目前唯一能自动跑的前后端联调。
 *
 * 前置：后端 npm start 起在 3000；后台账号见 backend/.env 的 ADMIN_PASSWORD。
 * 自造隔离数据，可反复跑。
 *
 * package.json 里**没有** "type": "module"：加上之后 vite.config.js 会被当 ESM 解析，
 * @dcloudio/vite-plugin-uni 的 default 导出取不到，构建直接挂在「uni is not a function」。
 * 所以这个脚本用 .mjs 后缀，node 的 MODULE_TYPELESS_PACKAGE_JSON 警告在 npm script 里关掉。
 *
 *   node scripts/api-contract-test.mjs            # 不花模型额度
 *   node scripts/api-contract-test.mjs --generate # 连生成教案一起跑（花 DeepSeek 额度，约 30 秒）
 */

const BASE = process.env.API_BASE || 'http://localhost:3000'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456'
const WITH_GENERATE = process.argv.includes('--generate')

// 必须在 import 业务模块之前设好 —— utils/env.js 是在模块加载时读的
process.env.VITE_API_BASE = `${BASE}/v1`
process.env.VITE_DEV_FAKE_LOGIN = 'true'

/* ============ 最小 uni 桩 ============ */

const storage = new Map()

globalThis.uni = {
  getStorageSync: (k) => storage.get(k) ?? '',
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),

  request({ url, method = 'GET', data, header, success, fail }) {
    let target = url
    let body
    if (method === 'GET' && data) {
      const qs = new URLSearchParams(
        Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== '')
      ).toString()
      if (qs) target += `?${qs}`
    } else if (data !== undefined) {
      body = JSON.stringify(data)
    }
    fetch(target, { method, headers: header, body })
      .then(async (res) => {
        const text = await res.text()
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
        success({ data: parsed, statusCode: res.status, header: {} })
      })
      .catch((err) => fail({ errMsg: `request:fail ${err.message}` }))
  },
}

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

  const kg = await fetch(`${BASE}/admin/api/kindergartens`, {
    headers: { Authorization: `Bearer ${tok}` },
  }).then((r) => r.json())

  const made = await fetch(`${BASE}/admin/api/codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({
      phone: `138${RND}`,
      real_name: '契约测试老师',
      kindergarten_id: kg.data.items[0]?.id,
      class_name: '中一班',
      position: '主班',
      age_group: '中班',
      init_text: 20,
      init_image: 10,
      grant_reason: '前端契约测试',
    }),
  }).then((r) => r.json())
  if (!made.ok) throw new Error(`建码失败：${made.error?.message}`)
  return made.data.code
}

/* ============ 正式跑 ============ */

const code = await makeCode()
L(`（本轮兑换码：${code}）\n`)

// 固定这台「设备」的假 openid，走 auth.js 里那条 DEV_FAKE_LOGIN 分支
storage.set('stem_dev_openid', `dev:fe_contract_${RND}`)

const authApi = await import('../src/api/auth.js')
const meApi = await import('../src/api/me.js')
const convApi = await import('../src/api/conversations.js')
const feedbackApi = await import('../src/api/feedback.js')
const requestMod = await import('../src/utils/request.js')
const sessionMod = await import('../src/stores/session.js')

L('=== 1. 登录 ===')
const teacher = await sessionMod.ensureSession()
chk(Boolean(teacher), '拿到 teacher')
chk(requestMod.getToken().length > 20, 'token 已落到 storage')
chk(teacher.activated === false, 'activated=false')
chk(!('phone' in teacher) && !('real_name' in teacher), '响应里没有 phone / real_name（铁律）')
chk(sessionMod.gate() === 'redeem', `gate() → redeem`)

L('\n=== 2. 没激活时业务接口应被拦下 ===')
await expectError('开新会话', 'NOT_ACTIVATED', () => convApi.createConversation('我想做个浮与沉的活动'))

L('\n=== 3. 兑换码激活（故意把码写脏，输入宽容由后端负责）===')
await expectError('乱填的码', 'VALIDATION_FAILED', () => authApi.redeem('STEM-0000-0000'))
const dirty = `  ${code.toLowerCase().replace(/-/g, ' ')} `
const redeemed = await sessionMod.redeem(dirty)
chk(sessionMod.session.teacher.activated === true, `脏码 "${dirty.trim()}" 也认得出来`)
chk(Boolean(redeemed.granted || redeemed.quota), '激活同时发了首笔额度')
chk(sessionMod.gate() === 'agreement', 'gate() → agreement')

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
// 关键：字母不是稳定标识。换班后 A/B/C 指向的文案会变，
// 所以前端必须按 label 重新对位，不能把勾原样留在原字母上。
const venueBefore = conv.questions.find((x) => x.key === 'venue')
const venueAfter = re.questions.find((x) => x.key === 'venue')
const movedAt = venueBefore.options.findIndex(
  (o, i) => venueAfter.options[i] && venueAfter.options[i].label !== o.label
)
chk(
  movedAt >= 0,
  movedAt >= 0
    ? `换班后同一字母指向的文案会变（${venueBefore.options[movedAt].key}：${venueBefore.options[movedAt].label} → ${venueAfter.options[movedAt].label}），所以前端必须按 label 对位`
    : '这一轮字母恰好没变，但不能据此认为它稳定'
)
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
} else {
  L('\n=== 11. 生成教案 —— 跳过（加 --generate 才跑，会花 DeepSeek 额度）===')
}

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`)
process.exit(failed === 0 ? 0 : 1)
