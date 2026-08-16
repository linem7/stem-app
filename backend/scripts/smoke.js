/**
 * 最小链路冒烟测试：假登录 → 开会话 → 答完 11 题 → 生成教案 → 打印硬校验结果。
 *
 * 这个脚本验证的不是「代码能跑」，而是**生成的教案是否真的适龄可用**
 * （CLAUDE.md「下一个里程碑」）。所以它跑完会把 age_band_violations 原样打出来，
 * 有违规不算失败 —— 那正是要看的东西。
 *
 * 用法：
 *   先另开一个终端 npm start，然后
 *   node scripts/smoke.js              默认小班
 *   node scripts/smoke.js 中班         换年龄班
 *   BASE=http://localhost:3000 node scripts/smoke.js
 *
 * 依赖 DEV_FAKE_LOGIN=true。
 */
const BASE = process.env.BASE || 'http://localhost:3000';
const AGE_GROUP = process.argv[2] || '小班';
const SEED = process.env.SEED || '我想做个浮与沉的活动';

let token = null;

async function call(method, path, body) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({ ok: false, error: { message: '响应不是 JSON' } }));
  if (!res.ok || json.ok === false) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.error || json)}`);
  }
  return json.data;
}

/** 按题目类型挑答案：年龄班选指定的那个，其余选前 1-2 个推荐项 */
function pickAnswer(question) {
  const opts = question.options || [];
  if (question.id === 'q1') {
    const hit = opts.find((o) => o.label.includes(AGE_GROUP));
    if (!hit) throw new Error(`第一题里没有「${AGE_GROUP}」这个选项：${JSON.stringify(opts)}`);
    return [hit.key];
  }
  if (!opts.length) return [];
  return question.multi ? opts.slice(0, 2).map((o) => o.key) : [opts[0].key];
}

const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(60));

// ---------------------------------------------------------------
line(`\n目标：给「${AGE_GROUP}」生成一份教案\n想法：${SEED}`);
rule();

// 1. 假登录
const auth = await call('POST', '/auth/login', {
  code: 'dev:test001',
  nickname: '测试老师',
});
token = auth.token;
line(`1. 登录成功 · teacher_id=${auth.teacher.id}`);

// 2. 开会话
const conv = await call('POST', '/conversations', { seed_input: SEED });
line(`2. 会话已建 · conversation_id=${conv.conversation_id}`);
rule();

// 3. 逐题作答
let question = conv.question;
let step = 0;
while (question) {
  step += 1;
  const selected = pickAnswer(question);
  const labels = selected
    .map((k) => question.options.find((o) => o.key === k)?.label)
    .join('；');

  line(`Q${step} ${question.title}`);
  line(`   选项：${question.options.map((o) => `${o.key}.${o.label}`).join('  ')}`);
  line(`   → 答：${labels}`);

  const r = await call('POST', `/conversations/${conv.conversation_id}/answer`, {
    question_id: question.id,
    selected,
  });
  if (r.ack) line(`   AI：${r.ack}`);
  line();

  question = r.question;
  if (r.ready_to_generate) break;
}
rule();
line(`3. 引导走完，共答了 ${step} 题`);

// 4. 生成（异步 + 轮询）
const task = await call('POST', `/conversations/${conv.conversation_id}/generate`, {});
line(`4. 已提交生成 · task_id=${task.task_id}，开始轮询…`);

const startedAt = Date.now();
let status = null;
let lastHint = '';
for (let i = 0; i < 90; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  status = await call('GET', `/conversations/${conv.conversation_id}/generate/status`);
  if (status.progress_hint !== lastHint) {
    lastHint = status.progress_hint;
    line(`   [${Math.round((Date.now() - startedAt) / 1000)}s] ${lastHint}`);
  }
  if (status.status !== 'generating') break;
}
const elapsed = Math.round((Date.now() - startedAt) / 1000);

if (status.status !== 'completed') {
  line(`\n生成没成功：status=${status.status}`);
  line('去启动服务的那个终端看 lesson_generate_failed 那行日志。');
  process.exit(1);
}
line(`5. 生成完成，耗时 ${elapsed} 秒 · lesson_plan_id=${status.lesson_plan_id}`);

// 5. 取成稿，看硬校验
const plan = await call('GET', `/lesson-plans/${status.lesson_plan_id}`);
rule();
line(`标题：    ${plan.title}`);
line(`年龄班：  ${plan.age_group}`);
line(`时长：    ${plan.duration_min} 分钟`);
line(`正文：    ${plan.content_md?.length ?? 0} 字`);

const q = plan.quality_self || {};
const violations = q.age_band_violations || [];
rule();
if (violations.length === 0) {
  line('硬校验：没有查到年龄班越界。');
  line('（注意：没查到不等于真的适龄 —— 校验只覆盖量杯读数、预测、统计图表、');
  line('  环节数、指标数、误食风险这几条硬规则，其余仍要人眼看。）');
} else {
  line(`硬校验：抓到 ${violations.length} 条年龄班越界 ——`);
  violations.forEach((v, i) => line(`  ${i + 1}. ${v}`));
}
if (q.fixed?.length) {
  line(`\n代码自动修掉的：`);
  q.fixed.forEach((f, i) => line(`  ${i + 1}. ${f}`));
}
rule();
line(`\n完整正文：`);
line(`  psql -U postgres -d stem_app -c "SELECT content_md FROM lesson_plans WHERE id=${status.lesson_plan_id}" `);
line(`或 curl -H "Authorization: Bearer <token>" ${BASE}/v1/lesson-plans/${status.lesson_plan_id}\n`);
