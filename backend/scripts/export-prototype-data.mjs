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
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = new URL('../../prototype/data.json', import.meta.url);

const CASES = [
  { age: '小班', teacher: 'dev:proto_small', seed: '我想做个浮与沉的活动' },
  { age: '中班', teacher: 'dev:proto_mid',   seed: '我想做个影子的活动' },
  { age: '大班', teacher: 'dev:proto_big',   seed: '我想做个搭高塔的活动' },
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
async function runCase({ age, teacher, seed }) {
  L(`\n── ${age} ──`);
  token = (await call('POST', '/auth/login', { code: teacher, nickname: '测试老师' })).token;
  const conv = await call('POST', '/conversations', { seed_input: seed });

  const questions = [];
  let q = conv.question;
  while (q) {
    // 记下这一题原样的题面和推荐答案 —— 原型里老师看到的就是这些
    questions.push({
      id: q.id, title: q.title, hint: q.hint, multi: q.multi,
      allow_custom: q.allow_custom, required: q.required,
      options: q.options.map((o) => ({ k: o.key, l: o.label, s: o.sub || null })),
    });
    // 年龄班那题必须选对，否则后面整套规则都错了；其余选第一个（多选选前两个）
    const sel = q.id === 'q1'
      ? [q.options.find((o) => o.l ? o.l.includes(age) : o.label.includes(age)).key]
      : q.multi ? q.options.slice(0, 2).map((o) => o.key) : [q.options[0].key];
    const r = await call('POST', `/conversations/${conv.conversation_id}/answer`, { question_id: q.id, selected: sel });
    L(`  ${q.id} ${q.title} → ${sel.map((k) => q.options.find((o) => o.key === k).label).join('；')}`);
    q = r.question;
    if (r.ready_to_generate) break;
  }

  await call('POST', `/conversations/${conv.conversation_id}/generate`, {});
  const st = await waitDone(conv.conversation_id);
  const plan = await call('GET', `/lesson-plans/${st.lesson_plan_id}`);
  L(`  → 《${plan.title}》${plan.duration_min}分钟 · ${plan.content_json.flow.length}环节 · ${plan.content_json.indicators.length}指标`);

  return {
    questions,
    plan: {
      id: plan.id, title: plan.title, age_group: plan.age_group,
      duration_min: plan.duration_min, content_json: plan.content_json,
      version: plan.version,
    },
    convId: conv.conversation_id,
    planId: plan.id,
    seed,
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
token = (await call('POST', '/auth/login', { code: '小班' === '小班' ? 'dev:proto_small' : '' })).token;
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
