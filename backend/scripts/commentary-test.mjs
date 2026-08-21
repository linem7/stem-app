/**
 * 教案解读的收敛与边界（api-spec 第 5 节 · content_json.commentary）。
 *
 * 【为什么这个脚本必须存在】
 *
 * `normalizeCommentary` 是一道**白名单**，而白名单最危险的性质是：
 * 生效和不生效，正常输入下的输出**一模一样**。模型老老实实只返回那 9 个键时，
 * 有没有过滤都看不出区别 —— 区别只在它哪天多写了一个键的时候出现，
 * 而那一天不会有人在看日志。跟 `enforceAgeBand` 是同一类风险
 * （见 ageband-test.mjs 的文件头：一个空转的校验和一个严格的校验都报零违规）。
 *
 * 另一件要钉住的事：**renderMarkdown 永远不许输出 commentary**。
 * 老师导出 docx 是为了打印交给园里，把「为什么这样设计」印在教案上，
 * 园长看到的是一份夹着旁白的教案。这条现在只靠 renderMarkdown 里一句注释守着，
 * 而「只读已知字段」这个实现细节很容易在以后某次「顺手支持一下新字段」里破掉。
 *
 * 不调模型、不碰数据库、不用起服务，跑完不到一秒。
 *
 *   node scripts/commentary-test.mjs
 */

import { COMMENTARY_KEYS, normalizeCommentary, buildCommentaryUserPrompt } from '../src/services/learningMode.js';
import { renderMarkdown } from '../src/services/lessonGenerator.js';

let failed = 0;
const L = console.log;
const chk = (cond, msg) => {
  L(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

/* ============ 1. 白名单真的在过滤 ============ */

L('=== 1. 白名单（这一节是整个脚本的重点）===');
{
  const raw = {
    intent: '因为洗手台那个发现是真的发生过的，从真事切进去比发一盆水更省一段导入。',
    objectives: '三条已经够了，再加一条动手类的目标会跟能力那条打架。',
    // 下面这些都不在白名单里，必须一个都不留
    indicators: '《指南》那几条是照着文件对上去的，不是设计决定',
    dialogue: '这段对话是示例',
    title: '换个更好的标题',
    quality_self: { scores: 5 },
    __proto__key: 'x',
    html: '<script>alert(1)</script>',
  };
  const out = normalizeCommentary(raw, 3);

  chk(out.intent && out.objectives, '白名单里的键留下来了');
  const extras = Object.keys(out).filter((k) => !COMMENTARY_KEYS.includes(k));
  chk(extras.length === 0, `白名单外的键全部丢掉（多出来的：${extras.join('、') || '无'}）`);
  chk(out.indicators === undefined, 'indicators 没被放进来（它不是设计决定，是照文件对号）');
  chk(out.dialogue === undefined, 'dialogue 没被放进来');
  chk(out.title === undefined, 'title 没被放进来 —— 解读不许改教案本身的字段');
}

/* ============ 2. 空的一律收敛成 null，不是 {} ============ */
//
// 契约是「效率模式下这个键根本不存在」，前端判断「有没有解读」只看一个条件：
// content_json.commentary 有没有内容。存一个空对象进去，前端就得多一条
// 「有键但是空的」分支 —— 那种分支永远有一半没人测。

L('\n=== 2. 空值收敛成 null ===');
{
  const empties = [
    [null, 'null'],
    [undefined, 'undefined'],
    ['一段字符串', '字符串'],
    [123, '数字'],
    [['a'], '数组'],
    [{}, '空对象'],
    [{ intent: '   ' }, '只有空白的值'],
    [{ nope: '有内容但键不在白名单里' }, '全是白名单外的键'],
    [{ flow_stages: [] }, 'flow_stages 是空数组'],
  ];
  const wrong = empties.filter(([v]) => normalizeCommentary(v, 3) !== null).map(([, n]) => n);
  chk(wrong.length === 0, `${empties.length} 种空输入全部返回 null（没收敛的：${wrong.join('、') || '无'}）`);
}

/* ============ 3. flow_stages 必须对齐 flow 的下标 ============ */
//
// 前端是**按下标取**的（plan.vue 的 stageWhy(i)）。多出来的几条会挂到
// 不存在的环节上 —— 但页面不会报错，只是最后一条解读凭空消失或错位。

L('\n=== 3. flow_stages 与 flow 对齐 ===');
{
  const long = normalizeCommentary({ flow_stages: ['一', '二', '三', '四', '五'] }, 3);
  chk(long.flow_stages.length === 3, `比 flow 长时截到 flow 的长度（5 条 → ${long.flow_stages.length} 条）`);

  const short = normalizeCommentary({ flow_stages: ['一', '二'] }, 4);
  chk(short.flow_stages.length === 2, '比 flow 短是允许的，不补空占位');

  // 中间的空要留着占位，末尾的要截掉 —— 否则第 3 条会跑到第 2 个环节下面
  const holed = normalizeCommentary({ flow_stages: ['一', '', '三', '', ''] }, 5);
  chk(
    holed.flow_stages.length === 3 && holed.flow_stages[1] === '' && holed.flow_stages[2] === '三',
    '中间的空串留着占位（保持下标对齐），末尾的空串截掉'
  );

  const noFlow = normalizeCommentary({ flow_stages: ['一', '二'] }, 0);
  chk(noFlow === null, 'flow 是空的时候 flow_stages 一条都不留');

  const mixed = normalizeCommentary({ flow_stages: ['一', null, 42, { a: 1 }] }, 4);
  chk(
    mixed.flow_stages.length === 1 && mixed.flow_stages[0] === '一',
    '非字符串元素当空处理，不会把 "[object Object]" 显示给老师'
  );
}

/* ============ 4. 截断 ============ */

L('\n=== 4. 200 字上限，而且切在句末 ===');
//
// 半句话对老师是噪音，比没有更糟：一段停在「因为中班幼儿还难以」的解释，
// 会让她觉得这个功能是坏的。同 buildImagePrompt 那个坑（切在字母中间）。
{
  // 一句 30 字，五句 150 字，第六句会越过 200 —— 应该在第五句的句号处停下
  const sentence = '这是一句正好三十个字的解释用来测试截断行为对不对呀。';
  const out = normalizeCommentary({ intent: sentence.repeat(10) }, 1);
  chk(out.intent.length <= 200, `不超过 200 字（实际 ${out.intent.length}）`);
  chk(out.intent.endsWith('。'), `切在句号上（结尾：「…${out.intent.slice(-8)}」）`);
  chk(out.intent.length > 100, '不会为了对齐句号把整段丢掉，只剩一句');

  // 一整段一个句号都没有 —— 只能硬切，但不许留一个悬着的逗号
  const noStop = normalizeCommentary({ intent: `${'啊'.repeat(240)}，` }, 1);
  chk(noStop.intent.length <= 200, '没有句号时硬切');
  chk(!/[，、；：]$/.test(noStop.intent), '硬切也不留结尾的悬空标点');

  // flow_stages 里的每条同样要截
  const stages = normalizeCommentary({ flow_stages: [sentence.repeat(10)] }, 1);
  chk(stages.flow_stages[0].length <= 200 && stages.flow_stages[0].endsWith('。'), 'flow_stages 里的也照同一条规则截');

  chk(normalizeCommentary({ intent: '啊'.repeat(500) }, 1).intent.length > 0, '截断而不是整条丢掉');
}

/* ============ 5. renderMarkdown 一个字都不许漏出去 ============ */
//
// 这一条守的是老师的处境，不是代码洁癖：她把教案打印出来交给园里，
// 园长拿到的必须是一份教案，不是一份夹着「我当时为什么这么设计」的旁白。

/* ============ 5. 默认渲染一段解读都不许有 ============ */
//
// 🔴 **落库和导出都不带 `commentary`。**
//
// 2026-08-21 这一条来回过一次，撤回的原因值得记下来：用户说的
// 「导出的时候解读也导出」，指的是**「设计意图」（`intent`）** ——
// 那是教案正文的第一节，本来就一直在导出里。而这里说的「解读」是学习模式下
// 挂在各板块底下那行折叠的「为什么这样设计」，是给她看的旁白、不是教案内容。
// **两样东西名字太像，讨论的时候必须带上字段名。**
//
// 所以 `renderMarkdown` 的默认行为（不带）就是**唯一在用的那条路**：
// 落库进 `content_md` 是它，`POST /export` 返回的也是它。
//
// `withCommentary: true` 那个开关**留着但没有调用方** —— 哪天要导，
// 改导出路由那一行就行，不用重做渲染。所以 5b 那一节还在测它，
// 但它测的是「备用开关能用」，不是「线上行为」。

L('\n=== 5. 默认（落库 + 导出）都不带解读 ===');
{
  const MARK = 'ZHEJUHUABUXUCHUXIANZAIMARKDOWNLI';
  const plan = {
    title: '沉与浮',
    age_group: '中班',
    duration_min: 30,
    content_json: {
      title: '沉与浮',
      intent: '洗手时有孩子发现香皂盒漂着。',
      objectives: [{ dimension: '认知', text: '知道有的东西会浮' }],
      key_points: { focus: '发现浮沉跟材料有关', difficulty: '说清为什么这样猜' },
      preparation: { experience: ['玩过水'], material: ['透明水盆 4 个'] },
      flow: [{ stage: '导入', minutes: 5, detail: '端出水盆' }],
      extension: '放进科学区角',
      safety: ['水不过手腕'],
      steam: { S: '浮沉现象', T: '勾选表', E: '本次未涉及', A: '给盆贴标记', M: '数一数几样浮' },
      indicators: ['科学探究 · 亲近自然'],
      dialogue: [{ speaker: 'T', text: '你猜它会浮吗？' }],
      // 九个键**全部**塞上同一个标记串，漏任何一个都会被抓到
      commentary: Object.fromEntries([
        ...COMMENTARY_KEYS.filter((k) => k !== 'flow_stages').map((k) => [k, `${MARK}_${k}`]),
        ['flow_stages', [`${MARK}_stage0`]],
      ]),
    },
  };

  // ---- 5a. 默认（落库 + 导出走的都是这条）----
  const md = renderMarkdown(plan);
  chk(!md.includes(MARK), `默认渲染一段解读都没有（${COMMENTARY_KEYS.length} 个键全试过）`);
  chk(md.includes('洗手时有孩子发现香皂盒漂着'), '正文照常输出（证明不是整份都空的）');
  chk(md.includes('## 活动过程') && md.includes('导入'), '活动过程照常输出');

  // 有没有解读，落库那一份都该一模一样 —— 否则同一份教案会因为模式不同存出两种正文
  const bare = structuredClone(plan);
  delete bare.content_json.commentary;
  chk(renderMarkdown(bare) === md, '有解读和没解读，渲染出的 md 完全相同');

  // ---- 5b. 备用开关（withCommentary: true）—— 现在**没有调用方** ----
  // 留着是因为「哪天要导」只需改导出路由一行。测它是为了那一行改下去就能用。
  const exp = renderMarkdown(plan, { withCommentary: true });

  // 九个键**一个都不许漏**。逐个查，不是查「包含 MARK」——
  // 后者只要有一段漏出来就绿了，而漏掉的恰恰是没人注意的那几个
  const missing = COMMENTARY_KEYS.filter((k) =>
    k === 'flow_stages' ? !exp.includes(`${MARK}_stage0`) : !exp.includes(`${MARK}_${k}`)
  );
  chk(missing.length === 0, `开关打开时带上全部 ${COMMENTARY_KEYS.length} 段解读${missing.length ? '（漏了：' + missing.join('、') + '）' : ''}`);

  chk(exp.includes('为什么这样设计'), '每段解读带抬头，跟界面上那一行对得上');
  chk(
    exp.includes('为什么这个环节这么安排'),
    '逐环节那几条换了抬头 —— 导出成文档之后卡片没了，' +
      '最后一个环节的解读会紧挨着「整组为什么是这个顺序」，抬头一样就分不出哪条讲整体'
  );
  chk(
    exp.split('\n').filter((l) => l.includes(MARK)).every((l) => l.startsWith('> ')),
    '解读排成引用块 —— 她可能直接把导出的东西交上去，混在正文里会被当成她自己写的话'
  );
  chk(exp.length > md.length, `开着的那份更长（${md.length} → ${exp.length} 字符）`);

  // 效率模式的教案没有 commentary，两条路渲染出的东西必须完全一样
  chk(
    renderMarkdown(bare, { withCommentary: true }) === renderMarkdown(bare),
    '没有解读的教案，开不开这个开关渲染结果都相同（效率模式的教案就是这样）'
  );

  // 换行不许把引用块断开 —— markdown 里 "> 第一行\n第二行" 会把第二行也吃进引用，
  // 但 docx 那边是逐段建 Paragraph 的，多出来的换行会变成一个空段落
  const nl = renderMarkdown(
    { ...plan, content_json: { ...plan.content_json, commentary: { intent: '第一句。\n\n第二句。' } } },
    { withCommentary: true }
  );
  chk(
    nl.includes('第一句。 第二句。'),
    '解读里的换行被压成空格（一段解读永远只占一行）'
  );
}

/* ============ 6. 提示词里那三条硬要求不许被删掉 ============ */
//
// 解读最可能的失败不是写不出来，是**写出套话**（「符合幼儿的年龄特点」）。
// 挡住套话的全部力量就在提示词那三条要求上，而提示词是最容易被人
// 「顺手精简一下」的东西。这一节钉住它们还在。

L('\n=== 6. 提示词的三条防套话要求 ===');
{
  const p = buildCommentaryUserPrompt(
    { flow: [{ stage: '导入' }, { stage: '展开' }], title: 'x' },
    '小班'
  );
  chk(p.includes('对比'), '① 要求给出「为什么不选另一种做法」的对比');
  chk(p.includes('不许复述'), '② 禁止复述教案正文');
  chk(p.includes('不要写那个键'), '③ 答不上来就不写，允许缺键（宁可缺一条不要凑一条）');
  chk(p.includes('小班'), '年龄班带进了提示词');
  chk(p.includes('2 个环节'), 'flow 的环节数带进了提示词（模型才知道 flow_stages 要写几条）');
  chk(p.includes('废话'), '明确点名「废话」这种失败，不是只给正面要求');
}

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`);
process.exit(failed === 0 ? 0 : 1);
