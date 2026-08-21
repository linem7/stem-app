/**
 * 学习模式的边界回归。
 *
 * 查的都是**不报错的失败**：
 *   · 效率模式下 why 漏下发了（多几行噪音，没人会注意）
 *   · 学习模式下 why 只在开会话那一次有，续写和换年龄班之后消失
 *     （表现是「她被叫走一趟回来，那几句为什么就没了」——
 *      而她多半会以为是自己记错了，不会来报）
 *   · mode 传了个乱值，会话建不出来
 *
 * 自造园所 + 名单岗位 + 兑换码，可反复跑。不调图片模型、不生成教案，所以很便宜。
 *
 *   node scripts/mode-test.mjs
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const RND = String(Date.now()).slice(-8);

let token = null;
let failed = 0;
const L = console.log;
const chk = (cond, msg) => {
  L(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

async function call(method, path, body) {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (!r.json?.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json?.error || r.json)}`);
  return r.json.data;
}

/** 入场券：园 + 名单岗位 + 码。名字带 RND，跑十轮不会互相命中 */
async function makeTicket() {
  const aj = async (m, p, tok, b) => (await (await fetch(`${BASE}/admin/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    ...(b ? { body: JSON.stringify(b) } : {}),
  })).json());
  const login = await aj('POST', '/login', null, { username: 'admin', password: ADMIN_PASSWORD });
  if (!login?.data?.token) throw new Error('管理后台登录失败（改过密码就传 ADMIN_PASSWORD=）');
  const at = login.data.token;
  const kg = await aj('POST', '/kindergartens', at, { name: `模式回归园_${RND}` });
  const imp = await aj('POST', '/roster/import', at, {
    text: `模式${RND}, 小一班, 主班, 中班`, kindergarten_id: kg.data.id, dry_run: false,
  });
  const r = await aj('POST', '/codes', at, {
    kindergarten_id: kg.data.id, init_text: 20, init_image: 3, grant_reason: '模式回归测试',
  });
  return { code: r.data.code, slot: imp.data.created[0].id };
}

// ---------------------------------------------------------------
L('=== 0. 准备账号 ===');
const ticket = await makeTicket();
token = (await ok('POST', '/auth/login', { code: `dev:mode_${RND}` })).token;
await ok('POST', '/auth/redeem', { code: ticket.code, roster_entry_id: ticket.slot });
await ok('POST', '/me/agree');
L('  ✓ 已激活');

/* ============ 1. 效率模式：一个字的解释都不下发 ============ */

L('\n=== 1. 效率模式 ===');
{
  const d = await ok('POST', '/conversations', { seed_input: '我想做个磁铁的活动', mode: 'efficient' });
  chk(d.mode === 'efficient', 'mode 回显 efficient');
  chk(d.learning_lead === undefined, '没有 learning_lead');
  chk(
    d.questions.every((q) => q.why === undefined && q.why_detail === undefined),
    `${d.questions.length} 道题一个 why 都没有`
  );

  // 不传 mode 也该是效率模式 —— 已有的会话全是这么建的
  const d2 = await ok('POST', '/conversations', { seed_input: '我想做个影子的活动' });
  chk(d2.mode === 'efficient', '不传 mode → 默认 efficient');
}

/* ============ 2. 学习模式：四题都有，而且**续写和重拉之后还在** ============ */
//
// 这一节是整个脚本的重点。开会话那一次有 why 很容易做对，
// 漏的永远是另外两条路 —— 而它们都不报错。

L('\n=== 2. 学习模式 ===');
let learnId = 0;
{
  const d = await ok('POST', '/conversations', { seed_input: '我想做个浮与沉的活动', mode: 'learning' });
  learnId = d.conversation_id;
  chk(d.mode === 'learning', 'mode 回显 learning');
  chk(Boolean(d.learning_lead), `有 learning_lead：「${String(d.learning_lead).slice(0, 20)}…」`);
  const withWhy = d.questions.filter((q) => q.why);
  chk(withWhy.length === d.questions.length, `${d.questions.length} 道题全部带 why`);
  chk(
    d.questions.every((q) => !q.why || (q.why_detail && q.why_detail.length > 20)),
    '每条 why 都配了一段具体的 why_detail'
  );

  // 断点续写
  const g = await ok('GET', `/conversations/${learnId}`);
  chk(g.mode === 'learning', '续写时 mode 还在');
  chk(Boolean(g.learning_lead), '续写时 learning_lead 还在');
  chk(g.questions.every((q) => q.why), '续写时每道题的 why 还在');

  // 换年龄班重拉
  const rq = await ok('GET', `/conversations/${learnId}/questions?age_group=大班`);
  chk(rq.questions.every((q) => q.why), '换年龄班重拉后 why 还在');
}

/* ============ 3. 乱值不许让她拿不到教案 ============ */

/*
  ⚠️ 每小时只能开 10 个会话（limitNewConversation）。
  第一版这一节给 6 个乱值各开一个会话，加上前后两节一共 12 个 —— 跑到一半 429。
  限流是对的，是**脚本设计错了**：一个跑第二遍就红的脚本，红两次之后就没人看了。

  乱值收敛是**纯函数**的事（resolveMode），直接当单元测 —— 免费、瞬间、覆盖得更全。
  只留一次 HTTP 调用，证明那条路由真的用了它。
*/

L('\n=== 3. mode 传了乱值 ===');
{
  const { resolveMode } = await import('../src/services/learningMode.js');
  const bads = ['LEARNING', 'Learning', 'xxx', '', ' ', null, undefined, 123, { a: 1 }, ['learning']];
  const wrong = bads.filter((b) => resolveMode(b) !== 'efficient');
  chk(wrong.length === 0, `${bads.length} 个乱值全部收敛成 efficient`);
  chk(resolveMode('learning') === 'learning', '合法值 learning 不被误伤');
  chk(resolveMode(' learning ') === 'learning', '前后空格会被去掉');

  // 路由真的走了这个函数（只花一个会话名额）
  const d = await ok('POST', '/conversations', { seed_input: '我想做个搭高塔的活动', mode: 'LEARNING' });
  chk(d.mode === 'efficient', '路由收到 "LEARNING" 也收敛成 efficient');
}

/* ============ 4. 模式不影响答题与额度 ============ */
//
// 学习模式**不额外收额度**（用户定）。这一条防的是哪天有人顺手加了道闸。

L('\n=== 4. 模式不改变答题与额度 ===');
{
  const d = await ok('POST', '/conversations', { seed_input: '我想做个沙水的活动', mode: 'learning' });
  const ageQ = d.questions.find((q) => q.key === 'age_group');
  const r = await ok('POST', `/conversations/${d.conversation_id}/answer`, {
    question_id: ageQ.id,
    selected: [ageQ.options.find((o) => o.label === '中班')?.key || ageQ.options[0].key],
  });
  chk(r.progress.answered === 1, '学习模式下答题照常落库');

  /*
    学习模式**不额外收额度**（用户 2026-08-20 定）。

    ⚠️ 这里断言的是「两个模式扣得一样多」，而不是「扣了 1 次」——
    第一版写成后者，红了。原因是**开会话根本不消耗额度，只校验**：
    额度是「台账 Σ发放 − 事实表数消耗」算出来的（不存 balance 字段），
    而消耗记在真生成教案的那一刻。所以这里两个都是 0。

    「生成时也一样多」这条要真跑两次生成才能验，那要花 DeepSeek 的钱，
    不放在这个脚本里 —— 它的价值是能天天跑。
    真有人给学习模式加了道闸，下面这条会红。
  */
  // 复用上面已经开的那些会话，不再多开 —— 每小时只有 10 个名额
  const q = await ok('GET', '/me/quota');
  chk(
    q.quota.text.used === 0,
    `开了 ${5} 个会话（含 ${2} 个学习模式）之后文案消耗仍是 0（实际 ${q.quota.text.used}）`
  );
}

/* ============ 5. 教案解读不在这个脚本里 ============ */
//
// ⚠️ 这个脚本**不测 content_json.commentary**，别以为它测了。
//
// 解读是生成阶段的第三次模型调用，要验它端到端就得真生成一份教案
// （20-30 秒 + DeepSeek 的钱），而这个脚本的全部价值是「能天天跑」。
//
// 它的收敛逻辑（白名单、截断、flow_stages 对齐、renderMarkdown 不许输出它）
// 全部是纯函数，单独一个脚本盯着，也不花钱：
//
//     npm run test:commentary
//
// 动 learningMode.js 或 renderMarkdown 之后那个必跑。

L('\n=== 5. 教案解读 —— 见 npm run test:commentary（纯函数，不花钱）===');

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`);
process.exit(failed === 0 ? 0 : 1);
