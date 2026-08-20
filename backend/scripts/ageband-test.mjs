/**
 * 年龄班硬校验的**反向测试** —— 用故意违规的样本喂 enforceAgeBand，看它抓不抓得到。
 *
 * 为什么这个脚本必须存在：
 *
 * CLAUDE.md 里写着「硬校验用故意违规的样本反向测过，红线全抓得到」，
 * 但那次是**某个会话里手动跑的，没留下脚本**（2026-08-20 要改校验时才发现）。
 * 于是「零违规」这个结论从那天起就没人能复核了 —— 而一个空转的校验
 * 跟一个严格的校验，输出**完全一样**：都是零违规。
 *
 * 这个脚本不调模型、不碰数据库、不花钱，跑完不到一秒。改 enforceAgeBand 之后必跑。
 *
 *   node scripts/ageband-test.mjs
 */

import { enforceAgeBand } from '../src/services/promptBuilder.js';

let failed = 0;
const L = console.log;
const chk = (cond, msg) => {
  L(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

/** 深拷贝，免得各条用例互相污染 */
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * 一份**合规**的中班教案（新结构，2026-08-20 改版）。
 * 各条用例从它出发只改坏一处 —— 这样报出来的违规就一定是那一处引起的。
 */
const OK_ZHONG = {
  title: '沉与浮：谁能停在水面上',
  age_group: '中班',
  duration_min: 30,
  intent: '洗手时有孩子发现香皂盒漂着，就着这个好奇做一次探究。',
  objectives: [
    { dimension: '认知', text: '知道有的东西会浮、有的会沉' },
    { dimension: '能力', text: '能用勾选表记下自己试的结果' },
    { dimension: '情感', text: '愿意把自己的发现说给同伴听' },
  ],
  key_points: { focus: '发现浮沉跟材料有关', difficulty: '说清楚为什么这样猜' },
  preparation: {
    experience: ['玩过水，知道水会把手弄湿'],
    material: ['透明水盆 4 个', '塑料瓶盖 20 个', '小石子 20 颗'],
  },
  flow: [
    { stage: '导入', minutes: 5, detail: '出示香皂盒，问孩子它为什么不下去。' },
    { stage: '展开', minutes: 12, detail: '两两一组把材料放进水里，看哪些浮哪些沉。' },
    { stage: '再探索与改进', minutes: 8, detail: '换个法子：把瓶盖翻过来再试一次。' },
    { stage: '交流总结', minutes: 5, detail: '各组说说自己看到了什么。' },
  ],
  extension: '在水区放一盆水和一筐材料，让孩子自己接着玩。',
  safety: ['水盆放稳，地面随时擦干', '小石子清点后收回，避免遗落'],
  steam: {
    S: '科学：不同材料在水里的浮沉表现',
    T: '技术：会用勾选表做记录',
    E: '工程：把瓶盖翻面让它沉下去',
    A: '艺术：用不同颜色的贴纸区分浮和沉',
    M: '数学：比较浮起来的和沉下去的哪边多',
  },
  indicators: ['能感知常见材料的特性', '愿意与同伴交流自己的发现'],
  dialogue: [
    { speaker: 'T', text: '你猜这个会浮还是会沉？' },
    { speaker: 'C', text: '会沉，因为它硬硬的。' },
  ],
};

/** 一份合规的小班教案 —— 小班有一整套额外的禁止项，要单独有基线 */
const OK_XIAO = {
  ...clone(OK_ZHONG),
  age_group: '小班',
  duration_min: 20,
  objectives: [
    { dimension: '认知', text: '知道有的东西会浮、有的会沉' },
    { dimension: '能力', text: '能用贴纸把浮和沉分开标出来' },
    { dimension: '情感', text: '愿意跟老师说自己看到了什么' },
  ],
  flow: [
    { stage: '导入', minutes: 4, detail: '出示香皂盒，让孩子看它停在水面上。' },
    { stage: '展开', minutes: 11, detail: '每人一份材料放进水里玩，再玩一次。' },
    { stage: '结束', minutes: 5, detail: '用贴纸把浮起来的贴在笑脸那一栏。' },
  ],
  safety: ['材料尺寸都大于幼儿口腔，避免误食', '水盆放稳，地面随时擦干'],
  steam: {
    S: '科学：有的东西浮有的东西沉',
    T: '技术：会用贴纸做标记',
    E: '本次未涉及',
    A: '艺术：用贴纸的颜色区分',
    M: '数学：哪边多哪边少',
  },
  indicators: ['能感知常见材料的特性'],
};

/* ============ 1. 合规样本必须零违规 ============ */
//
// 这一节是整个脚本的地基。它红了说明校验**过严**，
// 而过严比过松更难发现 —— 表现是每份真教案都带着几条违规，
// 看久了就没人再看那个字段了。

L('=== 1. 合规样本零违规（基线）===');
for (const [name, sample] of [['中班', OK_ZHONG], ['小班', OK_XIAO]]) {
  const { violations, fixed } = enforceAgeBand(clone(sample), name);
  if (violations.length) violations.forEach((v) => L(`      · ${v}`));
  chk(violations.length === 0 && fixed.length === 0, `${name}合规样本：0 违规 0 纠正`);
}

/* ============ 2. 每条红线都要抓得到 ============ */
//
// 每个用例只改坏一处，并且断言**报出来的那条里含某个关键词** ——
// 只断言「违规数 > 0」是不够的：改坏 A 却报出 B，一样能过。

L('\n=== 2. 逐条红线 ===');

const CASES = [
  // ---- 通用 ----
  {
    name: '中班时长 50 分钟（超上限 35）→ 自动纠正',
    age: '中班',
    break: (p) => { p.duration_min = 50; },
    expectFixed: /时长/,
    check: (p) => p.duration_min === 35,
    checkMsg: '并且真的被改成了 35',
  },
  {
    name: '中班写了 6 个环节（应为 4）',
    age: '中班',
    break: (p) => { p.flow.push({ stage: '加一', minutes: 1, detail: 'x' }, { stage: '加二', minutes: 1, detail: 'y' }); },
    expect: /环节/,
  },
  {
    name: '中班写了 6 条学习指标（应为 2-3）',
    age: '中班',
    break: (p) => { p.indicators = ['a', 'b', 'c', 'd', 'e', 'f']; },
    expect: /学习指标/,
  },
  {
    name: '中班 STEAM 的 S 写了「本次未涉及」（S 是必须涉及的）',
    age: '中班',
    break: (p) => { p.steam.S = '本次未涉及'; },
    expect: /STEAM 的 S/,
  },

  // ---- 小班专属禁止项 ----
  {
    name: '小班出现量杯读数',
    age: '小班',
    break: (p) => { p.flow[1].detail = '用量杯量出 200 毫升水，读出刻度。'; },
    expect: /读数|称重/,
  },
  {
    name: '小班出现条形图',
    age: '小班',
    break: (p) => { p.flow[2].detail = '把结果画成条形图贴在墙上。'; },
    expect: /书写|统计图表/,
  },
  {
    name: '小班出现预测环节',
    age: '小班',
    break: (p) => { p.dialogue.push({ speaker: 'T', text: '先预测一下会不会浮？' }); },
    expect: /预测/,
  },
  {
    name: '小班出现小组分工',
    age: '小班',
    break: (p) => { p.flow[1].detail = '五人一组，小组分工完成记录。'; },
    expect: /小组分工/,
  },
  {
    name: '小班安全事项没写误食风险',
    age: '小班',
    break: (p) => { p.safety = ['水盆放稳，地面随时擦干']; },
    expect: /误食/,
  },

  // ---- 三维目标（2026-08-20 新增）----
  {
    name: '目标只有 2 条',
    age: '中班',
    break: (p) => { p.objectives = p.objectives.slice(0, 2); },
    expect: /3 条|维度/,
  },
  {
    name: '三条目标全是认知维度（最常犯的那一种）',
    age: '中班',
    break: (p) => {
      p.objectives = [
        { dimension: '认知', text: '知道有的东西会浮' },
        { dimension: '认知', text: '了解材料跟浮沉有关' },
        { dimension: '认知', text: '认识几种常见材料' },
      ];
    },
    expect: /缺少这些维度|不止一条/,
  },
  {
    name: '维度写成了「知识」这种不在枚举里的值',
    age: '中班',
    break: (p) => { p.objectives[0].dimension = '知识'; },
    expect: /缺少这些维度/,
  },

  // ---- 活动准备与重点难点（2026-08-20 新增）----
  {
    name: '缺经验准备',
    age: '中班',
    break: (p) => { p.preparation.experience = []; },
    expect: /经验准备/,
  },
  {
    name: '缺物质准备',
    age: '中班',
    break: (p) => { p.preparation.material = []; },
    expect: /物质准备/,
  },
  {
    name: '缺活动重点',
    age: '中班',
    break: (p) => { p.key_points.focus = ''; },
    expect: /活动重点/,
  },
  {
    name: '缺活动难点',
    age: '中班',
    break: (p) => { p.key_points.difficulty = '   '; },
    expect: /活动难点/,
  },

  // ---- 整段缺失（模型偶尔会整块少给）----
  {
    name: 'preparation 整个字段都没有',
    age: '中班',
    break: (p) => { delete p.preparation; },
    expect: /经验准备/,
  },
  {
    name: 'objectives 整个字段都没有',
    age: '中班',
    break: (p) => { delete p.objectives; },
    expect: /3 条|维度/,
  },
];

for (const t of CASES) {
  const base = t.age === '小班' ? OK_XIAO : OK_ZHONG;
  const p = clone(base);
  t.break(p);
  const { violations, fixed } = enforceAgeBand(p, t.age);
  const pool = t.expectFixed ? fixed : violations;
  const re = t.expectFixed || t.expect;
  const hit = pool.some((v) => re.test(v));
  if (!hit) {
    L(`      实际报出来的：${JSON.stringify(violations)} / 纠正：${JSON.stringify(fixed)}`);
  }
  chk(hit, t.name);
  if (t.check) chk(t.check(p), `    ${t.checkMsg}`);
}

/* ============ 3. 改坏一处不该连带报出别的 ============ */
//
// 这一条防的是「校验写得太笼统」：比如把 objectives 判断写成
// 「只要不是 3 条就把所有维度都报缺」，那样违规列表会又长又没法看，
// 老师端不显示它、但内测分析时那一栏就废了。

L('\n=== 3. 改坏一处只报一类 ===');
{
  const p = clone(OK_ZHONG);
  p.key_points.focus = '';
  const { violations } = enforceAgeBand(p, '中班');
  chk(violations.length === 1, `只改坏活动重点 → 只报 1 条（实际 ${violations.length} 条）`);
}
{
  const p = clone(OK_ZHONG);
  p.indicators = ['a', 'b', 'c', 'd', 'e'];
  const { violations } = enforceAgeBand(p, '中班');
  chk(violations.length === 1, `只改坏指标数量 → 只报 1 条（实际 ${violations.length} 条）`);
}

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`);
process.exit(failed === 0 ? 0 : 1);
