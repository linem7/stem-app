/**
 * 老师说的话有没有到模型 —— 这条链路的反向测试。
 *
 * 为什么这个脚本必须存在（2026-08-24 查出来的两条断路）：
 *
 * 1. `loadQaHistory` 按**相邻位置**配对，而题目是一次性连发 4 条 assistant 消息的，
 *    答案全排在后面。于是 4 组问答塌成 1 组，而且那 1 组是**错配**的 ——
 *    库里会话 376 存的提示词原文是「问：班上有什么情况要我考虑？ 答：户外操场」。
 *    丢信息模型会自己补，读到一条错配的事实它会照着写。
 * 2. `buildCollectedBlock` 的 labels 表里没有 `venue`，所以「场地」这道题
 *    从落库那天起就没人读过。
 *
 * 两条都活了七天，期间 11 个后端回归全绿 —— 因为教案照样生成、HTTP 照样 200、
 * 日志里一行异常都没有。**这正是「生效和不生效在正常输入下输出一模一样」那一类。**
 *
 * 顺带钉住同一天补的四条硬校验和一条假阳性修复：它们同样有「加了等于没加」的风险。
 *
 * 不调模型、不碰数据库、不花钱。改 loadQaHistory / buildCollectedBlock /
 * enforceAgeBand / guide 的示例句之后必跑。
 *
 *   node scripts/context-test.mjs
 */

import { pairQa } from '../src/routes/generate.js';
import { QUESTION_PLAN } from '../src/services/guideFlow.js';
import { enforceAgeBand, buildCollectedBlock, buildAgeBandRules } from '../src/services/promptBuilder.js';
import { buildGoalCatalog, listIndicators } from '../src/services/guide.js';

let failed = 0;
const L = console.log;
const chk = (cond, msg) => {
  L(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

const ask = (id, title) => ({ role: 'assistant', content: title, payload: { id, title } });
const say = (id, text) => ({ role: 'user', content: text, payload: { question_id: id } });

// ---------------------------------------------------------------
L('\n=== 1. 问答配对 ===');
// ---------------------------------------------------------------
{
  // 真实写入顺序：4 条题目一次性插入，答案全在后面
  const rows = [
    ask('q1', '这次活动是给哪个年龄班的？'),
    ask('q2', '你希望孩子主要收获什么？'),
    ask('q3', '打算在哪里做？'),
    ask('q4', '班上有什么情况要我考虑？'),
    say('q1', '大班'),
    say('q2', '学习测量和记录'),
    say('q3', '户外操场'),
    say('q4', '材料不够，需替代品'),
  ];
  const qa = pairQa(rows);
  chk(qa.length === 4, `4 题 4 答得到 4 组（实际 ${qa.length} 组）`);
  chk(
    qa.every((x, i) => x.question === rows[i].content && x.answer === rows[i + 4].content),
    '每一组的题面跟答案对得上（这条红过就是又按位置配对了）'
  );
}

{
  // 她不按顺序答，而且中途改了主意 —— 答题路由是「删了再插」，所以一题只留最后一条
  const rows = [
    ask('q1', '这次活动是给哪个年龄班的？'),
    ask('q2', '你希望孩子主要收获什么？'),
    say('q2', '学习测量和记录'),
    say('q1', '大班'),
  ];
  const qa = pairQa(rows);
  chk(qa.length === 2, '不按顺序答也能全部配上');
  chk(qa[0].answer === '学习测量和记录' && qa[0].question.includes('收获'), '乱序时题面仍然跟着答案走');
}

{
  /* 换年龄班会 DELETE 掉全部 assistant 题目再重插，新 id 排在已有答案之后。
     按位置配对时这一条更糟：早于重拉的答案全被丢掉。 */
  const rows = [
    ask('q1', '这次活动是给哪个年龄班的？'),
    say('q1', '大班'),
    ask('q1', '这次活动是给哪个年龄班的？'),
    ask('q3', '打算在哪里做？（重拉后的新题面）'),
    say('q3', '户外操场'),
  ];
  const qa = pairQa(rows);
  chk(qa.length === 2, '换年龄班重拉题之后，重拉前答的那题不许被丢掉');
  chk(
    qa.find((x) => x.answer === '户外操场')?.question.includes('重拉后'),
    '同一个 id 重插时取最新那道题面'
  );
}

{
  // 改稿的追问不进来：buildRevisionBlock 已经把意见和答案都带上了，收两遍是同一段话说两次
  const rows = [
    ask('q1', '这次活动是给哪个年龄班的？'),
    say('q1', '大班'),
    { role: 'user', content: '导入太长了', payload: { kind: 'revise_feedback', round: 1 } },
    { role: 'assistant', content: '导入想压到几分钟？', payload: { id: 'r1', title: '导入想压到几分钟？', kind: 'revise_question', round: 1 } },
    { role: 'user', content: '3 分钟', payload: { kind: 'revise_answer', round: 1, question_id: 'r1' } },
  ];
  const qa = pairQa(rows);
  chk(qa.length === 1 && qa[0].answer === '大班', '改稿的追问和意见不混进引导问答');
}

{
  // 老数据没有 question_id：跳过，不许退回按位置配对
  const rows = [
    ask('q1', '这次活动是给哪个年龄班的？'),
    { role: 'user', content: '大班', payload: {} },
  ];
  chk(pairQa(rows).length === 0, '老数据缺 question_id 时跳过，不退回按位置配对');
}

// ---------------------------------------------------------------
L('\n=== 2. 四道题全部进得了提示词 ===');
// ---------------------------------------------------------------
{
  /* 🔴 这一条是 venue 那个缺陷的看门狗：labels 表和 QUESTION_PLAN 是两份手抄的清单，
     加第 5 道题时必然再漏一次，而漏了不报错。 */
  const collected = {};
  for (const q of QUESTION_PLAN) collected[q.key] = `${q.key}的答案`;
  const block = buildCollectedBlock(collected);
  for (const q of QUESTION_PLAN) {
    chk(block.includes(`${q.key}的答案`), `${q.key}（${q.title}）的答案进了【老师已经回答过的】`);
  }
}

// ---------------------------------------------------------------
L('\n=== 3. 新加的硬校验必须真的会红 ===');
// ---------------------------------------------------------------
const base = () => ({
  duration_min: 30,
  intent: '孩子在户外追着自己的影子跑，就着这个好奇做一次探究。',
  objectives: [
    { dimension: '认知', text: '知道影子会随光源变化' },
    { dimension: '能力', text: '能用直尺量出影子长度并记在表格里' },
    { dimension: '情感', text: '乐于跟同伴一起观察比较' },
  ],
  key_points: { focus: '量影子', difficulty: '对齐起点' },
  preparation: { experience: ['见过自己的影子'], material: ['直尺 6 把'] },
  flow: [
    { stage: '导入', minutes: 5, detail: 'x' },
    { stage: '展开', minutes: 10, detail: 'x' },
    { stage: '再探索与改进', minutes: 10, detail: 'x' },
    { stage: '交流总结', minutes: 5, detail: 'x' },
  ],
  steam: { S: '光沿直线传播', T: '会用直尺', E: '改一改测量方法', A: '画影子轮廓', M: '比长短' },
  indicators: listIndicators('大班').slice(0, 3).map((i) => i.label),
  dialogue: [],
});
const has = (v, kw) => v.some((x) => x.includes(kw));

chk(enforceAgeBand(base(), '大班').violations.length === 0, '基线：合规大班样本 0 违规');

{
  const p = base();
  p.flow = p.flow.slice(0, 3);
  chk(has(enforceAgeBand(p, '大班').violations, '3 个环节'), '大班写成 3 环节要报（原来只查多不查少）');
}
{
  const p = base();
  p.flow[0].minutes = 99;
  chk(has(enforceAgeBand(p, '大班').violations, '对不上'), '各环节分钟之和跟总时长对不上要报');
}
{
  const p = base();
  p.indicators = [];
  chk(has(enforceAgeBand(p, '大班').violations, '只剩 0 个指标'), '一条《指南》指标都不写要报（原来整段跳过）');
}
{
  const p = base();
  p.intent = '';
  chk(has(enforceAgeBand(p, '大班').violations, '设计意图'), '设计意图空着要报');
}
{
  // 假阳性：裸一个「无」字做子串匹配，会把正常句子判成「内容为空」
  const p = base();
  p.steam.S = '木头无论大小都能浮在水面';
  p.steam.T = '学会用夹子夹取，无需老师帮忙';
  chk(!has(enforceAgeBand(p, '大班').violations, 'STEAM'), '「无论大小」「无需帮忙」不许被判成内容为空');
}
{
  const p = base();
  p.steam.E = '无';
  chk(has(enforceAgeBand(p, '大班').violations, 'STEAM 的 E'), '整句就是一个「无」仍然要报');
}

// ---------------------------------------------------------------
L('\n=== 4. 提示词里的数字和示例不许自相矛盾 ===');
// ---------------------------------------------------------------
for (const g of ['小班', '中班', '大班']) {
  const rules = buildAgeBandRules(g);
  const caps = [...rules.matchAll(/不超过 (\d+) 分钟|绝对上限 (\d+) 分钟/g)].map((m) => m[1] || m[2]);
  chk(new Set(caps).size === 1, `${g} 的时长上限只出现一个值（实际 ${JSON.stringify(caps)}）`);
  chk(g === '小班' || !rules.includes('超出小班能力'), `${g} 的自检句不再硬写「小班」`);

  // 指标格式的示例句必须在本档清单里 —— 模型最容易照抄的就是示例
  const sample = (buildGoalCatalog(g).match(/例：(.+)/) || [])[1];
  chk(
    sample && listIndicators(g).some((i) => i.label === sample),
    `${g} 的指标示例句取自本档清单`
  );
}

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`);
process.exit(failed === 0 ? 0 : 1);
