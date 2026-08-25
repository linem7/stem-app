/**
 * 清掉联调过程中造出来的假数据，只留真正在用的。
 *
 *   node scripts/cleanup-test-data.mjs           # 只看要删什么，**不动数据**
 *   node scripts/cleanup-test-data.mjs --yes     # 真删
 *   node scripts/cleanup-test-data.mjs --yes --keep 33,41   # 额外保留这几个老师 id
 *   node scripts/cleanup-test-data.mjs --yes --roster        # 连真实园所里还没认领的名单一起删
 *   node scripts/cleanup-test-data.mjs --yes --codes         # 连未使用的码一起删（连真码）
 *   node scripts/cleanup-test-data.mjs --yes --orphan-images # 连磁盘上无主的图片文件一起删
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
 * 不动：真实园所、admin 账号、app_settings、ai_models（021 之前叫 image_models）。
 *
 * 🔴 **`model_calls` 一行都不删**（2026-08-21 定）。它是平台自己那本账的支出侧，
 * 而回归脚本真的调过 DeepSeek、真的花了钱 —— 那笔钱花掉了，删掉它等于把账做平。
 * 它也不碍事：后台从来不逐条列 model_calls，只 SUM（`services/costLedger.js`），
 * 所以留着不影响「看清管理端」这件事。
 *
 * 🔴 **预览是「真跑一遍再回滚」，不是另写一套估算。**
 * 整个清理跑在一个事务里，没有 --yes 就 ROLLBACK。这样预览打印的数字
 * 就是实删的数字 —— 两套逻辑各写一份的下场是它们迟早分叉，
 * 而分叉的表现是「预览说删 3 个，实际删了 300 个」，事后才发现。
 * 副作用：真删也是原子的，中途报错不会留下删一半的库。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { query, withTransaction, closePool } from '../src/db/pool.js';
import { config } from '../src/config.js';

/**
 * 预览模式用它把事务顶掉。
 * 必须**声明在用它之前** —— 底下那段 withTransaction 是顶层 await，
 * 在文件读到末尾之前就跑完了；把类写在后面，`instanceof` 比的是
 * 那时还没赋值的 prototype，永远是 false，于是预览会变成「抛错退出」。
 */
class PreviewDone extends Error {
  constructor(payload) { super('preview'); this.payload = payload; }
}

/** 开发者自己在用的那个账号 —— 删了下次进小程序就成新账号了 */
const KEEP_OPENIDS = ['dev_zdnk6t6k'];

/**
 * 不动的 openid 前缀。
 *
 * `dev_demo_` 是 `seed-demo.mjs` 造的**演示数据** —— 用户特意要的、
 * 要留在库里看管理后台效果的。它虽然也是 dev_ 开头（走的 DEV_FAKE_LOGIN），
 * 但被这个脚本顺手抹掉会很莫名：跑一次回归，后台就又空了。
 * 要清演示数据跑 `node scripts/seed-demo.mjs --clear`。
 */
const KEEP_PREFIXES = ['dev_demo_'];

/**
 * 回归脚本自建的园所名。
 *
 * 每个脚本都不许动真实园所（admin-test 那一版曾经改坏了「童心幼儿园」的备注），
 * 所以它们各自建一个带时间戳的园 —— 于是跑十轮攒十个。
 *
 * 判定靠**脚本的命名规律**（`xxx_12345678`，尾巴是 8 位以上的时间戳），不猜。
 * 真实园所不会叫这个名字。
 *
 * ⚠️ **加了新脚本要往这个表里加一行。** 漏了的下场不是报错，是那个园
 * 悄悄留在库里 —— 2026-08-21 就漏了两个（`解读试跑园`、`对齐预览园`），
 * 因为它们是后加的脚本/手工试跑造的，而这张表没跟上。
 * 宁可漏删（留下垃圾，看得见）也不要用模糊规则（可能删掉真园，看不见）。
 */
const JUNK_KG_NAMES = [
  '回归测试园', '改过名', '任务园.*', '后台回归园', '契约测试园',
  '换绑回归园', '激活回归园', '版本回归园', '运营回归园', '冒烟园',
  '模式回归园', '解读试跑园', '对齐预览园', '预览园',
  // import-test 自己会清掉它造的园，这一行是它跑到一半挂掉时的兜底
  '导入回归',
];
const JUNK_KG_RE = `^(${JUNK_KG_NAMES.join('|')})_[0-9]{6,}$`;

const DO_IT = process.argv.includes('--yes');
const keepArg = process.argv[process.argv.indexOf('--keep') + 1];
const KEEP_IDS = process.argv.includes('--keep') && keepArg
  ? keepArg.split(',').map((x) => Number(x.trim())).filter(Boolean)
  : [];
const ALSO_ROSTER = process.argv.includes('--roster');
const ALSO_CODES = process.argv.includes('--codes');
const ALSO_ORPHAN_IMAGES = process.argv.includes('--orphan-images');

const L = console.log;
/** 把 DELETE ... RETURNING 的行数打出来，顺带收集样本给预览看 */
const report = [];
const note = (what, n, sample) => { if (n) report.push({ what, n, sample }); };

// 图片文件不能在事务里删（文件系统回滚不了）。先收 key，等 COMMIT 成功之后再动磁盘。
let imageKeys = [];

const done = await withTransaction(async (c) => {
  const q = (sql, params) => c.query(sql, params);

  // ── 1. 谁是假账号 ────────────────────────────────────────────────
  // 演示数据（dev_demo_）不算假账号，见 KEEP_PREFIXES 上面那段
  const keepLike = KEEP_PREFIXES.map((x) => `${x}%`);
  const victims = (await q(
    // 没有 t.phone —— 016 迁移把那一列删了
    `SELECT t.id, t.openid, t.real_name,
            (SELECT COUNT(*) FROM conversations x WHERE x.teacher_id = t.id)::int AS convs,
            (SELECT COUNT(*) FROM lesson_plans  x WHERE x.teacher_id = t.id)::int AS plans
       FROM teachers t
      WHERE t.openid LIKE 'dev\\_%'
        AND NOT (t.openid = ANY($1::text[]))
        AND NOT (t.id = ANY($2::bigint[]))
        AND NOT (t.openid LIKE ANY($3::text[]))
      ORDER BY t.id`,
    [KEEP_OPENIDS, KEEP_IDS, keepLike]
  )).rows;
  const ids = victims.map((v) => v.id);

  const kept = (await q(
    `SELECT id, openid, real_name FROM teachers
      WHERE openid = ANY($1::text[]) OR id = ANY($2::bigint[])
         OR openid NOT LIKE 'dev\\_%' OR openid LIKE ANY($3::text[])
      ORDER BY id`,
    [KEEP_OPENIDS, KEEP_IDS, keepLike]
  )).rows;

  // 图片 key 要在删行之前取出来 —— 行没了就找不到磁盘上那些文件了
  imageKeys = (await q(
    `SELECT i.object_key FROM lesson_images i
       JOIN lesson_plans p ON p.id = i.lesson_plan_id
      WHERE p.teacher_id = ANY($1::bigint[]) AND i.object_key <> ''`,
    [ids]
  )).rows.map((r) => r.object_key);

  // ── 2. 哪些园是脚本建的 ──────────────────────────────────────────
  // 先取 id：园所一删，teacher_roster.kindergarten_id 会被 ON DELETE SET NULL 清空，
  // 那之后就再也认不出「这行名单本来属于哪个园」了。
  const junkKgIds = (await q(`SELECT id FROM kindergartens WHERE name ~ $1`, [JUNK_KG_RE]))
    .rows.map((r) => r.id);

  // ── 3. 名单 ─────────────────────────────────────────────────────
  /**
   * 一行名单是「某个园里的一个岗位」。园是脚本建的，那这个岗位也是。
   * 这条比按姓名认可靠得多 —— activation-test 造的「甲小美」「乙红」压根不带时间戳，
   * 按姓名规律永远抓不到它们。
   *
   * `kindergarten_id IS NULL` 一起收：那是**上一轮清理留下的孤儿**
   * （园删了，SET NULL 把它变成一行无主的名单），不是真名单。
   * 真名单一定挂在某个园上 —— 它是园长给的一份岗位清单。
   */
  const r1 = await q(
    `DELETE FROM teacher_roster
      WHERE kindergarten_id = ANY($1::bigint[]) OR kindergarten_id IS NULL
      RETURNING id`,
    [junkKgIds]
  );
  note('脚本建的园里的名单（含上一轮清理留下的无主行）', r1.rowCount);

  // ── 4. 假账号本体 ───────────────────────────────────────────────
  // conversations / lesson_plans / lesson_images / lesson_plan_versions /
  // messages / memories / quota_grants / feedback / task_reads / account_rebinds
  // 全部按外键 ON DELETE CASCADE 跟着走。
  // model_calls 是 SET NULL —— 有意的，见文件头那条。
  await q(`DELETE FROM teachers WHERE id = ANY($1::bigint[])`, [ids]);
  note('假账号', ids.length);

  // ── 5. 兑换码 ───────────────────────────────────────────────────
  // 只删**真正的孤儿**：主人被删之后，外键 ON DELETE SET NULL 把它们变成
  // 「已使用但没有使用者」。**不能写成 used_by IS NULL** —— 未使用的码 used_by 本来就是空，
  // 那样会把刚发出去还没人兑的真码一起删掉。
  const c1 = await q(`DELETE FROM redemption_codes WHERE status = 'used' AND used_by IS NULL RETURNING id`);
  note('已兑但使用者已被删的码', c1.rowCount);

  // 未兑的码删不删，看有没有硬证据。有的：`grant_reason` 里带「回归」——
  // 那两个字只有测试脚本会写，老师看不到这个字段，运营也不会这么填。
  const c2 = await q(
    `DELETE FROM redemption_codes WHERE status = 'unused' AND grant_reason LIKE '%回归%' RETURNING id`
  );
  note('未兑、发放理由写着「回归」的码', c2.rowCount);

  /**
   * 空批次（019 迁移之后）。
   *
   * 兑换码列表是**按批次**列的，所以一批的码被上面几条删干净之后，
   * 那一行会留在界面上显示成「批量建 20 个 · 0 / 0 已用」—— 一条指向空气的操作记录。
   *
   * 判据是硬的：**一个码都不剩**。正常途径删批次（`POST /codes/batches/delete`）
   * 会把批次行一起删掉，所以「有批次、没有码」只可能是这个清理脚本造成的。
   */
  const b1 = await q(
    `DELETE FROM code_batches b
      WHERE NOT EXISTS (SELECT 1 FROM redemption_codes c WHERE c.batch_id = b.id)
      RETURNING id`
  );
  note('码已经被删干净、只剩空壳的建码操作', b1.rowCount);

  // 剩下的未兑码要单独确认才删（--codes）：它们可能是刚发给老师、还没兑的真码。
  // ⚠️ 匿名码的 kindergarten_id 本来就是空（见 CLAUDE.md），所以**不能**
  // 拿「没挂园所」当垃圾判据 —— 那会把整批准备灌进问卷星的真码删掉。
  if (ALSO_CODES) {
    const c3 = await q(`DELETE FROM redemption_codes WHERE status = 'unused' RETURNING id`);
    note('其余未兑的码（--codes）', c3.rowCount);
  }

  // ── 6. 管理员 ───────────────────────────────────────────────────
  // 回归脚本每跑一次就建一个同事账号和一个第二超管，攒了十几个。
  // 只留 admin 和真正给人用的 —— 按「测试脚本的命名规律」删，不猜
  const a1 = await q(`DELETE FROM admins WHERE username ~ '^(colleague|sup2)_[0-9]+$' RETURNING id`);
  note('回归脚本建的管理员', a1.rowCount);

  // ── 7. 园所 ─────────────────────────────────────────────────────
  // 外键是 ON DELETE SET NULL，删了不会连累老师、码和名单
  const k1 = await q(`DELETE FROM kindergartens WHERE id = ANY($1::bigint[]) RETURNING name`, [junkKgIds]);
  note('回归脚本自建的园', k1.rowCount, k1.rows.slice(0, 3).map((r) => r.name).join('、'));

  // ── 8. 任务 ─────────────────────────────────────────────────────
  // 也是脚本造的（标题里带同一个时间戳）。task_reads 跟着 CASCADE 走
  const t1 = await q(
    `DELETE FROM tasks WHERE title ~ ' [0-9]{6,}$' OR title ~ '^(草稿|过期发布|坏链接) ' RETURNING id`
  );
  note('回归脚本造的任务', t1.rowCount);

  // ── 9. 平台充值 ─────────────────────────────────────────────────
  /**
   * `ops-test.mjs` 每跑一次录一笔 +12.34 再录一笔 −12.34 冲平。
   * 净额是零，所以「我的钱」那个数字一直是对的 —— 但**平台账那一页是逐条列的**
   * （`costLedger.js` 的 listTopups），于是三笔真充值被四十条回归流水埋掉了。
   *
   * 判据是 note 里那句脚本写死的话，不是金额（1234 这个数真人也可能录）。
   */
  const p1 = await q(
    `DELETE FROM platform_topups WHERE note ~ '^回归(冲账)? [0-9]{6,}$' RETURNING id`
  );
  note('回归脚本录的充值流水（正负成对、净额为零）', p1.rowCount);

  // ── 10. 名单里的孤儿认领 ────────────────────────────────────────
  /**
   * 删掉假账号之后，teacher_roster.claimed_by 被外键 ON DELETE SET NULL 清空，
   * 但 status 还是 'claimed' —— 于是那个位置**永远占着**，
   * 再也没法激活，而且看不出为什么。这不是「测试数据」，是清理动作造成的不一致。
   *
   * 判定依据是**硬证据**：已认领，但认领人不存在了。不猜姓名。
   * 放回 pending 而不是删掉那一行：名单本身可能是真的（园长给的），
   * 丢掉它等于让那位老师从名单里消失。
   *
   * 走到这一步时脚本建的名单已经在第 3 步删干净了，所以这里通常是 0 行 ——
   * 但它得留着：真实园所里的老师被 --keep 漏掉时，靠的就是这一条。
   */
  const o1 = await q(
    `UPDATE teacher_roster SET status = 'pending', claimed_by = NULL,
            claimed_openid = NULL, claimed_at = NULL
      WHERE status = 'claimed' AND claimed_by IS NULL
      RETURNING id`
  );
  note('认领人已不在、放回「等她来激活」的名单行', o1.rowCount);

  // 真实园所里还没被认领的名单要单独确认才删（--roster）：
  // 它们可能是刚从园长那儿录进来的真名单。
  if (ALSO_ROSTER) {
    const r2 = await q(`DELETE FROM teacher_roster WHERE status = 'pending' RETURNING id`);
    note('真实园所里还没认领的名单（--roster）', r2.rowCount);
  }

  // ── 11. 操作记录 ────────────────────────────────────────────────
  /**
   * 1488 条里 98% 是回归脚本跑出来的，操作记录那一页翻不到底。
   * 但它是审计流水，不能凭「看着像测试」删 —— 判据必须是硬的。
   *
   * 🔴 **`target` 只有一部分 action 是引用。** `create_codes_batch` 的
   * `codes:3` 意思是「建了 3 个码」，`import_roster` 的 `roster:2` 意思是
   * 「导入了 2 行」—— 那个数字是**条数，不是 id**。照 id 去查会得到
   * 一个纯靠巧合对上或对不上的答案，而两种答案看起来都很合理。
   * 所以下面按 action 分开写，谁是引用谁是计数逐条列明。
   */
  await q(`CREATE TEMP TABLE junk_logs (id bigint PRIMARY KEY, created_at timestamptz) ON COMMIT DROP`);

  // (a) 引用型 target：那一行已经不在了 → 这条日志的对象就是刚删掉的假数据
  await q(`
    INSERT INTO junk_logs (id, created_at)
    SELECT l.id, l.created_at FROM admin_logs l
     WHERE l.target ~ '^[a-z_]+:[0-9]+$' AND (
        (l.action = 'add_topup'
         AND NOT EXISTS (SELECT 1 FROM platform_topups x WHERE x.id = split_part(l.target, ':', 2)::bigint))
     OR (l.action IN ('create_task', 'publish_task', 'close_task', 'update_task')
         AND NOT EXISTS (SELECT 1 FROM tasks x WHERE x.id = split_part(l.target, ':', 2)::bigint))
     OR (l.action IN ('create_kindergarten', 'update_kindergarten')
         AND NOT EXISTS (SELECT 1 FROM kindergartens x WHERE x.id = split_part(l.target, ':', 2)::bigint))
     OR (l.action IN ('grant_quota', 'teacher_status', 'create_rebind_code', 'void_rebind_code')
         AND NOT EXISTS (SELECT 1 FROM teachers x WHERE x.id = split_part(l.target, ':', 2)::bigint))
     OR (l.action IN ('void_roster', 'reassign_roster')
         AND NOT EXISTS (SELECT 1 FROM teacher_roster x WHERE x.id = split_part(l.target, ':', 2)::bigint))
     )`);

  // (b) 字符串引用：code:STEM-XXXX-XXXX 和 admin:username
  await q(`
    INSERT INTO junk_logs (id, created_at)
    SELECT l.id, l.created_at FROM admin_logs l
     WHERE l.id NOT IN (SELECT id FROM junk_logs) AND (
        (l.action = 'create_code' AND l.target LIKE 'code:%'
         AND NOT EXISTS (SELECT 1 FROM redemption_codes x WHERE x.code = substring(l.target FROM 6)))
     OR (l.action IN ('create_admin', 'admin_status') AND l.target LIKE 'admin:%'
         AND NOT EXISTS (SELECT 1 FROM admins x WHERE x.username = substring(l.target FROM 7)))
     )`);

  // (c) import_roster：target 是条数，但 detail 里记了 kindergarten_id，那个能追
  await q(`
    INSERT INTO junk_logs (id, created_at)
    SELECT l.id, l.created_at FROM admin_logs l
     WHERE l.id NOT IN (SELECT id FROM junk_logs)
       AND l.action = 'import_roster'
       AND l.detail->>'kindergarten_id' ~ '^[0-9]+$'
       AND NOT EXISTS (
             SELECT 1 FROM kindergartens x WHERE x.id = (l.detail->>'kindergarten_id')::bigint)`);

  /**
   * (d) 剩下的追不到对象：`create_codes_batch`、`export_codes`、`change_own_password`
   * —— target 是条数或干脆是空，detail 里也没有可追的键；
   * 外加 `import_roster` 里 **`kindergarten_id` 为 null** 的那些。
   *
   * ⚠️ 「没挂园所」本身**不是**垃圾的硬证据：`POST /roster/import` 的
   * `kindergarten_id` 是可空的（见那个 handler），所以真人也能导出一份不挂园的名单。
   * 只是那样导进来的行在激活流程里选不到（她走的是园所 → 班级 → 岗位），
   * 实际只有 activation-test / rebind-test 会这么干。既然是推断不是证据，
   * 就走下面这条间接规则，而不是直接删。
   * 反过来，detail 里记着**还存在的**园所（kg:2）的那几条不进这一条 —— 它们是真历史。
   *
   * 判据换成**时间**：回归脚本是成串跑的，一次运行十几个动作，间隔在毫秒级；
   * 而他在浏览器里手点，两次操作之间至少隔几秒。所以「紧贴着一条已确认是垃圾的
   * 日志」就是同一次脚本运行里的。10 秒这个窗口是保守值 —— 宁可漏删几条。
   *
   * ⚠️ 这是全脚本里唯一一条**不是直接硬证据**的规则（用的是「同批次」的间接证据）。
   * 它只用在这几种 action 上，删错了也只是少一条「导出过一次码」的记录。
   * 别把它推广到别的 action 上。
   */
  await q(`
    INSERT INTO junk_logs (id, created_at)
    SELECT l.id, l.created_at FROM admin_logs l
     WHERE l.id NOT IN (SELECT id FROM junk_logs)
       AND (l.action IN ('create_codes_batch', 'export_codes', 'change_own_password')
            OR (l.action = 'import_roster' AND l.detail->>'kindergarten_id' IS NULL))
       AND EXISTS (
             SELECT 1 FROM junk_logs j
              WHERE abs(extract(epoch FROM (j.created_at - l.created_at))) <= 10)`);

  // image_model / model 那几条（建模型、改模型、设为默认、试跑）不在上面任何规则里，
  // 所以自动留下 —— 它们是**真的配置历史**。`image_model:minimax` 现在查不到那一行，
  // 但那是「后来把它撤了」，不是测试数据，按引用规则删掉就把真历史删了。
  // 🔴 唯一例外：admin-test 建的回归模型统一 `regr_` 前缀，它们的日志是垃圾 ——
  //    不清的话每跑一轮回归，「模型管理」的操作记录里就多一批 model:regr_xxx
  await q(`
    INSERT INTO junk_logs (id, created_at)
    SELECT l.id, l.created_at FROM admin_logs l
     WHERE l.id NOT IN (SELECT id FROM junk_logs)
       AND l.action IN ('create_model', 'update_model', 'delete_model', 'test_model', 'set_default_model')
       AND l.target LIKE 'model:regr\\_%'`);
  const g1 = await q(`DELETE FROM admin_logs WHERE id IN (SELECT id FROM junk_logs) RETURNING id`);
  note('回归脚本跑出来的操作记录', g1.rowCount);

  // ── 7.5 回归模型 ─────────────────────────────────────────────────
  // admin-test 建的模型（regr_ 前缀）自己会删，这一条是它跑到一半挂掉时的兜底 ——
  // 一行残留的 regr_ 文本模型会一直躺在「模型管理」的文本列表里，看起来像真的。
  // 「不动 ai_models」指的是真实配置；regr_ 前缀是脚本专用命名，判据是硬的。
  const g2 = await q(`DELETE FROM ai_models WHERE key LIKE 'regr\\_%' RETURNING key`);
  note('回归脚本残留的模型', g2.rowCount);

  // ── 收尾统计 ────────────────────────────────────────────────────
  const after = {};
  for (const t of ['teachers', 'kindergartens', 'admins', 'teacher_roster', 'redemption_codes',
    'tasks', 'platform_topups', 'admin_logs', 'feedback', 'conversations', 'lesson_plans',
    'model_calls', 'quota_grants']) {
    after[t] = (await q(`SELECT COUNT(*)::int n FROM "${t}"`)).rows[0].n;
  }

  if (!DO_IT) {
    // 预览：真跑完了，现在整段扔掉。上面那些数字就是实删会发生的事。
    throw new PreviewDone({ victims, kept, after });
  }
  return { victims, kept, after };
}).catch((err) => {
  if (err instanceof PreviewDone) return err.payload;
  throw err;
});

// ── 打印 ──────────────────────────────────────────────────────────
const { victims, kept, after } = done;

L(`\n${DO_IT ? '已删除' : '将要删除'} ${victims.length} 个假账号（openid 以 dev_ 开头）：`);
for (const v of victims.slice(0, 8)) {
  L(`  #${v.id} ${v.openid.padEnd(24)} ${(v.real_name || '(无名)').padEnd(12)} 会话 ${v.convs} 教案 ${v.plans}`);
}
if (victims.length > 8) L(`  …另外 ${victims.length - 8} 个`);

L(`\n保留 ${kept.length} 个账号：`);
for (const k of kept) L(`  #${k.id} ${String(k.openid).slice(0, 24).padEnd(24)} ${k.real_name || '(无名)'}`);

L(`\n顺带清掉：`);
for (const r of report) L(`  ${String(r.n).padStart(5)} 条  ${r.what}${r.sample ? `  例：${r.sample}…` : ''}`);

L(`\n清完之后各表剩下：`);
for (const [t, n] of Object.entries(after)) L(`  ${String(n).padStart(5)}  ${t}`);

if (!DO_IT) {
  L('\n这是**预览**（整段跑完已回滚，库里什么都没动）。确认无误后加 --yes 再跑一次。\n');
  await closePool();
  process.exit(0);
}

// 事务提交了才动磁盘 —— 文件删了回滚不回来
let removed = 0;
for (const key of imageKeys) {
  try {
    await fs.unlink(path.join(config.localImageDir, key));
    removed += 1;
  } catch { /* 已经不在就算了 */ }
}
L(`\n删完了：${victims.length} 个账号、${removed} 个图片文件。`);

/**
 * 磁盘上无主的图片：`.local-images/` 里存在，但 `lesson_images` 里没有一行指着它。
 *
 * 来路是历次清理和配图实验 —— 早先的清理只删库里的行，没扫磁盘；
 * 而 `versions-test` 造的图行 `object_key` 是空的，所以「删了 12 行图、0 个文件」
 * 是对的，不是漏删。
 *
 * 🔴 **这跟「任何地方不许按版本清理图片」那条红线不冲突。**
 * 那条禁的是「教案改稿/回退了，就把图当过期的删掉」—— 图挂在
 * `lesson_plan_id` 上，跟版本号无关，按版本清就会删掉老师还要用的图。
 * 这里的判据是**一行都没有指着它**，也就是那份教案连账号都不在了。
 *
 * 默认不做，要 `--orphan-images`：这些是真调模型生成的图，真花过钱，
 * 而且删了没法免费再来一张。它也不影响管理端好不好看 —— 纯粹是省磁盘。
 */
{
  const keep = new Set(
    (await query(`SELECT object_key FROM lesson_images WHERE object_key <> ''`))
      .rows.map((r) => r.object_key.replace(/\\/g, '/'))
  );
  const walk = async (d) => {
    const out = [];
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(...(e.isDirectory() ? await walk(p) : [p]));
    }
    return out;
  };
  let files = [];
  try { files = await walk(config.localImageDir); } catch { /* 目录还没建就算了 */ }
  const orphans = files.filter(
    (f) => !keep.has(path.relative(config.localImageDir, f).replace(/\\/g, '/'))
  );
  if (!orphans.length) {
    L('磁盘上没有无主的图片。');
  } else if (!ALSO_ORPHAN_IMAGES) {
    const kb = (await Promise.all(orphans.map(async (f) => (await fs.stat(f)).size)))
      .reduce((a, b) => a + b, 0) / 1024;
    L(`磁盘上还有 ${orphans.length} 个无主图片（约 ${(kb / 1024).toFixed(1)}MB），`
      + '库里没有一行指着它们。要删加 --orphan-images —— 这些图是真花钱生成的，所以默认不动。');
  } else {
    let n = 0;
    for (const f of orphans) { try { await fs.unlink(f); n += 1; } catch { /* 已经不在 */ } }
    L(`删掉 ${n} 个无主图片文件（--orphan-images）。`);
  }
}
L('');
await closePool();
