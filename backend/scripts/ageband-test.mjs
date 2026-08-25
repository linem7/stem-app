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
import { buildGoalCatalog } from '../src/services/guide.js';

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
  // 25 分钟：中班上限 2026-08-24 从 35 压到 25，样本跟着改
  duration_min: 25,
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
    { stage: '导入', minutes: 4, detail: '出示香皂盒，问孩子它为什么不下去。' },
    { stage: '展开', minutes: 10, detail: '两两一组把材料放进水里，看哪些浮哪些沉。' },
    { stage: '再探索与改进', minutes: 7, detail: '换个法子：把瓶盖翻过来再试一次。' },
    { stage: '交流总结', minutes: 4, detail: '各组说说自己看到了什么。' },
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
  // 🔴 指标必须是《指南》清单里真有的条目（2026-08-24 起 enforceAgeBand 查真伪，
  //    对不上就剔除）。原来这里写的是两句编的话，加了校验之后整节会全红
  indicators: ['科学 （一）科学探究 目标2：能对事物或现象进行观察比较，发现其相同与不同。',
    '社会 （一）人际交往 目标1：喜欢和小朋友一起游戏，有经常一起玩的小伙伴。'],
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
  indicators: ['科学 （一）科学探究 目标1：喜欢接触大自然，对周围的很多事物和现象感兴趣。'],
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
    // 上限 2026-08-24 用户定死：小班 20 / 中班 25 / 大班 30
    name: '中班时长 50 分钟（超上限 25）→ 自动纠正',
    age: '中班',
    break: (p) => { p.duration_min = 50; },
    expectFixed: /时长/,
    check: (p) => p.duration_min === 25,
    checkMsg: '并且真的被改成了 25',
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
    break: (p) => { p.indicators = [
      '科学 （一）科学探究 目标1：喜欢接触新事物，经常问一些与新事物有关的问题。',
      '科学 （一）科学探究 目标1：常常动手动脑探索物体和材料，并乐在其中。',
      '科学 （一）科学探究 目标2：能对事物或现象进行观察比较，发现其相同与不同。',
      '科学 （一）科学探究 目标2：能根据观察结果提出问题，并大胆猜测答案。',
      '科学 （一）科学探究 目标2：能通过简单的调查收集信息。',
      '科学 （一）科学探究 目标2：能用图画或其他符号进行记录。',
    ]; },
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
  // 全用清单里真有的条目 —— 只想触发「数量超标」这一类。
  // 用编的话会同时触发「不在清单里，已剔除」，那是它**真的**有两个问题，不是校验笼统
  p.indicators = [
    '科学 （一）科学探究 目标1：喜欢接触新事物，经常问一些与新事物有关的问题。',
    '科学 （一）科学探究 目标1：常常动手动脑探索物体和材料，并乐在其中。',
    '科学 （一）科学探究 目标2：能对事物或现象进行观察比较，发现其相同与不同。',
    '科学 （一）科学探究 目标2：能根据观察结果提出问题，并大胆猜测答案。',
    '科学 （一）科学探究 目标2：能通过简单的调查收集信息。',
  ];
  const { violations } = enforceAgeBand(p, '中班');
  chk(violations.length === 1, `只改坏指标数量 → 只报 1 条（实际 ${violations.length} 条）`);
}

/* ============ 4. 《指南》指标真伪校验（2026-08-24）============ */
//
// 🔴 这一节查的是「生效和不生效、正常输入下输出一模一样」那一类风险：
// 指标校验空转时，一份指标全是编的教案跟一份全对的教案，
// 违规列表都是空的 —— 区别只在模型哪天开始编，而那天没人在看日志。
//
// 抓的是实测真出现过的四种编法（详见 services/guide.js 文件头）。

L('\n=== 4. 《指南》指标只能来自清单 ===');
{
  const FAKE = [
    ['数学领域：能感知物体的厚薄，并尝试用数字进行简单的记录', '《指南》根本没有「数学领域」（数学认知是科学领域的子领域）'],
    ['科学领域：能通过观察、比较、操作，发现磁铁的特性', '把活动材料（磁铁）缝进了指标'],
    ['语言领域：能完整讲述实验的全过程并写下结论', '像那么回事，但不是原文'],
    ['社会领域：懂得分享与合作的重要意义', '同上，编得很像'],
  ];
  for (const [text, why] of FAKE) {
    const p = clone(OK_ZHONG);
    p.indicators = [text];
    const { violations } = enforceAgeBand(p, '中班');
    chk(violations.some((v) => /不在《指南》清单里/.test(v)) && p.indicators.length === 0,
      `剔除：${why}`);
  }

  // 真条目要留下，而且**格式被规范化**（原来同一个字段有五种写法）
  {
    const p = clone(OK_ZHONG);
    /* ⚠️ 这两句都要是**中班那一档**的原文。
       写小班那档的句子（「能用多种感官或动作去探索物体…」）会被正确剔除 ——
       第一版断言就是这么写错的，红的是断言不是代码。 */
    p.indicators = ['《指南》科学领域：能对事物或现象进行观察比较，发现其相同与不同。',
      '1. 常常动手动脑探索物体和材料，并乐在其中。'];
    const { violations } = enforceAgeBand(p, '中班');
    chk(!violations.some((v) => /不在《指南》清单里/.test(v)),
      '原文照抄但格式各异的两条：都认得出来，不误剔');
    chk(p.indicators.every((x) => /^\S+ （[一二三四五]）\S+ 目标\d：/.test(x)),
      `顺带统一成「领域 （X）子领域 目标N：那一句」：${p.indicators[0]}`);
  }

  // 年龄段错配也要抓到：那句是 3-4 岁的典型表现，出现在大班教案里就是错的
  {
    const p = clone(OK_ZHONG);
    p.age_group = '大班';
    p.duration_min = 30;
    p.indicators = ['科学：对感兴趣的事物能仔细观察，发现其明显特征'];
    const { violations } = enforceAgeBand(p, '大班');
    chk(violations.some((v) => /不在《指南》清单里/.test(v)),
      '年龄段错配（3-4 岁那档的表现写进大班教案）也剔除');
  }

  // 同一条目标被写两遍（一次引目标名、一次引典型表现）→ 去重成一条
  {
    const p = clone(OK_ZHONG);
    // 同一句写两遍（一次带完整位置、一次只有句子）
    p.indicators = ['科学 （一）科学探究 目标2：能对事物或现象进行观察比较，发现其相同与不同。',
      '能对事物或现象进行观察比较，发现其相同与不同。'];
    enforceAgeBand(p, '中班');
    chk(p.indicators.length === 1, `同一条写两遍 → 去重成 1 条（实际 ${p.indicators.length}）`);
  }

  // 清单本身要能按年龄班给出不同内容 —— 给错档等于给了别的年龄段的标准
  {
    const xiao = buildGoalCatalog('小班');
    const da = buildGoalCatalog('大班');
    chk(xiao.length > 1000 && da.length > 1000 && xiao !== da,
      `清单按年龄班给不同的典型表现（小班 ${xiao.length} 字 / 大班 ${da.length} 字）`);
    chk(/科学 （一）科学探究 目标1 /.test(xiao), '清单里带「领域 （X）子领域 目标N」完整位置');
  }
}

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`);
process.exit(failed === 0 ? 0 : 1);
