/**
 * 清掉联调过程中造出来的假数据，只留真正在用的。
 *
 *   node scripts/cleanup-test-data.mjs           # 只看要删什么，**不动数据**
 *   node scripts/cleanup-test-data.mjs --yes     # 真删
 *   node scripts/cleanup-test-data.mjs --yes --keep 33,41   # 额外保留这几个老师 id
 *   node scripts/cleanup-test-data.mjs --yes --codes         # 连未使用的兑换码一起删
 *   node scripts/cleanup-test-data.mjs --yes --roster        # 连还没被认领的名单一起删
 *
 * 判定「这是假账号」的依据只有一条**硬证据**：openid 以 `dev_` 开头。
 * 那是 DEV_FAKE_LOGIN 造出来的（真微信 openid 不长这样），所以不会误伤真老师。
 * 不按姓名或手机号猜 —— 「试用」「测试」这种名字真老师也可能填。
 *
 * 保留名单默认包含 KEEP_OPENIDS 里那个开发者自己在用的账号：
 * 它虽然也是 dev_ 开头，但它是**当前真正在用的那个**，删了下次进小程序就是新账号。
 *
 * 一并清掉：没人认领的兑换码（是给这些假账号建的）、假账号名下的教案配图文件、
 * 回归脚本自建的管理员和园所（都按**脚本的命名规律**认，不猜）。
 * 不动：真实园所、admin 账号、app_settings、image_models。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { query, queryOne, closePool } from '../src/db/pool.js';
import { config } from '../src/config.js';

/** 开发者自己在用的那个账号 —— 删了下次进小程序就成新账号了 */
const KEEP_OPENIDS = ['dev_zdnk6t6k'];

const DO_IT = process.argv.includes('--yes');
const keepArg = process.argv[process.argv.indexOf('--keep') + 1];
const KEEP_IDS = process.argv.includes('--keep') && keepArg
  ? keepArg.split(',').map((x) => Number(x.trim())).filter(Boolean)
  : [];

const L = console.log;

const victims = (
  await query(
    // 没有 t.phone —— 016 迁移把那一列删了
    `SELECT t.id, t.openid, t.real_name, t.status, t.created_at,
            (SELECT COUNT(*) FROM conversations c WHERE c.teacher_id = t.id)::int AS convs,
            (SELECT COUNT(*) FROM lesson_plans p WHERE p.teacher_id = t.id)::int  AS plans
       FROM teachers t
      WHERE t.openid LIKE 'dev\\_%'
        AND NOT (t.openid = ANY($1::text[]))
        AND NOT (t.id = ANY($2::bigint[]))
      ORDER BY t.id`,
    [KEEP_OPENIDS, KEEP_IDS]
  )
).rows;

const kept = (
  await query(
    `SELECT id, openid, real_name FROM teachers
      WHERE openid = ANY($1::text[]) OR id = ANY($2::bigint[]) OR openid NOT LIKE 'dev\\_%'
      ORDER BY id`,
    [KEEP_OPENIDS, KEEP_IDS]
  )
).rows;

const orphanCodes = (
  await query(
    `SELECT COUNT(*)::int AS n FROM redemption_codes c
      WHERE (c.status = 'used' AND c.used_by IS NULL) OR c.used_by = ANY($1::bigint[])`,
    [victims.map((v) => v.id)]
  )
).rows[0].n;

L(`\n将要删除 ${victims.length} 个假账号（openid 以 dev_ 开头）：`);
for (const v of victims.slice(0, 12)) {
  L(`  #${v.id} ${v.openid.padEnd(22)} ${(v.real_name || '(无名)').padEnd(10)} 会话 ${v.convs} 教案 ${v.plans}`);
}
if (victims.length > 12) L(`  …另外 ${victims.length - 12} 个`);

L(`\n保留 ${kept.length} 个账号：`);
for (const k of kept) L(`  #${k.id} ${String(k.openid).slice(0, 22).padEnd(22)} ${k.real_name || '(无名)'}`);

L(`\n顺带清掉：没人认领或属于假账号的兑换码 ${orphanCodes} 个`);

if (!DO_IT) {
  L('\n这是**预览**，什么都没动。确认无误后加 --yes 再跑一次。\n');
  await closePool();
  process.exit(0);
}

// 图片文件要在删行之前取出来 —— 行没了就找不到磁盘上那些文件了
const keys = (
  await query(
    `SELECT i.object_key FROM lesson_images i
       JOIN lesson_plans p ON p.id = i.lesson_plan_id
      WHERE p.teacher_id = ANY($1::bigint[]) AND i.object_key <> ''`,
    [victims.map((v) => v.id)]
  )
).rows.map((r) => r.object_key);

const ids = victims.map((v) => v.id);
// conversations / lesson_plans / lesson_images / memories / grants / feedback
// 全部按外键 ON DELETE CASCADE 跟着走
await query(`DELETE FROM teachers WHERE id = ANY($1::bigint[])`, [ids]);
// 只删**真正的孤儿**：主人被删之后，外键 ON DELETE SET NULL 把它们变成
// 「已使用但没有使用者」。**不能写成 used_by IS NULL** —— 未使用的码 used_by 本来就是空，
// 那样会把刚发出去还没人兑的真码一起删掉。
await query(`DELETE FROM redemption_codes WHERE status = 'used' AND used_by IS NULL`);
// 未使用的码要单独确认才删（--codes），它们可能是刚发给老师、还没兑的
if (process.argv.includes('--codes')) {
  await query(`DELETE FROM redemption_codes WHERE status = 'unused'`);
}
// 回归脚本每跑一次就建一个同事账号和一个第二超管，攒了十几个。
// 只留 admin 和真正给人用的 —— 按「测试脚本的命名规律」删，不猜
await query(`DELETE FROM admins WHERE username ~ '^(colleague|sup2)_[0-9]+$'`);
/**
 * 回归脚本自建的园。
 *
 * 每个脚本都不许动真实园所（admin-test 那一版曾经改坏了「童心幼儿园」的备注），
 * 所以它们各自建一个带时间戳的园 —— 于是跑十轮攒十个。
 *
 * 判定靠**脚本的命名规律**（`xxx_12345678`，尾巴是 8 位以上的时间戳），不猜。
 * 真实园所不会叫这个名字；万一哪天有，加个 --keep 的口子再说。
 * 外键是 ON DELETE SET NULL，删了不会连累老师、码和名单。
 */
const junkKg = await query(
  `DELETE FROM kindergartens
    WHERE name ~ '^(回归测试园|改过名|任务园.*|后台回归园|契约测试园|换绑回归园|激活回归园|版本回归园|运营回归园|冒烟园)_[0-9]{6,}$'
    RETURNING name`
);
if (junkKg.rowCount) L(`  删掉 ${junkKg.rowCount} 个回归脚本自建的园`);

// 任务也是脚本造的（标题里带同一个时间戳）。task_reads 跟着 CASCADE 走
const junkTask = await query(
  `DELETE FROM tasks WHERE title ~ ' [0-9]{6,}$' OR title ~ '^(草稿|过期发布|坏链接) ' RETURNING id`
);
if (junkTask.rowCount) L(`  删掉 ${junkTask.rowCount} 个回归脚本造的任务`);

/**
 * 名单里的**孤儿认领**。
 *
 * 上面删掉假账号之后，teacher_roster.claimed_by 被外键 ON DELETE SET NULL 清空，
 * 但 status 还是 'claimed' —— 于是那个手机号**永远占着**，
 * 再也没法激活，而且看不出为什么。这不是「测试数据」，是清理动作造成的不一致。
 *
 * 判定依据是**硬证据**：已认领，但认领人不存在了。不猜姓名手机号。
 * 放回 pending 而不是删掉那一行：名单本身可能是真的（园长给的），
 * 丢掉它等于让那位老师从名单里消失。
 */
const orphan = await query(
  `UPDATE teacher_roster SET status = 'pending', claimed_by = NULL,
          claimed_openid = NULL, claimed_at = NULL
    WHERE status = 'claimed' AND claimed_by IS NULL
    RETURNING id`
);
if (orphan.rowCount) L(`  名单里 ${orphan.rowCount} 行的认领人已经不在了，放回「等她来激活」`);

// 还没被认领的名单要单独确认才删（--roster）：它们可能是刚从园长那儿录进来的真名单。
// account_rebinds 不用管 —— 它挂在 teacher_id 上，ON DELETE CASCADE 跟着账号一起走
if (process.argv.includes('--roster')) {
  const r = await query(`DELETE FROM teacher_roster WHERE status = 'pending' RETURNING id`);
  L(`  删掉 ${r.rowCount} 行还没被认领的名单（--roster）`);
}

let removed = 0;
for (const key of keys) {
  try {
    await fs.unlink(path.join(config.localImageDir, key));
    removed += 1;
  } catch { /* 已经不在就算了 */ }
}

const left = await queryOne(`SELECT COUNT(*)::int n FROM teachers`);
L(`\n删完了：${ids.length} 个账号、${removed} 个图片文件。现在还剩 ${left.n} 个账号。\n`);
await closePool();
