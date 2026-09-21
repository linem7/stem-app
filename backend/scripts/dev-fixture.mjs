/**
 * 造一套「能走完激活流程」的测试数据。
 *
 * 【为什么要这个脚本】
 * 2026-09-21 想在服务器上试真正的登录流程，发现走不通，几个原因叠在一起：
 *
 *   ① `listOpenKindergartens` / `listOpenEntries` 都只回 `status = 'pending'` 的行，
 *      而库里唯一那条名单行被 09-01 的假登录账号认领了（`claimed`）
 *   ② 库里那个未使用的码是**匿名码**（`kindergarten_id` 是 NULL），
 *      匿名码不在「从名单里选自己」这条路上
 *   ③ 四级下拉上线后，`listOpenRegions` 要求园所有 `province` / `city` ——
 *      而原有的测试园所两个都是 NULL，**第一级会直接是空的**
 *
 * 而库里现有的园所叫「契约测试园_xxxx」—— 那是 `cleanup-test-data.mjs` 的清理目标，
 * 拿它做测试等于踩在随时会被删的东西上。
 *
 * 【为什么不走后台的 xlsx 导入】
 * 那条路真实、能测到解析器，但要先建 10 个园所、而且名单模板没有「地区」这一列。
 * 这个脚本是**为了能立刻打开 /redeem 走一遍**，不是验收导入功能。
 *
 * 用法：
 *   node scripts/dev-fixture.mjs                # 造（幂等，重复跑会先清掉上次的）
 *   node scripts/dev-fixture.mjs --clean        # 清（预览，不删）
 *   node scripts/dev-fixture.mjs --clean --yes  # 清，真删
 *
 * ⚠️ 判据是**硬证据**（前缀 + id 引用），不按名字猜 —— 跟 `cleanup-test-data.mjs` 同一套取向。
 */
import 'dotenv/config';
import { queryOne, withTransaction } from '../src/db/pool.js';

/** 园所名前缀。清理和识别都靠它 */
const FIXTURE_PREFIX = '测试园所_';

/**
 * 2 个地区 × 5 个园 = 10 个园，每园 10 位老师。
 *
 * ⚠️ 地区用**真实存在的省市对**（北京 / 广东-广州 等）——
 * 因为「不在名单」那条路的地区校验是「必须出现在 kindergartens 的
 * province/city 里」，而她能选的值就是从这张表 DISTINCT 出来的。
 * 造一个不存在的地区会让那个校验永远过不去。
 */
const REGIONS = [
  { province: '北京', cities: ['北京'], prefix: '北京' },
  { province: '广东', cities: ['广州', '深圳'], prefix: '广州' },
];

/** 每园几个老师 */
const PER_KG = 10;
/** 每园几个班，用来铺开老师的班级（10 人分到 5 个班） */
const CLASSES = ['小一班', '小二班', '中一班', '中二班', '大一班'];
const POSITIONS = ['主班', '配班'];

/** 姓氏池。够 100 个人不重复即可，这里循环用 */
const SURNAMES = [
  '王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴',
  '徐', '孙', '马', '朱', '胡', '郭', '何', '高', '林', '罗',
];

/**
 * 兑换码。**必须是绑定码**（`kindergarten_id` 有值）——
 * 匿名码不在「从名单里选自己」这条路上。
 *
 * ⚠️ 2026-09-21 之后码**不再限定园所**（它只用来证明「你有资格进来」），
 * 但这里仍然绑一个园，因为「绑定码」是老师实际会拿到的那种码的形状。
 */
const CODE = 'STEM-TEST-0001';

const log = (...a) => console.log(...a);

// ---------------------------------------------------------------
// 造
// ---------------------------------------------------------------
async function build() {
  return withTransaction(async (client) => {
    // 幂等：已经造过就先清掉重来，避免名单行越跑越多
    await cleanupWithin(client, { preview: false });

    const kgs = [];
    for (const region of REGIONS) {
      for (let i = 0; i < 5; i += 1) {
        /* 每个园给一个市：北京那个直辖市只有「北京」一个市，
           广东那个在「广州」和「深圳」之间轮着分 —— 好让第二级
           真的有多个选项可点，能测到那条分支 */
        const city = region.cities[i % region.cities.length];
        const name = `${FIXTURE_PREFIX}${region.prefix}${i + 1}园`;
        const kg = (await client.query(
          `INSERT INTO kindergartens (name, province, city, ownership)
           VALUES ($1, $2, $3, $4) RETURNING id, name, province, city`,
          [name, region.province, city, i % 3 === 0 ? '公办' : (i % 3 === 1 ? '普惠民办' : '民办')]
        )).rows[0];
        kgs.push(kg);
      }
    }
    log(`  园所  ${kgs.length} 个（${REGIONS.map((r) => r.province).join(' / ')}）`);

    let ref = (await client.query(
      `SELECT COALESCE(MAX(teacher_ref), 1000) AS max FROM teacher_roster`
    )).rows[0].max;

    let n = 0;
    for (const kg of kgs) {
      for (let i = 0; i < PER_KG; i += 1) {
        ref += 1;

        /* 🔴 **班级和年级必须从同一个下标算出来。**
           分开取模（班级 `i % 5`、年级 `i % 3`）会让它们错开 ——
           结果是「小一班的老师被标成中班」，而 `age_band_violations`
           那套硬校验会拿这个值去管她的教案。错开之后界面上完全看不出来，
           只在生成教案时冒出一堆莫名其妙的年龄班违规。
           班级名的第一个字就是年级（小一班 → 小班），从它派生最不容易写错。 */
        const cls = CLASSES[i % CLASSES.length];

        await client.query(
          `INSERT INTO teacher_roster
             (teacher_ref, real_name, kindergarten_id, class_name, position,
              age_group, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
          [ref,
            /* 🔴 **姓名必须以姓氏开头。**
               `surnameOf()` 取的是第一个字，所以「测试王01」这种
               「前缀 + 姓」的写法会让**每个人都显示成「测老师」** ——
               名单上十个人全叫同一个名字，她认不出自己是谁。
               而这一屏的全部作用就是让她认出自己。
               后面缀那个数字是为了保证不重名（同姓配班要靠 note 区分，
               造数据时先避开那个复杂度）。 */
            `${SURNAMES[n % SURNAMES.length]}${String(n + 1).padStart(2, '0')}`,
            kg.id,
            cls,
            POSITIONS[i % POSITIONS.length],
            `${cls[0]}班`]
        );
        n += 1;
      }
    }
    log(`  名单  ${n} 条（每园 ${PER_KG} 条）`);

    const code = (await client.query(
      `INSERT INTO redemption_codes
         (code, kindergarten_id, init_text, init_image, grant_reason, status)
       VALUES ($1, $2, 20, 10, '首次激活', 'unused')
       RETURNING id, code, init_text, init_image`,
      [CODE, kgs[0].id])).rows[0];
    log(`  兑换码  ${code.code}  (${code.init_text} 教案 / ${code.init_image} 配图)`);

    return { kgs, code };
  });
}

// ---------------------------------------------------------------
// 清理
//
// ⚠️ 判据是**硬证据，不按名字猜**：先按前缀找到园所 id，再按「引用了这些 id」删。
//    ⚠️ `model_calls` 一行都不删：那是真花过钱的事实。
// ---------------------------------------------------------------
async function cleanupWithin(client, { preview }) {
  const kgs = (await client.query(
    `SELECT id, name FROM kindergartens WHERE name LIKE $1`, [`${FIXTURE_PREFIX}%`]
  )).rows;

  if (!kgs.length) {
    if (preview) log('  （没有要清的东西）');
    return { kgs: 0 };
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

  if (args.includes('--clean')) {
    const yes = args.includes('--yes');
    log(`\n清理测试数据${yes ? '（真删）' : '（预览）'}：\n`);
    await cleanup({ preview: !yes });
    log('');
    return;
  }

  log('\n造测试数据：\n');
  const { kgs, code } = await build();

  /* 自检：把「这份数据到底能不能走通激活」当场验一遍。
     写在脚本里而不是靠人去点 —— 漏一条要求的表现是激活页报一句
     看不懂的错，那比脚本自己红掉难查得多。

     🔴 2026-09-21 加了第 ④ 条：四级下拉要求园所有 province/city。
     这条是**真踩过的** —— 原来的测试园所两个字段都是 NULL，
     加完四级之后第一级直接是空的，而界面上只表现为「一个选项都没有」。 */
  log('\n自检（走一遍真实查询）：\n');
  const {
    listOpenRegions, listOpenCities, listOpenKindergartens, listOpenEntries,
  } = await import('../src/services/roster.js');

  const regions = await listOpenRegions();
  if (!regions.length) throw new Error('❌ 自检失败：地区列表是空的（园所缺 province/city？）');
  log(`  ✅ 地区 ${regions.length} 个：${regions.map((r) => r.province).join(' / ')}`);

  const first = regions[0];
  const cities = await listOpenCities(first.province);
  if (!cities.length) throw new Error(`❌ 自检失败：${first.province} 下面一个市都没有`);
  log(`  ✅ ${first.province} 的市：${cities.join(' / ')}`);

  const inCity = await listOpenKindergartens(first.province, cities[0]);
  if (!inCity.length) throw new Error(`❌ 自检失败：${cities[0]} 下面一个园都没有`);
  log(`  ✅ ${cities[0]} 的园 ${inCity.length} 个，第一个待认领 ${inCity[0].open} 个位置`);

  const entries = await listOpenEntries(inCity[0].id);
  if (!entries.length) throw new Error('❌ 自检失败：那个园一条待认领的位置都没有');
  log(`  ✅ 名单 ${entries.length} 条，姓氏：${entries.slice(0, 5).map((e) => e.surname).join(' ')}…`);

  const codeRow = await queryOne(
    `SELECT status, kindergarten_id FROM redemption_codes WHERE code = $1`, [code.code]);
  if (codeRow.status !== 'unused') throw new Error('❌ 自检失败：码不是 unused');
  log(`  ✅ 码 ${code.code} 未使用`);

  log(`
───────────────────────────────────────────────
现在可以走激活流程了：

  兑换码    ${code.code}
  园所      ${kgs.length} 个，分 ${REGIONS.map((r) => r.province).join(' / ')} 两地
  名单      ${kgs.length * PER_KG} 条

  手机号自己定一个 11 位数（它只是用户名，不发短信）
  密码至少 6 位

清掉这套数据：node scripts/dev-fixture.mjs --clean --yes
───────────────────────────────────────────────
`);
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
