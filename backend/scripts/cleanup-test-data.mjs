/**
 * 清掉联调过程中造出来的假数据，只留真正在用的。
 *
 *   node scripts/cleanup-test-data.mjs           # 只看要删什么，**不动数据**
 *   node scripts/cleanup-test-data.mjs --yes     # 真删
 *   node scripts/cleanup-test-data.mjs --yes --keep 33,41   # 额外保留这几个老师 id
 *
 * 判定「这是假账号」的依据只有一条**硬证据**：openid 以 `dev_` 开头。
 * 那是 DEV_FAKE_LOGIN 造出来的（真微信 openid 不长这样），所以不会误伤真老师。
 * 不按姓名或手机号猜 —— 「试用」「测试」这种名字真老师也可能填。
 *
 * 保留名单默认包含 KEEP_OPENIDS 里那个开发者自己在用的账号：
 * 它虽然也是 dev_ 开头，但它是**当前真正在用的那个**，删了下次进小程序就是新账号。
 *
 * 一并清掉：没人认领的兑换码（是给这些假账号建的）、假账号名下的教案配图文件。
 * 不动：园所、管理员账号、app_settings、image_models。
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
    `SELECT t.id, t.openid, t.real_name, t.phone, t.status, t.created_at,
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
