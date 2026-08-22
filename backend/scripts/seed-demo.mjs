/**
 * 演示数据：20 位教师 + 20 条任务（2026-08-22 用户要的，为了把管理后台各页填满看效果）。
 *
 *   node scripts/seed-demo.mjs            # 造
 *   node scripts/seed-demo.mjs --clear    # 清掉（只清它自己造的）
 *   API_BASE=http://localhost:3100 node scripts/seed-demo.mjs
 *
 * ─────────────────────────────────────────────────────────────────
 * 🔴 **全部走真接口，不直插库。**
 *
 * 直插库看起来更快，但会漏字段 —— 而漏掉的那个字段正是「界面上这一列是空的」
 * 的原因，然后要花半小时查「是查询写错了还是数据没写进去」。
 * 走接口造出来的数据跟老师真的用出来的形状一致。
 *
 * 唯一的例外是**教案和评价**：真生成一份教案要调 DeepSeek、20 秒、花钱。
 * 那部分直接写库，并且在下面注明了字段是照 `lessonGenerator` 的产出抄的。
 * ─────────────────────────────────────────────────────────────────
 *
 * 🔴 **`cleanup-test-data.mjs` 不会清它。**
 * openid 用 `dev_demo_*`，而清理脚本按 `dev_%` 判假账号 —— 所以那边加了一条
 * 例外把 `dev_demo_` 排除掉。理由：演示数据是用户特意要的、要留着看的，
 * 被清理脚本顺手抹掉会很莫名。要清就跑这个脚本的 `--clear`。
 *
 * 名字一律带「演示」两个字，一眼看得出是假的 —— 跟园所模板里那两行示例同一条纪律：
 * 一份看起来完全正常的假数据混进真数据里，是没人会发现的。
 */
import { query, queryOne, withTransaction, closePool } from '../src/db/pool.js';

const BASE = (process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const A = `${BASE}/admin/api`;
const V1 = `${BASE}/v1`;
const CLEAR = process.argv.includes('--clear');

/** 所有演示数据都带这个前缀，清理时按它认 */
const TAG = '演示';
const OPENID_PREFIX = 'dev_demo_';

let token = '';
const L = console.log;

async function adm(method, path, body) {
  const res = await fetch(A + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method} ${path} → ${res.status} ${j.error?.message || ''}`);
  return j.data;
}
async function usr(method, path, tok, body) {
  const res = await fetch(V1 + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method} ${path} → ${res.status} ${j.error?.message || ''}`);
  return j.data;
}

/* ─────────────────────────── 清理 ─────────────────────────── */
async function clear() {
  const t = await withTransaction(async (c) => {
    // 账号一删，会话教案配图记忆额度反馈全部按外键 CASCADE 跟着走
    const tea = await c.query(`DELETE FROM teachers WHERE openid LIKE $1 RETURNING id`, [`${OPENID_PREFIX}%`]);
    const tk = await c.query(`DELETE FROM tasks WHERE title LIKE $1 RETURNING id`, [`${TAG}%`]);
    // 码和批次：按说明认
    await c.query(`DELETE FROM redemption_codes WHERE grant_reason LIKE $1`, [`${TAG}%`]);
    const cb = await c.query(`DELETE FROM code_batches WHERE grant_reason LIKE $1 RETURNING id`, [`${TAG}%`]);
    // 名单和园所最后删 —— 上面那些还挂着它们
    const ros = await c.query(`DELETE FROM teacher_roster WHERE real_name LIKE $1 RETURNING id`, [`${TAG}%`]);
    const kg = await c.query(`DELETE FROM kindergartens WHERE name LIKE $1 RETURNING id`, [`${TAG}%`]);
    const lg = await c.query(
      `DELETE FROM admin_logs WHERE detail::text LIKE $1 RETURNING id`, [`%${TAG}%`]);
    return { tea: tea.rowCount, tk: tk.rowCount, cb: cb.rowCount, ros: ros.rowCount, kg: kg.rowCount, lg: lg.rowCount };
  });
  L(`清掉：${t.kg} 个园所、${t.ros} 行名单、${t.tea} 个账号、${t.tk} 条任务、${t.cb} 批兑换码、${t.lg} 条操作记录`);
}

/* ─────────────────────────── 造 ─────────────────────────── */

// 六个园所，**特征刻意铺开** —— 任务定向筛的就是这几个字段，
// 全都一样的话「按城乡筛」「按办园性质筛」在详情页的分布图里看不出任何差别
const KGS = [
  { name: `${TAG}·朝阳一幼`, province: '广东', city: '广州', area_type: 'city', ownership: 'public', teacher_count: 46, child_count: 340, contact_name: '陈园长', contact_phone: '13800001001', note: '2026 春季合作' },
  { name: `${TAG}·育苗幼儿园`, province: '广东', city: '广州', area_type: 'city', ownership: 'private', teacher_count: 22, child_count: 150, contact_name: '林园长', contact_phone: '13800001002' },
  { name: `${TAG}·清河镇中心园`, province: '广东', city: '佛山', area_type: 'county', ownership: 'public', teacher_count: 18, child_count: 120, contact_name: '黄园长', contact_phone: '13800001003' },
  { name: `${TAG}·田心村幼儿园`, province: '广东', city: '佛山', area_type: 'rural', ownership: 'public', teacher_count: 9, child_count: 55, contact_name: '吴园长' },
  { name: `${TAG}·西湖实验幼儿园`, province: '浙江', city: '杭州', area_type: 'city', ownership: 'public', teacher_count: 38, child_count: 280, contact_name: '周园长', contact_phone: '13800001005' },
  { name: `${TAG}·溪口乡幼儿园`, province: '浙江', city: '宁波', area_type: 'rural', ownership: 'private', teacher_count: 7, child_count: 40 },
];

// 20 位教师。姓氏铺开（打码之后看得出区别）、年龄班和岗位都有分布。
// `act` = 要不要激活；`plans` = 造几份教案；`rate` = 评价等级
const TEACHERS = [
  { kg: 0, name: `${TAG}陈明霞`, cls: '小一班', pos: '主班', age: '小班', act: true, plans: 3, rate: 'usable' },
  { kg: 0, name: `${TAG}李文静`, cls: '小一班', pos: '配班', age: '小班', act: true, plans: 1, rate: 'needs_edit' },
  { kg: 0, name: `${TAG}王丽娟`, cls: '中一班', pos: '主班', age: '中班', act: true, plans: 2 },
  { kg: 0, name: `${TAG}张秀兰`, cls: '大一班', pos: '主班', age: '大班', act: true, plans: 4, rate: 'usable' },
  { kg: 0, name: `${TAG}刘海燕`, cls: '大一班', pos: '保育员', age: '大班', act: false },
  { kg: 1, name: `${TAG}赵春梅`, cls: '小二班', pos: '主班', age: '小班', act: true, plans: 1 },
  { kg: 1, name: `${TAG}孙雅琴`, cls: '中二班', pos: '主班', age: '中班', act: true, plans: 2, rate: 'needs_edit' },
  { kg: 1, name: `${TAG}周晓红`, cls: '中二班', pos: '配班', age: '中班', act: false },
  { kg: 2, name: `${TAG}吴淑芬`, cls: '小一班', pos: '主班', age: '小班', act: true, plans: 2, rate: 'unusable' },
  { kg: 2, name: `${TAG}郑美玲`, cls: '中一班', pos: '主班', age: '中班', act: true, plans: 1 },
  { kg: 2, name: `${TAG}冯桂英`, cls: '大一班', pos: '主班', age: '大班', act: false },
  { kg: 3, name: `${TAG}何秋菊`, cls: '混龄班', pos: '主班', age: '中班', act: true, plans: 1 },
  { kg: 3, name: `${TAG}杨凤仙`, cls: '混龄班', pos: '保育员', age: '中班', act: false },
  { kg: 4, name: `${TAG}徐雨欣`, cls: '小三班', pos: '主班', age: '小班', act: true, plans: 3, rate: 'usable' },
  { kg: 4, name: `${TAG}高婉如`, cls: '中三班', pos: '主班', age: '中班', act: true, plans: 2 },
  { kg: 4, name: `${TAG}马莉莉`, cls: '大二班', pos: '配班', age: '大班', act: true, plans: 1, rate: 'needs_edit' },
  { kg: 4, name: `${TAG}朱慧敏`, cls: '大二班', pos: '主班', age: '大班', act: false },
  { kg: 5, name: `${TAG}胡月华`, cls: '混龄班', pos: '主班', age: '小班', act: true, plans: 1 },
  { kg: 5, name: `${TAG}郭爱莲`, cls: '混龄班', pos: '园长', age: '大班', act: false },
  { kg: 5, name: `${TAG}罗玉珍`, cls: '混龄班', pos: '配班', age: '小班', act: false },
];

const TASK_TITLES = [
  '9 月教研问卷', '教案质量回访', '配图使用情况调查', '学习模式体验反馈',
  '小班活动时长调研', '园本课程衔接访谈', '10 月阶段小结', '安全提示可用性核查',
  '《指南》指标对照问卷', '改稿功能满意度', '打印材料使用记录', '中班科学区观察',
  '大班工程活动难点', '农村园材料替代方案', '家长开放日素材需求', '教研组使用习惯',
  '11 月阶段小结', '年龄班适配度复核', '配图打印质量反馈', '学期末总体评价',
];

/** 六种定向，轮着用 —— 详情页那几张分布图要有东西看 */
const targets = (kgIds) => [
  {},                                                              // 所有人
  { provinces: ['广东'] },
  { provinces: ['浙江'] },
  { area_types: ['rural'] },
  { area_types: ['city'], ownerships: ['public'] },
  { age_groups: ['小班'] },
  { ownerships: ['private'] },
  { kindergarten_ids: [kgIds[0]] },
  { area_types: ['county', 'rural'] },
  { age_groups: ['大班'], provinces: ['浙江'] },
];

async function seed() {
  L(`后端 ${BASE}`);
  token = (await adm('POST', '/login', { username: 'admin', password: '123456' })).token;

  // 已经造过就先清 —— 否则重名会让园所导入整批 duplicate，然后什么都建不出来
  const existed = await queryOne(`SELECT COUNT(*)::int n FROM kindergartens WHERE name LIKE $1`, [`${TAG}%`]);
  if (existed.n) { L(`已有 ${existed.n} 个演示园所，先清一遍`); await clear(); }

  /* 1. 园所 —— 走导入接口（顺带证明它真能用） */
  const kgText = KGS.map((k) => [k.name, k.province, k.city,
    { city: '城市', county: '县镇', rural: '农村' }[k.area_type],
    { public: '公办', private: '民办' }[k.ownership],
    k.teacher_count, k.child_count, k.contact_name || '', k.contact_phone || '', k.note || '',
  ].join('\t')).join('\n');
  const kgRes = await adm('POST', '/kindergartens/import', { text: kgText, dry_run: false });
  L(`园所 ${kgRes.imported} 个`);
  const kgIds = (await query(`SELECT id, name FROM kindergartens WHERE name LIKE $1 ORDER BY id`, [`${TAG}%`]))
    .rows.map((r) => r.id);

  /* 2. 名单 —— 按园分批导入 */
  let rosterCount = 0;
  for (let i = 0; i < KGS.length; i += 1) {
    const mine = TEACHERS.filter((t) => t.kg === i);
    if (!mine.length) continue;
    const text = mine.map((t) => [t.name, t.cls, t.pos, t.age].join('\t')).join('\n');
    const r = await adm('POST', '/roster/import', { text, kindergarten_id: kgIds[i], dry_run: false });
    rosterCount += r.imported;
  }
  L(`名单 ${rosterCount} 行`);

  /* 3. 兑换码 —— 一批给要激活的那些用 */
  const need = TEACHERS.filter((t) => t.act).length;
  const codes = (await adm('POST', '/codes/batch', {
    count: need + 4, init_text: 20, init_image: 10, grant_reason: `${TAG}·首批发放`,
  })).created;
  // 再建一批没人兑的，好让「未兑换」那一列有东西
  await adm('POST', '/codes/batch', { count: 6, init_text: 30, init_image: 15, grant_reason: `${TAG}·10 月批次` });
  L(`兑换码 ${codes.length + 6} 个（两批）`);

  /* 4. 激活 —— 走真流程：假登录 → 拉名单 → 兑码 → 同意协议 */
  const rosterRows = (await query(
    `SELECT id, real_name, kindergarten_id FROM teacher_roster WHERE real_name LIKE $1`, [`${TAG}%`]
  )).rows;
  const tokens = {};
  let ci = 0;
  for (const t of TEACHERS) {
    if (!t.act) continue;
    const row = rosterRows.find((r) => r.real_name === t.name);
    if (!row) { L(`  ⚠️ 名单里找不到 ${t.name}，跳过`); continue; }
    // openid 用 `dev:demo_xxx` → 后端存成 `dev_demo_xxx`（DEV_FAKE_LOGIN）
    const slug = `demo_${row.id}`;
    const tok = (await usr('POST', '/auth/login', null, { code: `dev:${slug}` })).token;
    await usr('POST', '/auth/redeem', tok, { code: codes[ci], roster_entry_id: row.id });
    ci += 1;
    await usr('POST', '/me/agree', tok);
    tokens[t.name] = tok;
  }
  L(`激活 ${Object.keys(tokens).length} 位`);

  /* 5. 教案与评价 —— **这一段直插库**
   *
   * 真生成一份教案要调 DeepSeek、20 多秒、花钱，而演示数据要的只是
   * 「列表里有几行、额度用掉了几次、有人评价过」。
   * 字段是照 `services/lessonGenerator.js` 的产出抄的：
   * conversations 一行（status=completed）+ lesson_plans 一行（version=1）。
   *
   * ⚠️ `content_md` / `content_json` 是 NOT NULL，所以正文不能留空 ——
   * 但也**不编一份像样的假教案**：那会被当成模型真的写出来的东西，
   * 而这个项目最大的未知数正是「AI 写的教案到底能不能用」，
   * 往那个池子里掺一份假的比空着糟得多。
   * 放的是一句一眼看得出是占位的话。 */
  const DEMO_MD = '（演示数据，无正文。真实教案由模型生成。）';
  const THEMES = ['浮与沉', '影子的秘密', '风的力量', '斜坡与滚动', '声音是怎么来的',
    '磁铁找朋友', '水的三态', '搭高塔', '光和影子', '种子发芽'];
  let planCount = 0;
  let fbCount = 0;
  await withTransaction(async (c) => {
    for (const t of TEACHERS) {
      if (!t.act || !t.plans) continue;
      const acct = (await c.query(
        `SELECT tt.id FROM teachers tt JOIN teacher_roster r ON r.id = tt.roster_entry_id
          WHERE r.real_name = $1 LIMIT 1`, [t.name])).rows[0];
      if (!acct) continue;
      for (let i = 0; i < t.plans; i += 1) {
        const theme = THEMES[(planCount + i) % THEMES.length];
        const conv = (await c.query(
          `INSERT INTO conversations (teacher_id, seed_input, age_group, status, mode, collected, created_at)
           VALUES ($1,$2,$3,'completed',$4,'{}'::jsonb, now() - ($5 || ' days')::interval)
           RETURNING id`,
          [acct.id, `我想做个${theme}的活动`, t.age, i % 3 === 0 ? 'learning' : 'efficient', String(i * 3 + 1)]
        )).rows[0];
        const plan = (await c.query(
          `INSERT INTO lesson_plans (conversation_id, teacher_id, title, age_group, duration_min,
                                     content_md, content_json, version, current_version, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,1,1, now() - ($8 || ' days')::interval) RETURNING id`,
          [conv.id, acct.id, `${theme}（${t.age}）`, t.age,
            { 小班: 20, 中班: 25, 大班: 30 }[t.age] || 25,
            DEMO_MD, JSON.stringify({ demo: true }), String(i * 3 + 1)]
        )).rows[0];
        planCount += 1;
        // 只给第一份教案挂评价 —— 真实情况下老师不会每份都评
        if (t.rate && i === 0) {
          await c.query(
            `INSERT INTO feedback (teacher_id, kind, lesson_plan_id, plan_version, rating, created_at)
             VALUES ($1,'lesson_rating',$2,1,$3, now() - interval '2 days')`,
            [acct.id, plan.id, t.rate]);
          fbCount += 1;
        }
      }
    }
  });
  L(`教案 ${planCount} 份、教案评价 ${fbCount} 条`);

  /* 6. 产品建议 —— 走真接口（老师端那条路） */
  const SUGGESTS = [
    ['feature', '希望能导出成 Word，园里交材料要用 Word 格式。'],
    ['quality', '小班的活动过程还是偏难，孩子坐不住那么久。'],
    ['usability', '配图那个抽屉每次要滑好几下才找到，能不能放上面一点。'],
    ['feature', '想要一个「上次的教案」入口，改一改的时候好对照。'],
    ['other', '整体挺好用的，谢谢开发者。'],
    ['quality', '记录表打出来格子有点小，孩子写不进去。'],
  ];
  const actNames = Object.keys(tokens);
  for (let i = 0; i < SUGGESTS.length; i += 1) {
    const tok = tokens[actNames[i % actNames.length]];
    if (!tok) continue;
    // `POST /v1/feedback` 只收 category 和 text —— kind 由后端写死成 suggestion
    await usr('POST', '/feedback', tok, { category: SUGGESTS[i][0], text: SUGGESTS[i][1] });
  }
  L(`产品建议 ${SUGGESTS.length} 条`);

  /* 7. 20 条任务 —— 定向轮着来，状态铺开（草稿 / 进行中 / 已停止） */
  const tg = targets(kgIds);
  const today = new Date();
  const day = (n) => new Date(today.getTime() + n * 86400000).toISOString().slice(0, 10);
  let published = 0;
  let closed = 0;
  for (let i = 0; i < TASK_TITLES.length; i += 1) {
    const created = await adm('POST', '/tasks', {
      title: `${TAG}·${TASK_TITLES[i]}`,
      body: '填完这份问卷，我会给你发一个兑换码。',
      survey_url: 'https://www.wjx.cn/vm/example.aspx',
      reward_text: 20, reward_image: 10,
      // 每五条里有一条不限时；截止日**都在将来**，否则发布会被
      // 「截止日期已经过了」拦掉（那道拦截是对的，见 publish 那段注释）
      deadline: i % 5 === 4 ? '' : day(7 + (i % 4) * 7),
      target: tg[i % tg.length],
    });
    // 前 14 条发布，其中 4 条随后停止；后 6 条留成草稿
    if (i < 14) {
      await adm('POST', `/tasks/${created.id}/publish`);
      published += 1;
      if (i % 4 === 3) { await adm('POST', `/tasks/${created.id}/close`); closed += 1; }
    }
  }
  L(`任务 ${TASK_TITLES.length} 条（进行中 ${published - closed}、已停止 ${closed}、草稿 ${TASK_TITLES.length - published}）`);

  /* 8. 已读 —— 让详情页那个「已读率」不是 0 */
  const openTasks = (await query(
    `SELECT id FROM tasks WHERE title LIKE $1 AND status = 'open' ORDER BY id LIMIT 6`, [`${TAG}%`])).rows;
  let reads = 0;
  for (let i = 0; i < openTasks.length; i += 1) {
    const tok = tokens[actNames[i % actNames.length]];
    if (!tok) continue;
    try { await usr('POST', `/tasks/${openTasks[i].id}/read`, tok); reads += 1; }
    catch { /* 这位老师不在这条任务的定向里就跳过 —— 那是对的 */ }
  }
  L(`已读 ${reads} 条`);

  L('\n演示数据造好了。清掉：node scripts/seed-demo.mjs --clear');
}

try {
  if (CLEAR) await clear();
  else await seed();
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
