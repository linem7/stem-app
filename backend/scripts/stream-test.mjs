/**
 * 撰写过程流式显示的回归 —— **不起服务、不连库、不调模型**，跑完不到一秒。
 *
 * 为什么这一套非测不可：它整个属于「生效和不生效、正常输入下输出一模一样」那一类。
 * 增量协议算错一个游标，老师看到的是**正文里重复了一段**或者**少了一段** ——
 * HTTP 200、日志零异常、教案照样生成成功，而她只会觉得「这个软件怪怪的」，
 * 不会来报。08-24 那两条断路（venue 从没进过提示词、问答配对错位）就是这么活了七天的。
 *
 * 两块：
 *   第 1-3 节  readablePrefix：半截 JSON → 人话，**只增不减**
 *   第 4 节    streamDelta：epoch + from 游标
 *
 * 用法：node scripts/stream-test.mjs
 */
import { readablePrefix } from '../src/services/planStream.js';
import { streamDelta } from '../src/routes/generate.js';

let pass = 0;
let fail = 0;
const L = (s) => console.log(s);
const chk = (cond, msg) => {
  if (cond) { pass += 1; L(`  ✓ ${msg}`); } else { fail += 1; L(`  ✗ ${msg}`); }
};

/** 一份真实形状的教案（键的顺序跟 lessonGenerator 的 jsonShape 一致） */
const PLAN = {
  title: '浮起来沉下去',
  duration_min: 25,
  intent: '孩子们在玩水时对沉浮很好奇。\n希望他们学会先猜一猜，再动手试一试。',
  objectives: [
    { dimension: '认知', text: '知道有的东西会浮、有的会沉' },
    { dimension: '能力', text: '能把物体轻轻放进水里观察' },
  ],
  key_points: { focus: '先猜后验', difficulty: '说清为什么' },
  preparation: { experience: ['玩过水'], material: ['透明水盆 4 个', '木块 若干'] },
  flow: [{ stage: '导入', minutes: 5, detail: '出示水盆，问孩子会沉还是会浮' }],
  extension: '区角里放一盆水',
  safety: ['地面及时擦干'],
  steam: { S: '科学：沉浮现象', T: '技术：用贴纸记录' },
  indicators: ['科学 （一）科学探究 目标1：喜欢接触新事物。'],
  dialogue: [{ speaker: 'T', text: '你猜它会怎么样？' }, { speaker: 'C', text: '沉下去！' }],
};
const RAW = JSON.stringify(PLAN);

// ---------------------------------------------------------------
L('\n=== 1. 只增不减（整套增量协议就架在这一条上）===');
//
// 🔴 逐字符喂进去，每一步的输出都必须以上一步的输出开头。
// 破了这一条，前端往后拼出来的就是两段不相干的文字接在一起 —— 而且不报错。
{
  let prev = '';
  let broke = 0;
  let firstBreak = -1;
  for (let i = 1; i <= RAW.length; i += 1) {
    const cur = readablePrefix(RAW.slice(0, i));
    if (!cur.startsWith(prev)) { broke += 1; if (firstBreak < 0) firstBreak = i; }
    prev = cur;
  }
  chk(broke === 0, `逐字符喂完 ${RAW.length} 步，输出始终只增不减${broke ? `（第 ${firstBreak} 步破了，共 ${broke} 次）` : ''}`);
  chk(prev === readablePrefix(RAW), '一次喂全 = 一个字一个字喂，结果一样');

  // 结尾的空白**不许 trim**：掐掉之后下一段字一来它又长回来，拼接就多一截。
  // 这一条单独钉住，因为「顺手 trim 一下」是最容易被加回来的一行
  const cut = RAW.slice(0, RAW.indexOf('"intent"'));
  chk(/\n$/.test(readablePrefix(`${cut}"intent": "`)), '刚写到小标题时结尾留着换行（结尾绝不 trim）');
}

// ---------------------------------------------------------------
L('\n=== 2. 半截键名一个字都不发 ===');
//
// 认出它是 flow 还是 focus 之前就把字发出去，已经来不及改口了（见第 1 节）。
{
  const head = '{"title": "浮起来沉下去", ';
  chk(readablePrefix(`${head}"inte`) === readablePrefix(head), '键名收到一半时，输出跟没收到时一模一样');
  chk(readablePrefix(`${head}"intent"`).includes('设计意图'), '键名收全了才写小标题');
  chk(!readablePrefix(`${head}"intent`).includes('设计意图'), '差最后那个引号也不算收全');
}

// ---------------------------------------------------------------
L('\n=== 3. 摆给老师看的是教案，不是数据结构 ===');
{
  const out = readablePrefix(RAW);
  chk(out.startsWith('浮起来沉下去'), '标题打头，不另加小标题');
  chk(!/[{}[\]"]/.test(out), '一个花括号、方括号、引号都不剩');
  chk(!/\bflow\b|\bkey_points\b|\bdetail\b|\bdimension\b/.test(out), '字段名一个都不印（flow / key_points / detail…）');

  for (const [key, label] of [['intent', '设计意图'], ['flow', '活动过程'], ['safety', '安全提示'], ['steam', 'STEAM 五域']]) {
    chk(out.includes(label), `顶层 ${key} 写成「${label}」`);
  }

  // 🔴 speaker 的值是 'T' / 'C' —— 存库用的代号。单独占一行就是一个孤零零的大写字母。
  // 想译成「老师：」做不到：译要等值收完，而收完时那个字母已经发出去了
  chk(!/^[TC]$/m.test(out), '对话里那个 T / C 不显示（它是代号，看起来像乱码）');
  chk(out.includes('你猜它会怎么样？') && out.includes('沉下去！'), '对话说的话照样在');

  chk(!/\b25\b|\b5\b/.test(out), 'duration_min / minutes 这些数字不单独占一行');
  chk(out.includes('孩子们在玩水时对沉浮很好奇。\n希望他们'), '\\n 转义还原成真的换行');
  chk(readablePrefix('{"title": "\\u6d6e\\u6c89"}').startsWith('浮沉'), '\\uXXXX 转义认得出来');
  chk(readablePrefix('{"title": "他说\\"好\\"了"}').startsWith('他说"好"了'), '值里面的转义引号不会被当成字符串结束');

  // 模型偶尔把 JSON 包在 ```json 里（tryParseJSON 就是为这个兜的底）。
  // 那几个反引号在字符串外面，走不到输出里
  chk(readablePrefix('```json\n{"title": "浮沉"').startsWith('浮沉'), '```json 包着也认');
  chk(readablePrefix('') === '' && readablePrefix(null) === '', '空输入不炸');
}

// ---------------------------------------------------------------
L('\n=== 4. 增量协议（epoch + from）===');
//
// from 少一个字 → 每一段都错位；epoch 丢了 → 模型重打一次之后
// 前端把两份教案首尾相接拼在一起。两个字段缺一不可。
{
  const p = { phase: 'writing', text: '一二三四五', epoch: 1 };

  const d0 = streamDelta(p, { epoch: 0, from: 0 });
  chk(d0.restart === true && d0.text === '一二三四五', '第一次问（epoch=0）：回全量 + restart');
  chk(d0.len === 5, 'len 报的是后端一共写了多少字，给前端对账用');

  const d1 = streamDelta(p, { epoch: 1, from: 3 });
  chk(d1.restart === false && d1.text === '四五', '游标对得上：只回后面新长出来的那两个字');

  const d2 = streamDelta(p, { epoch: 1, from: 5 });
  chk(d2.text === '' && d2.restart === false, '一个字都没长时回空串，不是 null');

  // 🔴 模型被截断会重打一遍，正文从头再来。这时候前端必须清屏
  chk(streamDelta(p, { epoch: 0, from: 3 }).restart === true, 'epoch 对不上 → restart + 全量（重打过一次）');
  chk(streamDelta(p, { epoch: 2, from: 3 }).restart === true, 'epoch 比后端还新也算对不上');
  chk(streamDelta(p, { epoch: 1, from: 99 }).restart === true, 'from 比后端还多 → restart（前端的账坏了）');
  chk(streamDelta(p, { epoch: 1, from: -1 }).restart === true, 'from 是负数 → restart');
  chk(streamDelta(p, {}).restart === true, '不带参数 = 从头要');
  chk(streamDelta(null, { epoch: 1, from: 0 }) === null, '还没有进度时回 null，不是空对象');

  // 端到端：照前端那套拼一遍，必须跟后端手里那份**一模一样**
  let buf = '';
  let epoch = 0;
  const server = { phase: 'writing', text: '', epoch: 1 };
  for (let i = 1; i <= RAW.length; i += 7) {          // 每次长 7 个字，模拟一次轮询
    server.text = readablePrefix(RAW.slice(0, i));
    const d = streamDelta(server, { epoch, from: buf.length });
    if (d.restart) buf = d.text; else buf += d.text;
    epoch = d.epoch;
    if (buf.length !== d.len) break;                   // 对不上就停，下面那条会红
  }
  server.text = readablePrefix(RAW);
  const last = streamDelta(server, { epoch, from: buf.length });
  buf += last.text;
  chk(buf === readablePrefix(RAW), '模拟一整次轮询：前端拼出来的 = 后端手里的那一份');

  // 中途重打一次（epoch 变了）：前端必须**扔掉旧的**，不能接着拼
  const restarted = { phase: 'thinking', text: '新的开头', epoch: 2 };
  const dr = streamDelta(restarted, { epoch: 1, from: buf.length });
  chk(dr.restart === true && dr.text === '新的开头', '重打之后回的是新那份的全量');
}

// ---------------------------------------------------------------
L(`\n${fail ? '✗' : '✓'} ${pass} 条通过，${fail} 条失败`);
process.exit(fail ? 1 : 0);
