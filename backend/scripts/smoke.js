/**
 * 最小链路冒烟测试：自造激活账号 → 开会话 → 一屏答完 4 题 → 生成教案 → 打印硬校验结果。
 *
 * 这个脚本验证的不是「代码能跑」，而是**生成的教案是否真的适龄可用**
 * （CLAUDE.md「下一个里程碑」）。所以它跑完会把 age_band_violations 原样打出来，
 * 有违规不算失败 —— 那正是要看的东西。
 *
 * 用法：
 *   先另开一个终端 npm start，然后
 *   node scripts/smoke.js              默认小班
 *   node scripts/smoke.js 中班         换年龄班
 *   BASE=http://localhost:3100 node scripts/smoke.js
 *
 * 依赖 DEV_FAKE_LOGIN=true。
 *
 * ⚠️ 2026-08-20 修过两处过时：
 *   · **没有激活**。激活闸门是 08-17 加的，这个脚本一直没跟上 ——
 *     `POST /conversations` 直接 403 NOT_ACTIVATED，也就是说它**根本跑不起来**，
 *     而 CLAUDE.md 里一直写着「冒烟脚本 npm run smoke」。
 *     现在照 versions-test 的做法自造园所 + 名单岗位 + 兑换码。
 *   · **一题一题问**（`conv.question` 单数）。08-17 改成了一屏 4 题（`conv.questions` 数组），
 *     旧写法在新接口下拿到 undefined，循环一次都不进，然后拿一份没答过题的会话去生成。
 *
 * 教训：**能跑起来的脚本才叫回归**。这两处都不报错，只是安静地不干活。
 */
const BASE = process.env.BASE || 'http://localhost:3000';
const AGE_GROUP = process.argv[2] || '小班';
const SEED = process.env.SEED || '我想做个浮与沉的活动';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const RND = String(Date.now()).slice(-8);
// 一个老师只带一个班，所以要做三个班的对照样本就得用三个账号 ——
// 同一个账号跑完小班再跑大班，「该老师主要带小班」那条记忆会去影响后面的推荐答案。
// 默认带上随机后缀，正是为了每次都是干净的新账号。
const TEACHER = process.env.TEACHER || `dev:smoke_${RND}`;

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
  if (question.key === 'age_group') {
    const hit = opts.find((o) => o.label.includes(AGE_GROUP));
    if (!hit) throw new Error(`年龄班那题里没有「${AGE_GROUP}」：${JSON.stringify(opts)}`);
    return [hit.key];
  }
  if (!opts.length) return [];
  return question.multi ? opts.slice(0, 2).map((o) => o.key) : [opts[0].key];
}

/**
 * 备一张入场券：一个园 + 名单上一个岗位 + 一个兑换码。
 *
 * 016 之后激活要两样：码（不带身份）+ 从名单里选的位置。
 * 每次都新建一套带 RND 后缀的，所以可以反复跑 ——
 * 用真省市名或固定名字会命中上几轮留下的数据，断言就会随轮次变红
 * （交接文档第 2 条踩过两次）。
 */
async function makeTicket() {
  const aj = async (m, p, tok, b) => (await (await fetch(`${BASE}/admin/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    ...(b ? { body: JSON.stringify(b) } : {}),
  })).json());
  const login = await aj('POST', '/login', null, { username: 'admin', password: ADMIN_PASSWORD });
  if (!login?.data?.token) {
    throw new Error(`管理后台登录失败（改过密码就传 ADMIN_PASSWORD=）：${JSON.stringify(login?.error || login)}`);
  }
  const at = login.data.token;
  const kg = await aj('POST', '/kindergartens', at, { name: `冒烟园_${RND}` });
  const imp = await aj('POST', '/roster/import', at, {
    text: `冒烟${RND}, 小一班, 主班, ${AGE_GROUP}`,
    kindergarten_id: kg.data.id,
    dry_run: false,
  });
  const r = await aj('POST', '/codes', at, {
    kindergarten_id: kg.data.id, init_text: 5, init_image: 3,
    grant_reason: '冒烟测试',
  });
  return { code: r.data.code, slot: imp.data.created[0].id };
}

const line = (s = '') => console.log(s);
const rule = () => line('─'.repeat(60));

// ---------------------------------------------------------------
line(`\n目标：给「${AGE_GROUP}」生成一份教案\n想法：${SEED}`);
rule();

// 1. 自造入场券 + 假登录 + 激活 + 同意协议
const ticket = await makeTicket();
const auth = await call('POST', '/auth/login', { code: TEACHER, nickname: '测试老师' });
token = auth.token;
await call('POST', '/auth/redeem', { code: ticket.code, roster_entry_id: ticket.slot });
await call('POST', '/me/agree');
line(`1. 账号就绪 · teacher_id=${auth.teacher.id}（新建园所与名单岗位，可反复跑）`);

// 2. 开会话 —— 响应里已经带着那 4 道题
const conv = await call('POST', '/conversations', { seed_input: SEED });
const questions = conv.questions || [];
line(`2. 会话已建 · conversation_id=${conv.conversation_id} · 拿到 ${questions.length} 道题`);
if (!questions.length) throw new Error('开会话没返回 questions —— 接口形状变了？');
rule();

// 3. 一屏 4 题，逐个提交（每答一题即落库，跟前端一样）
let step = 0;
for (const question of questions) {
  step += 1;
  const selected = pickAnswer(question);
  const labels = selected
    .map((k) => question.options.find((o) => o.key === k)?.label)
    .join('；');

  line(`Q${step} ${question.title}`);
  line(`   选项：${question.options.map((o) => `${o.key}.${o.label}`).join('  ')}`);
  line(`   → 答：${labels || '（跳过）'}`);

  const r = await call('POST', `/conversations/${conv.conversation_id}/answer`, {
    question_id: question.id,
    selected,
  });
  if (r.ack) line(`   AI：${r.ack}`);
  line();
}
rule();
line(`3. 引导走完，共答了 ${step} 题`);

// 4. 生成（异步 + 轮询）
const task = await call('POST', `/conversations/${conv.conversation_id}/generate`, {});
line(`4. 已提交生成 · task_id=${task.task_id}，开始轮询…`);

/* 2026-08-25：progress_hint（一句编出来的进度文案）换成了 phase + 流式正文。
   这里顺带**验一遍增量协议真的在拼**：把收到的每一段接起来，
   最后跟后端报的 len 对一次账 —— 对不上就是 from 游标算错了，
   而那个错在小程序上表现成「正文重复了一段」，没有人会去报它。 */
const startedAt = Date.now();
let status = null;
let lastPhase = '';
let buf = '';
let epoch = 0;
let firstCharAt = 0;
for (let i = 0; i < 180; i += 1) {
  await new Promise((r) => setTimeout(r, 1000));
  const q = `epoch=${epoch}&from=${buf.length}`;
  status = await call('GET', `/conversations/${conv.conversation_id}/generate/status?${q}`);
  const s = status.stream;
  if (s) {
    if (s.restart) buf = '';
    buf += s.text;
    epoch = s.epoch;
    if (buf.length !== s.len) line(`   ⚠️ 增量对不上：拼出 ${buf.length} 字，后端说 ${s.len} 字`);
    if (buf.length && !firstCharAt) {
      firstCharAt = Date.now();
      line(`   [${Math.round((firstCharAt - startedAt) / 1000)}s] 第一个字出来了`);
    }
  }
  if (status.phase && status.phase !== lastPhase) {
    lastPhase = status.phase;
    line(`   [${Math.round((Date.now() - startedAt) / 1000)}s] ${lastPhase}`);
  }
  if (status.status !== 'generating') break;
}
line(`   流式收到 ${buf.length} 字正文；开头：${JSON.stringify(buf.slice(0, 40))}`);
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

/*
  把新结构逐项打出来（2026-08-20 改版）。
  只看「生成成功」不够 —— 模型可能返回了一份缺了半边的教案，
  normalizePlan 会把缺的收敛成空数组，界面上就是几个空板块。
  这里逐项打，一眼看得出哪一节是空的。
*/
const c = plan.content_json || {};
rule();
line('教案正文（大陆格式）：');
line(`  设计意图      ${c.intent ? `${c.intent.length} 字` : '⚠ 空'}`);
line(`  活动目标      ${(c.objectives || []).length} 条`);
for (const o of c.objectives || []) line(`      【${o.dimension || '⚠无维度'}】${o.text}`);
line(`  活动重点      ${c.key_points?.focus || '⚠ 空'}`);
line(`  活动难点      ${c.key_points?.difficulty || '⚠ 空'}`);
line(`  经验准备      ${(c.preparation?.experience || []).length} 条`);
for (const x of c.preparation?.experience || []) line(`      · ${x}`);
line(`  物质准备      ${(c.preparation?.material || []).length} 样`);
line(`  活动过程      ${(c.flow || []).length} 环节：${(c.flow || []).map((f) => `${f.stage}(${f.minutes}分)`).join(' → ')}`);
line(`  活动延伸      ${c.extension ? `${c.extension.length} 字` : '⚠ 空'}`);
line(`  安全提示      ${(c.safety || []).length} 条`);
line('特征标注与教学实例：');
const steamOn = ['S', 'T', 'E', 'A', 'M'].filter((k) => c.steam?.[k] && !/未涉及|不涉及|^无$/.test(c.steam[k]));
line(`  STEAM         ${steamOn.join('/')}${steamOn.length < 5 ? `（刻意不做：${['S','T','E','A','M'].filter((k) => !steamOn.includes(k)).join('/')}）` : ' 五域齐全'}`);
line(`  《指南》指标   ${(c.indicators || []).length} 条`);
line(`  教学实例      ${(c.dialogue || []).length} 句`);
// 已经删掉的字段不该再出现 —— 出现了说明提示词或 normalizePlan 有一处没改干净
const ghosts = ['features', 'reflection', 'materials'].filter((k) => c[k] !== undefined);
if (ghosts.length) line(`  ⚠ 还带着已删除的字段：${ghosts.join('、')}`);

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
