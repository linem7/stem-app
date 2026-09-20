/**
 * 把真实跑出来的东西导成原型用的数据快照。
 *
 *   node scripts/export-prototype-data.mjs
 *
 * 会做这些事（要花几分钟和一点 DeepSeek 额度）：
 *   1. 三个年龄班各跑一遍完整引导 + 生成（三个账号，因为一个老师只带一个班）
 *   2. 拿小班那份走一遍「改一改」：提意见 → 3 道追问 → 重新生成
 *   3. 把问答、三份教案、改稿前后两版一起写进 ../prototype/data.json
 *
 * 为什么原型要用真数据而不是编的：编的文案会不自觉地往好里写 ——
 * 每个选项都恰到好处、每份教案都完美适龄。那样的原型看着舒服，但骗自己。
 */
import { activateAccount } from './_test-account.mjs';

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = new URL('../../prototype/data.json', import.meta.url);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const RND = String(Date.now()).slice(-8);

/* 2026-09-20：假登录没了，账号必须真建。三个年龄班三个账号 ——
   一个老师只带一个班，同一个账号跑完小班再跑大班，
   「该老师主要带小班」那条记忆会污染后面的推荐答案。 */
const adminToken = (
  await fetch(`${BASE}/admin/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  }).then((r) => r.json())
).data.token;

async function adminPost(path, body) {
  const r = await fetch(`${BASE}/admin/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(body),
  }).then((x) => x.json());
  if (!r.ok) throw new Error(`后台 ${path} 失败：${r.error?.message}`);
  return r.data;
}

/** 造一个园 + 一份名单 + 一个码，用来激活一个原型账号 */
async function makeTicket(age) {
  const kg = await adminPost('/kindergartens', { name: `原型数据园_${RND}` });
  const imp = await adminPost('/roster/import', {
    text: `原型${age}老师${RND}, 一班, 主班, ${age}`, kindergarten_id: kg.id, dry_run: false,
  });
  const code = await adminPost('/codes', {
    kindergarten_id: kg.id, init_text: 30, init_image: 10, grant_reason: `原型数据 ${RND}`,
  });
  return { code: code.code, slot: imp.created[0].id };
}

const CASES = [
  { age: '小班', seed: '我想做个浮与沉的活动' },
  { age: '中班', seed: '我想做个影子的活动' },
  { age: '大班', seed: '我想做个搭高塔的活动' },
];
/** 拿小班那份演示改稿。这句反馈是真会发生的那种：人数和器材对不上。 */
const REVISE_FEEDBACK = '我们班只有12个孩子，而且只有一个水盆，分组轮流会等太久';

let token = null;
async function call(method, path, body) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => ({ ok: false, error: { message: '响应不是 JSON' } }));
  if (!res.ok || j.ok === false) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(j.error)}`);
  return j.data;
}
const L = console.log;

async function waitDone(convId) {
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await call('GET', `/conversations/${convId}/generate/status`);
    if (s.status !== 'generating') return s;
  }
  throw new Error('生成超时');
}

/** 走完一个年龄班的完整引导，返回题目快照和成稿 */
async function runCase({ age, seed }) {
  L(`
── ${age} ──`);
  // 每个年龄班一个新账号。返回 token 给调用方，改一改那一段要接着用同一个
  const act = await activateAccount(await makeTicket(age));
  token = act.token;
  await call('POST', '/me/agree');
  const conv = await call('POST', '/conversations', { seed_input: seed });

  // 题目现在是一次性全给的
  let questions = conv.questions;

  // 先答年龄班 —— 它决定后面推荐答案按哪个班算
  const q1 = questions.find((q) => q.id === 'q1');
  const ageKey = q1.options.find((o) => o.label.includes(age)).key;
  await call('POST', `/conversations/${conv.conversation_id}/answer`, { question_id: 'q1', selected: [ageKey] });
  L(`  q1 ${q1.title} → ${age}`);

  // 年龄班跟档案默认不一致时，重拉一次推荐答案（真实前端也该这么做）
  const re = await call('GET', `/conversations/${conv.conversation_id}/questions?age_group=${encodeURIComponent(age)}`);
  questions = re.questions;

  // 其余题按顺序答，多选取前两个
  for (const q of questions) {
    if (q.id === 'q1') continue;
    const sel = q.multi ? q.options.slice(0, 2).map((o) => o.key) : [q.options[0].key];
    await call('POST', `/conversations/${conv.conversation_id}/answer`, { question_id: q.id, selected: sel });
    L(`  ${q.id} ${q.title} → ${sel.map((k) => q.options.find((o) => o.key === k).label).join('；')}`);
  }

  await call('POST', `/conversations/${conv.conversation_id}/generate`, {});
  const st = await waitDone(conv.conversation_id);
  const plan = await call('GET', `/lesson-plans/${st.lesson_plan_id}`);
  L(`  → 《${plan.title}》${plan.duration_min}分钟 · ${plan.content_json.flow.length}环节 · ${plan.content_json.indicators.length}指标`);

  return {
    // 存的是重拉之后那套（跟老师真正看到的一致）
    questions: questions.map((q) => ({
      id: q.id, key: q.key, title: q.title, hint: q.hint, multi: q.multi,
      allow_custom: q.allow_custom, required: q.required,
      options: q.options.map((o) => ({ k: o.key, l: o.label, s: o.sub || null })),
    })),
    plan: {
      id: plan.id, title: plan.title, age_group: plan.age_group,
      duration_min: plan.duration_min, content_json: plan.content_json, version: plan.version,
    },
    convId: conv.conversation_id,
    planId: plan.id,
    seed,
    // 改一改那一段要在**同一个账号**上接着做 —— 所以 token 跟着一起返回
    tok: act.token,
  };
}

// ---------------------------------------------------------------
const out = { questions: {}, plans: {}, seeds: {}, revise: null };

for (const c of CASES) {
  const r = await runCase(c);
  out.questions[c.age] = r.questions;
  out.plans[c.age] = r.plan;
  out.seeds[c.age] = c.seed;
  if (c.age === '小班') out._small = r;
}

// ---- 改一改：拿小班那份走一遍 ----
L(`\n── 改一改（小班）──`);
// 必须是小班那个账号 —— 改的是她那份教案，换个人就 404 了
token = out._small.tok;
const beforePlan = structuredClone(out.plans['小班']);

const r1 = await call('POST', `/lesson-plans/${out._small.planId}/revise`, { feedback: REVISE_FEEDBACK });
L(`  老师说：${REVISE_FEEDBACK}`);
L(`  AI：${r1.ack}`);
r1.questions.forEach((q) => L(`    ${q.id} ${q.title}`));

const answers = r1.questions.map((q) => ({ question_id: q.id, selected: [q.options[0].key], custom_text: null }));
await call('POST', `/lesson-plans/${out._small.planId}/revise/answer`, { revise_round: r1.revise_round, answers });
await waitDone(out._small.convId);
const after = await call('GET', `/lesson-plans/${out._small.planId}`);
L(`  → 改后《${after.title}》v${after.version} · 材料 ${after.content_json.materials.length} 样`);

out.revise = {
  feedback: REVISE_FEEDBACK,
  ack: r1.ack,
  questions: r1.questions.map((q) => ({
    id: q.id, title: q.title, hint: q.hint, multi: q.multi, allow_custom: q.allow_custom,
    options: q.options.map((o) => ({ k: o.key, l: o.label, s: o.sub || null })),
  })),
  answered: r1.questions.map((q) => q.options[0].label),
  before: { title: beforePlan.title, duration_min: beforePlan.duration_min, content_json: beforePlan.content_json, version: beforePlan.version },
  after:  { title: after.title, duration_min: after.duration_min, content_json: after.content_json, version: after.version },
};

delete out._small;

const fs = await import('node:fs/promises');
await fs.writeFile(OUT, JSON.stringify(out), 'utf8');
const size = (await fs.stat(OUT)).size;
L(`\n写入 ${OUT.pathname}  ${(size / 1024).toFixed(1)} KB`);
L(`三个班：${Object.keys(out.plans).join(' / ')}；改稿样本：${out.revise.questions.length} 题`);
