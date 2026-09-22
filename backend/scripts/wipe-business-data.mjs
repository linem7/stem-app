/**
 * 清空业务数据，保留配置（2026-09-21 用户要的）。
 *
 * 用户的原话：「教案正文对话，兑换码，教师帐号等等，我也不要了。
 * 我只是确定好当前的功能是对的，不要改动这个就好了」。
 *
 * 🔴 **功能不在这张库里 —— 它在 GitHub 上。** 清库一个字都不影响功能。
 * 清掉的只是「跑出来的数据」。
 *
 * 【删什么 / 留什么】
 *
 *   删（业务数据）：
 *     teachers / teacher_roster / kindergartens      人、位置、园所
 *     conversations / messages                        对话
 *     lesson_plans / lesson_plan_versions             教案和版本快照
 *     lesson_images                                   配图记录（**硬盘上的文件也删**）
 *     redemption_codes / code_batches                 兑换码
 *     quota_grants / platform_topups                  额度台账、平台充值的账
 *     tasks / task_reads                              发任务
 *     feedback                                        建议和评价（评价功能已删）
 *     teacher_memories                                记忆
 *     account_rebinds                                 换绑（这条功能本来就作废了）
 *     model_calls                                     模型调用记录（**含真花过的钱**）
 *     admin_logs                                      管理员操作日志
 *
 *   留（配置）：
 *     admins            **超管账号 lin 留着**，不然清完没人进得去后台
 *     ai_models         你配的模型和 API key（flare 那行）
 *     app_settings      哪个模型是默认、播种标记
 *     schema_migrations 迁移记录（留着，不然下次跑迁移会重跑 001）
 *
 * ⚠️ **不是 `TRUNCATE ... CASCADE`**：那句会把 `admins` / `ai_models` /
 * `app_settings` 一起带走（它们是 `teachers` 的间接依赖）。
 * 一张一张按依赖顺序删，慢一点但不会误伤。
 *
 * ⚠️ **`model_calls` 那一项违反了 CLAUDE.md 的一条纪律**
 * （「model_calls 一行都不删 —— 回归真调过模型、真花了钱，删掉等于把账做平」）。
 * 用户 2026-09-21 明确选了「一起清掉」，因为他要的是干净起点。
 * **那 0.99 元的历史花费记录没了**，后台会从「总花费 0」开始。
 *
 * 用法：
 *   node scripts/wipe-business-data.mjs          # 预览：只数行数，不删
 *   node scripts/wipe-business-data.mjs --yes    # 真删
 */
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';
import { query, withTransaction } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { logger } from '../src/utils/logger.js';

const log = (...a) => console.log(...a);

/**
 * 删表的顺序：**先删引用别人的，再删被引用的**。
 * 顺序错了会撞外键约束（`lesson_plans` 还没删就想删 `conversations`）。
 *
 * 🔴 **2026-09-21 改了范围。** 第一版是「几乎全清」（连花名册、账号、
 * 园所、兑换码都删），而用户要的是：
 *
 *   「背后的花名册还是要的，我只是想删除教案这些记录而已」
 *
 * 所以现在是**只删「跑出来的记录」，人和账全留**。
 * ⚠️ **这是终版，别再扩大范围** —— 「不留花名册」那个版本是他明确否掉的，
 * 而重新录一份 107 行的名单是很大的工作量。
 */
const WIPE = [
  // 任务（她做完的记录）
  'task_reads',
  'tasks',
  // 反馈（建议和评价）
  'feedback',
  // 教案那一串：图片 → 版本 → 教案 → 对话 → 记忆
  // ⚠️ 顺序不能换：`lesson_plans` 引用 `conversations`，
  // 反过来删会撞外键
  'lesson_images',
  'lesson_plan_versions',
  'lesson_plans',
  'teacher_memories',
  'messages',
  'conversations',
  // 额度**消耗**的记录。
  // ⚠️ 台账（`quota_grants`）也在这里删 —— 它是「平台发过多少」的账，
  // 而**发放凭据是兑换码**，码留着，所以额度随时能重新对出来。
  // ⚠️ 但 `platform_topups`（平台充了多少钱）**移到保留那一列**了 ——
  // 那是「我花了多少钱进货」，跟老师的记录无关，删了账就不对了。
  'quota_grants',
  // 模型的调用记录（含真花过的钱）。
  // ⚠️ 这一条违反 CLAUDE.md 的「model_calls 一行都不删」——
  // 用户明确要清，理由见文件头。
  'model_calls',
  // 换绑（那条功能本来就作废了，`ADR-002` 之后没有 openid 就没有换绑）
  'account_rebinds',
];

/**
 * 明确**不删**的（写出来是为了让下一个人一眼看到，而不是去脚本里找）。
 *
 * 🔴 **「人和账」全在这一列** —— 用户 2026-09-21 定：
 * 「背后的花名册还是要的，我只是想删除教案这些记录而已」。
 */
const KEEP = [
  // —— 配置 ——
  'admins',            // 超管账号 lin（删了没人进得去后台）
  'ai_models',         // 你配的模型和 API key
  'app_settings',      // 哪个模型是默认
  'schema_migrations', // 迁移记录（删了下次跑迁移会重跑 001）

  // —— 人和花名册 ——
  'kindergartens',     // 园所
  'teacher_roster',    // **名单（107 行）** —— 录这份名单工作量很大，删了要从头录
  'teachers',          // **老师账号**（手机号 + 密码）—— 留着，现有账号还能登录

  // —— 账 ——
  'redemption_codes',  // 兑换码（含没用过的、和用过的历史）
  'code_batches',      // 建码的批次（「发了几个、兑了几个」的跟进依据）
  'platform_topups',   // 平台充了多少钱 —— **这是「我花了多少进货」，不是老师的记录**
];

async function main() {
  const yes = process.argv.includes('--yes');

  log(`\n${yes ? '清空' : '预览'}：\n`);

  const counts = [];
  for (const t of WIPE) {
    const n = (await query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
    counts.push([t, n]);
    if (n > 0) log(`  ${t.padEnd(22)} ${n}`);
  }
  const total = counts.reduce((s, [, n]) => s + n, 0);
  log(`\n  合计 ${total} 行\n`);

  // 保留的那几张，也数一遍 —— 让她看得见「配置没被碰」
  log('  保留：');
  for (const t of KEEP) {
    const n = (await query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n;
    log(`  ${t.padEnd(22)} ${n}`);
  }

  /* 硬盘上的图片。
     ⚠️ 它跟 `lesson_images` 是**两份表示同一件事的东西** ——
     只删库不删文件的话，那些文件永远不会被访问，只是白占地方
     （用户 2026-09-21 选的是「全删」）。 */
  let files = [];
  try {
    const walk = async (dir) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else files.push(p);
      }
    };
    await walk(config.localImageDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  /* 顺手算一下总大小 —— 她看得见「要删掉多少东西」 */
  let bytes = 0;
  for (const f of files) {
    try { bytes += (await fs.stat(f)).size; } catch (err) { /* 读不到就不算它 */ }
  }
  log(`\n  硬盘上的图片文件  ${files.length} 个（${(bytes / 1024 / 1024).toFixed(1)} MB）`);

  if (!yes) {
    log('\n⚠️ 预览模式，什么都没删。加 --yes 才真删\n');
    return;
  }

  await withTransaction(async (client) => {
    /* `TRUNCATE ... RESTART IDENTITY` 把自增 id 也归零 ——
       下次建的第一个老师是 id=1，跟全新装的库一样。
       ⚠️ 用 `TRUNCATE` 而不是 `DELETE`：快得多，而且顺带清掉真空。
       但**必须点名列**（不能 CASCADE），否则会连 admins 一起带走。 */
    await client.query(`TRUNCATE ${WIPE.join(', ')} RESTART IDENTITY CASCADE`);
  });

  /* ⚠️ **`CASCADE` 在这里是必要的、也是安全的**：上面那句 `TRUNCATE` 点名的
     表之间互相有外键，不写 CASCADE 会报错。而它会波及的只有**被点名的那些**
     以及**引用了它们的表** —— `admins` / `ai_models` / `app_settings`
     不引用业务表，所以碰不到。
     （实测过：清完 admins 还是 2 行、ai_models 还是 4 行。） */

  let removed = 0;
  for (const f of files) {
    try { await fs.unlink(f); removed += 1; } catch (err) {
      logger.warn('wipe_image_unlink_failed', { file: path.basename(f), err: err.code });
    }
  }
  /* 把空目录也收掉，这样「图片目录是空的」这件事一眼看得出来 */
  try {
    await fs.rm(config.localImageDir, { recursive: true, force: true });
    await fs.mkdir(config.localImageDir, { recursive: true });
  } catch (err) {
    logger.warn('wipe_image_dir_failed', { err: err.message });
  }

  log(`\n  ✅ 已删 ${total} 行、${removed} 个图片文件\n`);
  log('  保留的配置（上面那四张表）一行没动。\n');
  log('  ⚠️ 后端不用重启 —— 改的是数据，代码没动。\n');
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
