/**
 * 内容安全的**反向测试** —— 喂真会命中的样本，看它抓不抓得到。
 *
 * 🔴 为什么必须有这个脚本：
 * 一个空转的检查和严格的检查，在**正常输入下输出一模一样** —— 都是 pass。
 * 所以「跑了一遍没报错」不能证明它在工作，得喂它该拦的东西。
 * 这个项目已经踩过两次同类（CLAUDE.md「白名单和硬校验是同一类风险」）。
 *
 * 【要真 key】它打**真的阿里云接口**（会花一点钱，以阿里云账单为准）。
 * 所以不放在「改代码必跑」那四个里 —— 那四个的特点是不起服务、不花钱。
 * 没配 key 时失败退出，不能把未执行当作通过。
 *
 *   node scripts/content-safety-test.mjs
 *   # 或者显式打开开关（脚本自己会开，这里只是说明）
 *   CONTENT_CHECK_ENABLED=true node --env-file=.env scripts/content-safety-test.mjs
 *
 * ⚠️ 跑之前先 `node --env-file=.env`，或者确认 shell 里已经有那两个 key。
 */
process.env.CONTENT_CHECK_ENABLED = 'true';

let failed = 0;
const L = console.log;
const chk = (cond, msg) => {
  L(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

const { checkText, contentBlockedError } = await import('../src/services/contentSafety.js');
const { config } = await import('../src/config.js');

L(`  配置：enabled=${config.contentSafety.enabled} region=${config.contentSafety.region}`);

if (!config.contentSafety.configured) {
  L('\n  未配置 ALIBABA_CLOUD_ACCESS_KEY_ID / _SECRET，无法验证。');
  L('     要跑它：把 backend/.env 里那两个填上。');
  process.exit(1);
}

/* ---------------------------------------------------------------
   1. 正常输入 —— 必须过
   --------------------------------------------------------------- */
L('\n【该过的要过】');
let r = await checkText({ content: '我想做个浮与沉的科学活动', stage: 'teacher_input' });
chk(r.pass && r.suggest === 'pass', `老师的正常提问过（label=${r.label}）`);

r = await checkText({ content: '小朋友们把石头放进水里，观察它是沉还是浮。', stage: 'ai_output' });
chk(r.pass && r.suggest === 'pass', 'AI 输出的教案正文过（走 llm_response_moderation）');

/* 幼教里「过敏」「安全」是天天要提的词，误杀会把老师逼疯 */
r = await checkText({ content: '材料要防误食过敏源，注意孩子对花生的过敏情况', stage: 'teacher_input' });
chk(r.pass && r.suggest === 'pass', '幼教正常内容（过敏提示）不被误杀');

/* 空文本不该送审（服务端会回 content is blank，那是正常输入不是错） */
r = await checkText({ content: '   ', stage: 'profile' });
chk(r.pass && r.suggest === 'pass', '空文本直接过，不触发 content is blank');

/* ---------------------------------------------------------------
   2. 🔴 该拦的必须拦 —— 这一节是整个脚本存在的理由
   --------------------------------------------------------------- */
L('\n【该拦的要拦】');
r = await checkText({ content: '代开发票 联系微信 低价办理各种证件', stage: 'teacher_input' });
chk(!r.pass, `违禁内容被拦（label=${r.label}）`);

/* ---------------------------------------------------------------
   3. 🔴 超长 —— 分段是真的，不是截断
   --------------------------------------------------------------- */
L('\n【超长文本】');
const long = '小朋友们观察石头。'.repeat(400); // 3600 字，超过 2000 上限
chk(long.length > 2000, `样本 ${long.length} 字 > llm_query_moderation 的 2000 上限`);
r = await checkText({ content: long, stage: 'teacher_input' });
chk(r.pass && r.suggest === 'pass', `超长自动分段送审，不被服务端拒（分 ${Math.ceil(long.length / 2000)} 段）`);

/* 违规藏在第二段里 —— 证明「每段都查」，不是「只查第一段就完事」 */
const sneaky = '小朋友们观察石头。'.repeat(250) + '代开发票 办理各种证件' + '观察记录。'.repeat(200);
chk(sneaky.length > 2000, `藏了违规的样本 ${sneaky.length} 字`);
r = await checkText({ content: sneaky, stage: 'teacher_input' });
chk(!r.pass, '违规藏在 2000 字之后仍然被拦（分段是真在查）');

/* ---------------------------------------------------------------
   4. 🔴 配置错了必须拦住，不能静默放行
   --------------------------------------------------------------- */
L('\n【配置错了要拦住 —— 最难发现的一种失败】');
L('  （下面会故意用一对假 key，日志里会出一条 error，那是预期的）');
const savedId = config.contentSafety.accessKeyId;
const savedSecret = config.contentSafety.accessKeySecret;
config.contentSafety.accessKeyId = 'LTAI_fake_key_for_test';
config.contentSafety.accessKeySecret = 'fake_secret_for_test';

let threw = null;
try {
  await checkText({ content: '我想做个浮与沉的活动', stage: 'teacher_input' });
} catch (e) {
  threw = e;
}
chk(threw !== null, '假 key 会抛错，不是静默返回 pass');
chk(threw?.code === 'CONTENT_CHECK_UNAVAILABLE',
  `返回可重试的审核不可用错误（${threw?.code}）`);

// 还原
config.contentSafety.accessKeyId = savedId;
config.contentSafety.accessKeySecret = savedSecret;

/* ---------------------------------------------------------------
   5. 文案与形状
   --------------------------------------------------------------- */
L('\n【对外形状】');
const e1 = contentBlockedError('teacher_input');
chk(e1.http === 400 && e1.detail.stage === 'teacher_input', '老师输入的拦截错误：400 + stage');
const e2 = contentBlockedError('ai_output');
chk(e2.http === 400 && e2.detail.stage === 'ai_output', 'AI 输出的拦截错误：400 + stage');
chk(e1.message !== e2.message, '两种 stage 的文案不同（AI 写砸了不是老师的错）');

L(failed ? `\n✗ ${failed} 条不过` : '\n全部通过');
process.exit(failed ? 1 : 0);
