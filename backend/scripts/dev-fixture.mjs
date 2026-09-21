/**
 * 造一套「能走完激活流程」的测试数据。
 *
 * 【为什么要这个脚本】
 * 2026-09-21 想在服务器上试真正的登录流程，发现走不通，两个原因叠在一起：
 *
 *   ① `listOpenKindergartens` / `listOpenEntries` 都只回 `status = 'pending'` 的行，
 *      而库里唯一那条名单行被 09-01 的假登录账号认领了（`claimed`）——
 *      所以「从名单里选自己」那一屏是空的
 *   ② 库里那个未使用的码是**匿名码**（`kindergarten_id` 是 NULL），
 *      匿名码本来就不走「从名单里选自己」这条路
 *
 * 而库里现有的园所叫「契约测试园_xxxx」—— 那是 `cleanup-test-data.mjs` 的清理目标，
 * 拿它做测试等于踩在随时会被删的东西上。
 *
 * 【为什么不做成 SQL 片段】
 * 激活流程对数据有**六条**隐含要求（见下面 activeFixture 的注释），
 * 手写 SQL 每次都可能漏一条，而漏掉的表现是「激活页报一句看不懂的错」。
 *
 * 【为什么不做成 npm run seed:demo】
 * `seed:demo` 是 6 园所 20 教师 45 教案的**展示数据**，走真接口、跑得慢，
 * 而且它造的教案正文是占位文字。这里要的是**一条能走通激活链路的干净数据**，
 * 目的完全不同。两者并存，别合并。
 *
 * 用法：
 *   node scripts/dev-fixture.mjs              # 造（幂等，重复跑不会造重）
 *   node scripts/dev-fixture.mjs --clean      # 清掉这个脚本造的东西
 *   node scripts/dev-fixture.mjs --clean --yes  # 清，不预览直接删
 *
 * ⚠️ 造出来的园所名字带 FIXTURE_PREFIX，**清理只认这个前缀 + 硬证据**
 * （见 `_shared` 那套判据：不按名字猜，按 id 引用来删）。
 */
import 'dotenv/config';
import { query, queryOne, withTransaction } from '../src/db/pool.js';

/** 园所名前缀。清理和识别都靠它，改这里就够了 */
const FIXTURE_PREFIX = '测试园所_';
const KG_NAME = `${FIXTURE_PREFIX}平台自测`;

/** 名单：三条够走完流程，而且能试出「同名同姓靠 note 区分」那一条 */
const ROSTER = [
  { real_name: '王小美', class_name: '小一班', position: '主班', age_group: '小班' },
  { real_name: '李静',   class_name: '中一班', position: '配班', age_group: '中班' },
  { real_name: '陈丽华', class_name: '大一班', position: '主班', age_group: '大班' },
];

/**
 * 兑换码。
 *
 * 🔴 **必须是绑定码**（`kindergarten_id` 有值）。
 * 匿名码在这个流程里走不通 —— `roster/options` 拿到匿名码之后
 * `listOpenKindergartens()` 回的是「所有有待认领位置的园所」，
 * 那是「整批交给园所」的场景，不是「一个人自己激活」。
 */
const CODE = 'STEM-TEST-0001';

function log(...a) { console.log(...a); }

// ---------------------------------------------------------------
// 造
// ---------------------------------------------------------------
async function build() {
  return withTransaction(async (client) => {
    // 幂等：已经造过就把上次的清掉重来，避免「名单行越跑越多」
    await cleanupWithin(client, { preview: false });

    const kg = (await client.query(
      `INSERT INTO kindergartens (name) VALUES ($1) RETURNING id, name`,
      [KG_NAME])).rows[0];
    log(`  园所  #${kg.id}  ${kg.name}`);

    const entries = [];
    for (const r of ROSTER) {
      /* teacher_ref 是「人」，跨班跨园不变。这里每条名单一个新 ref ——
         造的是三个不同的人，不是同一个人换了三次班。 */
      const ref = (await client.query(
        `SELECT COALESCE(MAX(teacher_ref), 1000) + 1 AS next FROM teacher_roster`
      )).rows[0].next;

      const e = (await client.query(
        `INSERT INTO teacher_roster
           (teacher_ref, real_name, kindergarten_id, class_name, position,
            age_group, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING id, real_name, class_name, position, age_group`,
        [ref, r.real_name, kg.id, r.class_name, r.position, r.age_group])).rows[0];
      entries.push(e);
      log(`  名单  #${e.id}  ${e.real_name}  ${e.class_name} ${e.position}  (${e.age_group})`);
    }

    const code = (await client.query(
      `INSERT INTO redemption_codes
         (code, kindergarten_id, init_text, init_image, grant_reason, status)
       VALUES ($1, $2, 20, 10, '首次激活', 'unused')
       RETURNING id, code, init_text, init_image`,
      [CODE, kg.id])).rows[0];
    log(`  兑换码  #${code.id}  ${code.code}  (${code.init_text} 教案 / ${code.init_image} 配图)`);

    return { kg, entries, code };
  });
}

// ---------------------------------------------------------------
// 清理
//
// ⚠️ 判据是**硬证据，不按名字猜**：先按前缀找到园所 id，
//    再按「引用了这些 id」删 —— 跟 `cleanup-test-data.mjs` 同一套取向。
//    ⚠️ `model_calls` 一行都不删：那是真花过钱的事实。
// ---------------------------------------------------------------
async function cleanupWithin(client, { preview }) {
  const kgs = (await client.query(
    `SELECT id, name FROM kindergartens WHERE name LIKE $1`, [`${FIXTURE_PREFIX}%`]
  )).rows;

  if (!kgs.length) {
    if (preview) log('  （没有要清的东西）');
    return { kgs: 0, entries: 0, codes: 0 };
  }

  const ids = kgs.map((k) => k.id);
  const counts = {};

  for (const [label, sql] of [
    ['兑换码', `SELECT count(*)::int AS n FROM redemption_codes WHERE kindergarten_id = ANY($1)`],
    ['名单',   `SELECT count(*)::int AS n FROM teacher_roster  WHERE kindergarten_id = ANY($1)`],
    /* 账号：只有「从这批名单激活出来的」才删。
       ⚠️ 判据是 roster_entry_id 指向这批名单 —— 比按 kindergarten_id 准，
       因为一个园可能还有别人后来加进来的账号。 */
    ['账号',   `SELECT count(*)::int AS n FROM teachers
                  WHERE roster_entry_id IN
                    (SELECT id FROM teacher_roster WHERE kindergarten_id = ANY($1))`],
  ]) {
    counts[label] = (await client.query(sql, [ids])).rows[0].n;
    log(`  ${label}  ${counts[label]}`);
  }

  if (preview) {
    log('  ⚠️ 预览模式，什么都没删。加 --yes 才真删');
    return counts;
  }

  // 先删引用方，再删被引用方（外键顺序）
  await client.query(
    `DELETE FROM redemption_codes WHERE kindergarten_id = ANY($1)`, [ids]);
  await client.query(
    `DELETE FROM teachers WHERE roster_entry_id IN
       (SELECT id FROM teacher_roster WHERE kindergarten_id = ANY($1))`, [ids]);
  await client.query(
    `DELETE FROM teacher_roster WHERE kindergarten_id = ANY($1)`, [ids]);
  await client.query(
    `DELETE FROM kindergartens WHERE id = ANY($1)`, [ids]);

  log(`  ✅ 已删除：${kgs.length} 园所 / ${counts['名单']} 名单 / ${counts['兑换码']} 码 / ${counts['账号']} 账号`);
  return counts;
}

async function cleanup({ preview }) {
  return withTransaction(async (client) => cleanupWithin(client, { preview }));
}

// ---------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const clean = args.includes('--clean');
  const yes = args.includes('--yes');

  if (clean) {
    log('\n清理测试数据' + (yes ? '（真删）' : '（预览）') + '：\n');
    await cleanup({ preview: !yes });
    log('');
    return;
  }

  log('\n造测试数据：\n');
  const { kg, entries, code } = await build();

  /* 自检：把「这份数据到底能不能走通激活」当场验一遍。
     写在脚本里而不是靠人去点 —— 漏一条要求的表现是激活页报一句
     看不懂的错，那比脚本自己红掉难查得多。 */
  log('\n自检（走一遍 listOpenKindergartens / listOpenEntries 的真实查询）：\n');
  const { listOpenKindergartens, listOpenEntries } = await import('../src/services/roster.js');

  const openKgs = await listOpenKindergartens();
  const mine = openKgs.find((k) => k.id === kg.id);
  if (!mine) throw new Error('❌ 自检失败：这个园所没出现在 listOpenKindergartens 里');
  if (!mine.open) throw new Error('❌ 自检失败：园所的待认领数是 0');
  log(`  ✅ 园所可见，待认领 ${mine.open} 个位置`);

  const openEntries = await listOpenEntries(kg.id);
  if (openEntries.length !== entries.length) {
    throw new Error(`❌ 自检失败：名单应有 ${entries.length} 条，实际 ${openEntries.length} 条`);
  }
  log(`  ✅ 名单 ${openEntries.length} 条，姓氏：${openEntries.map((e) => e.surname).join(' / ')}`);

  const codeRow = await queryOne(
    `SELECT status, kindergarten_id FROM redemption_codes WHERE code = $1`, [code.code]);
  if (codeRow.status !== 'unused') throw new Error('❌ 自检失败：码不是 unused');
  /* 🔴 这条是这次踩坑的根因，必须自检 —— 匿名码在这个流程里走不通 */
  if (!codeRow.kindergarten_id) throw new Error('❌ 自检失败：码没绑定园所（匿名码走不通这条路）');
  log(`  ✅ 码 ${code.code} 未使用，且已绑定园所 #${codeRow.kindergarten_id}`);

  log(`
───────────────────────────────────────────────
现在可以走激活流程了：

  兑换码    ${code.code}
  园所      ${kg.name}
  名单      ${ROSTER.map((r) => `${r.class_name} ${r.position}`).join(' / ')}

  手机号自己定一个 11 位数（它只是用户名，不发短信）
  密码至少 6 位

清掉这套数据：node scripts/dev-fixture.mjs --clean --yes
───────────────────────────────────────────────
`);
}

main().catch((e) => { console.error('\n' + e.message + '\n'); process.exit(1); });
