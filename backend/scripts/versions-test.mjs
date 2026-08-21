/**
 * 版本回退与材料图验证（api-spec 第 6、6.5 节）。
 *
 * 要守住的四件事，每一件都对应用户明确提过的诉求：
 *   1. 改稿之后回得去上一版
 *   2. 回退不新增版本、不删版本，可以来回切
 *   3. **改稿之后图片还在**（老师只在觉得值得画时才画，那份判断不因改稿失效）
 *   4. **回退之后图片还在**（不管回不回退，图都在）
 * 外加：一份教案最多 3 张材料图。
 *
 * 图片那几条不真调 MiniMax（一张 30 秒、两分半分钱），直接往 lesson_images 插行 ——
 * 要验的是「改稿和回退动不动它」，不是「画得像不像」。
 *
 *   node scripts/versions-test.mjs            # 只跑不花钱的部分
 *   node scripts/versions-test.mjs --revise   # 连真改稿一起跑（花 DeepSeek 额度，约 1 分钟）
 *
 * 自造隔离数据，可反复跑。
 */
import { readFileSync } from 'node:fs';
import { query, queryOne, closePool } from '../src/db/pool.js';

const BASE = process.env.API_BASE || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const WITH_REVISE = process.argv.includes('--revise');

let token = null;
const call = async (m, p, b) => {
  const r = await fetch(`${BASE}/v1${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(b ? { body: JSON.stringify(b) } : {}),
  });
  const j = await r.json().catch(() => ({ ok: false, error: { message: '非 JSON' } }));
  return { status: r.status, ...j };
};

const L = console.log;
let failed = 0;
const chk = (cond, msg) => {
  L(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

const RND = String(Date.now()).slice(-8);

/**
 * 备一张入场券 + 名单上一个岗位。
 *
 * 016 之后激活要两样：码（不带身份）+ 从名单里选的位置。
 * 码上原来能填手机号姓名，那条路撤了 —— 身份全部来自名单。
 */
async function makeTicket() {
  const aj = async (m, p, tok, b) => (await (await fetch(`${BASE}/admin/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    ...(b ? { body: JSON.stringify(b) } : {}),
  })).json());
  const at = (await aj('POST', '/login', null, { username: 'admin', password: ADMIN_PASSWORD })).data.token;
  const kg = await aj('POST', '/kindergartens', at, { name: `版本回归园_${RND}` });
  const imp = await aj('POST', '/roster/import', at,
    { text: `版本测试${RND}, 小一班, 主班, 小班`, kindergarten_id: kg.data.id, dry_run: false });
  const r = await aj('POST', '/codes', at, {
    kindergarten_id: kg.data.id, init_text: 30, init_image: 10,
    grant_reason: '版本回退回归测试',
  });
  return { code: r.data.code, slot: imp.data.created[0].id };
}

// ---------------------------------------------------------------
L('=== 0. 准备：激活 + 生成一份教案 ===');
const ticket = await makeTicket();
token = (await call('POST', '/auth/login', { code: `dev:ver_${RND}` })).data.token;
await call('POST', '/auth/redeem', { code: ticket.code, roster_entry_id: ticket.slot });
await call('POST', '/me/agree');

const conv = (await call('POST', '/conversations', { seed_input: '我想做个磁铁的活动' })).data;
const ageQ = conv.questions.find((q) => q.key === 'age_group');
await call('POST', `/conversations/${conv.conversation_id}/answer`, {
  question_id: ageQ.id,
  selected: [ageQ.options.find((o) => o.label === '小班')?.key || ageQ.options[0].key],
});
await call('POST', `/conversations/${conv.conversation_id}/generate`);

let planId = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = (await call('GET', `/conversations/${conv.conversation_id}/generate/status`)).data;
  if (s.status === 'completed') { planId = s.lesson_plan_id; break; }
  if (s.status === 'failed') throw new Error('生成失败，没法往下测');
}
chk(Boolean(planId), `教案 id=${planId}`);

// ---------------------------------------------------------------
L('\n=== 1. 第一版就该有快照 ===');
let vs = (await call('GET', `/lesson-plans/${planId}/versions`)).data;
chk(vs.versions.length === 1, `版本列表 ${vs.versions.length} 条`);
chk(vs.current_version === 1, `current_version=${vs.current_version}`);
chk(vs.versions[0].note === null, '第 1 版没有改稿意见（它不是改出来的）');

// ---------------------------------------------------------------
L('\n=== 2. 假装配了 2 张材料图 ===');
// 不真调 MiniMax：要验的是改稿和回退动不动它
for (const [i, name] of [['0', '大水盆'], ['1', '塑料积木']]) {
  await query(
    `INSERT INTO lesson_images (lesson_plan_id, section_key, prompt_cn, object_key, status, width, height)
     VALUES ($1, $2, $3, $4, 'ready', 1152, 864)`,
    [planId, `material.${i}`, name, `fake/${RND}_${i}.jpg`]
  );
}
let plan = (await call('GET', `/lesson-plans/${planId}`)).data;
chk(plan.images.length === 2, `教案上挂着 ${plan.images.length} 张图`);
chk(
  plan.images.every((im) => im.label),
  `每张图都带材料名（${plan.images.map((im) => im.label).join('、')}）—— 材料清单变了也认得出`
);

// ---------------------------------------------------------------
L('\n=== 3. 一份教案最多 3 张材料图 ===');
await query(
  `INSERT INTO lesson_images (lesson_plan_id, section_key, prompt_cn, object_key, status)
   VALUES ($1, 'material.2', '金属汤匙', $2, 'ready')`,
  [planId, `fake/${RND}_2.jpg`]
);
const over = await call('POST', `/lesson-plans/${planId}/images`, { section_key: 'material.3', note: '塑料瓶' });
chk(over.status === 403 && over.error?.code === 'IMAGE_LIMIT_EXCEEDED', `第 4 张被拦下（${over.error?.code}）`);
chk(over.error?.retryable === false, '标成不可重试 —— 再点多少次都是这个结果');

if (WITH_REVISE) {
  // -------------------------------------------------------------
  L('\n=== 4. 改稿（真跑，花额度）===');
  const FEEDBACK = '孩子人数写多了，我们班只有 15 个';
  const rv = await call('POST', `/lesson-plans/${planId}/revise`, { feedback: FEEDBACK });
  chk(rv.ok && rv.data.questions?.length === 3, `拿到 ${rv.data?.questions?.length} 道追问`);

  const answers = rv.data.questions.map((q) => ({
    question_id: q.id,
    selected: q.options?.length ? [q.options[0].key] : [],
    custom_text: null,
  }));
  await call('POST', `/lesson-plans/${planId}/revise/answer`, { revise_round: rv.data.revise_round, answers });

  let done = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = (await call('GET', `/conversations/${conv.conversation_id}/generate/status`)).data;
    if (s.status === 'completed') { done = true; break; }
    if (s.status === 'failed') throw new Error('改稿生成失败');
  }
  chk(done, '改稿重新生成完成');

  vs = (await call('GET', `/lesson-plans/${planId}/versions`)).data;
  chk(vs.versions.length === 2, `现在有 ${vs.versions.length} 版`);
  chk(vs.current_version === 2, `当前是第 ${vs.current_version} 版`);
  chk(
    vs.versions[1].note === FEEDBACK,
    `第 2 版记着产生它的那句话：「${String(vs.versions[1].note).slice(0, 20)}…」`
  );

  L('\n=== 5. 改稿之后图片还在（用户明确要求）===');
  plan = (await call('GET', `/lesson-plans/${planId}`)).data;
  chk(plan.images.length === 3, `改完还是 ${plan.images.length} 张，一张没少`);

  L('\n=== 6. 回退到第 1 版 ===');
  const v2Title = plan.title;
  const back = await call('POST', `/lesson-plans/${planId}/rollback`, { version: 1 });
  chk(back.ok, `回退成功，现在是第 ${back.data?.version} 版`);
  plan = (await call('GET', `/lesson-plans/${planId}`)).data;
  chk(plan.current_version === 1, `current_version=${plan.current_version}`);
  chk(plan.version === 2, `version 仍然是 ${plan.version} —— 历史没被删，只是指针挪了`);
  chk(plan.title === vs.versions[0].title, `内容换回第 1 版了（标题：${plan.title}）`);

  L('\n=== 7. 回退之后图片还在（用户明确要求）===');
  chk(plan.images.length === 3, `回退后还是 ${plan.images.length} 张`);

  L('\n=== 8. 能来回切 ===');
  await call('POST', `/lesson-plans/${planId}/rollback`, { version: 2 });
  plan = (await call('GET', `/lesson-plans/${planId}`)).data;
  chk(plan.current_version === 2 && plan.title === v2Title, '又切回第 2 版了');
  chk(plan.images.length === 3, '来回切了两次，图还是 3 张');

  const still = (await call('GET', `/lesson-plans/${planId}/versions`)).data;
  chk(still.versions.length === 2, `版本数没变（${still.versions.length} 版）—— 回退不新增也不删`);
} else {
  L('\n=== 4-8. 改稿与回退 —— 跳过（加 --revise 才跑，会花 DeepSeek 额度）===');
  L('    单独验一下回退接口本身：回到当前版应该是空操作');
  const same = await call('POST', `/lesson-plans/${planId}/rollback`, { version: 1 });
  chk(same.ok && same.data?.unchanged === true, '回到当前版 = 空操作，不报错');
  const bad = await call('POST', `/lesson-plans/${planId}/rollback`, { version: 99 });
  chk(bad.status === 404, `不存在的版本返回 ${bad.status}`);
  plan = (await call('GET', `/lesson-plans/${planId}`)).data;
  chk(plan.images.length === 3, '折腾完图还是 3 张');
}

// ---------------------------------------------------------------
L('\n=== 9. 配图用途（不花钱，直接查规则表）===');
const { PURPOSES, resolvePurpose, buildPurposeSystem } = await import('../src/services/imagePurpose.js');

chk(Object.keys(PURPOSES).length === 5, `五种用途齐全：${Object.keys(PURPOSES).join('/')}`);
chk(PURPOSES.worksheet.height > PURPOSES.worksheet.width, '记录表是竖版（对着 A4）');
chk(PURPOSES.headwear.width > PURPOSES.headwear.height, '头饰是横版（两条带子要够长）');
chk(PURPOSES.backdrop.width > PURPOSES.backdrop.height, '环创背景是横版通景');
chk(
  Object.values(PURPOSES).every((p) => Math.max(p.width, p.height) === 2048 || p.width === p.height),
  '尺寸按打印定：长边 2048，约 A4 250 DPI'
);
chk(resolvePurpose('乱填的') === 'material', '不认识的用途退回材料图，不报错');
chk(resolvePurpose(undefined) === 'material', '没传用途也退回材料图');

/** 从系统提示词里抠出那段被引号包着的强制英文前缀 */
const prefixOf = (k) => (buildPurposeSystem(k).match(/"([^]*?)"\n\n然后/) || [, ''])[1];

// 最重要的一条：否定约束必须落在**英文风格前缀**里。
// 中文那几条只有 DeepSeek 看得到，图片模型从头到尾没见过 —— 第一版就是这么翻的车，
// 中文写着「一个字都不许画」，出来的记录表上却印着 BOAT / HEAVY STONE 和一个假签名。
const missingNoText = Object.keys(PURPOSES).filter(
  (k) => !/no letters, no words, no numbers/.test(prefixOf(k))
);
chk(missingNoText.length === 0, `五种用途的英文前缀里都写死了「一个字都不许画」${missingNoText.length ? '：缺 ' + missingNoText.join('/') : ''}`);
chk(PURPOSES.worksheet.optimize === false, '记录表关掉了 MiniMax 的提示词润色（它会把标题栏和水印补回来）');

// 印出来当东西用的（记录表/头饰）不许顶着「图画书插画风」那句前缀。
// 它是提示词第一句、权重最高，后面写多少 pure white / thick black lines 都掰不回来 ——
// 实测带插画前缀的记录表：手写体乱码 + 猫头鹰 + 随机列数；换成线稿前缀就干净了。
const wrongPrefix = Object.keys(PURPOSES).filter((k) => {
  const isPrint = PURPOSES[k].kind === 'print';
  const looksIllustration = /picture-book style/.test(prefixOf(k));
  return isPrint === looksIllustration;
});
chk(wrongPrefix.length === 0, `线稿类用线稿前缀、插画类用插画前缀${wrongPrefix.length ? '：串了 ' + wrongPrefix.join('/') : ''}`);

// 强制前缀太长会把**老师那句描述**顶出上限，被 buildImagePrompt 静默切掉 ——
// 记录表就这么坏过：前缀 840 字符、上限 800，每一次都在半个单词处断，
// 描述整段丢失，出来的图顶着 "Name ______"。这条断言就是防它复发的。
const PROMPT_LIMIT = 1500;
const tooLong = Object.keys(PURPOSES).filter((k) => PROMPT_LIMIT - prefixOf(k).length < 400);
chk(
  tooLong.length === 0,
  `每种用途的强制前缀都给描述留了 400+ 字符余量${tooLong.length ? '：太长了 ' + tooLong.map((k) => `${k}(${prefixOf(k).length})`).join('/') : ''}`
);

// ---------------------------------------------------------------
L('\n=== 10. 配图模型注册表（不花钱，直接查配置）===');
const { FORMATS, listModels, publicShape, pickModel } = await import('../src/services/imageModels.js');
const { resolveImageProvider } = await import('../src/services/imageGen.js');
const { nearestRatio } = await import('../src/services/geminiImage.js');
const { config: cfg } = await import('../src/config.js');

chk(
  Object.values(FORMATS).every((f) => typeof f.generate === 'function'),
  `${Object.keys(FORMATS).length} 种接口格式都实现了 generate：${Object.keys(FORMATS).join('/')}`
);

const models = await listModels();
chk(models.length > 0, `有 ${models.length} 个可用模型：${models.map((m) => m.key).join('/')}`);
chk(models.every((m) => FORMATS[m.format]), '每个模型的格式都认识');
chk(models.every((m) => m.account?.apiKey && m.account?.baseURL), '每个模型都有地址和密钥');

// 老师那边不该出现「模型选错了」这种事：认不出来的值要静悄悄退回去，不是报错
chk(Boolean(await resolveImageProvider('乱填的')), '不认识的模型退回到能用的一个');
chk(Boolean(await resolveImageProvider(undefined)), '没传模型也退回到能用的一个');
chk((await pickModel()).key === cfg.imageProvider, `没指定时用 .env 的默认值（现在是 ${cfg.imageProvider}）`);

// 这条是安全红线：给小程序的形状里**绝不能**出现密钥或地址。
// 破了它等于把钥匙串挂在门上 —— 加模型之所以放在后台而不是设置页，就是为了这条
const leaked = models
  .map((m) => JSON.stringify(publicShape(m)))
  .filter((s) => /apiKey|api_key|sk-|http/i.test(s));
chk(leaked.length === 0, '下发给小程序的模型信息里没有密钥、没有地址');

// 用哪个模型**由后台定**，老师不选（2026-08-18）。
// 这条要是破了，等于把技术选型的开关交到客户端手上，而客户端是可以被随便改的。
const { getSetting, setSetting, SETTING_KEYS } = await import('../src/services/appSettings.js');
// 注释里会出现「刻意不读 req.body.provider」这句话，先把注释剥掉再查，
// 否则这条断言会被自己的注释绊倒（第一次写就是这么挂的）
const imagesSrc = readFileSync(new URL('../src/routes/images.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
chk(
  !/req\.body\s*\??\.\s*provider/.test(imagesSrc),
  '配图路由不读请求里的 provider（传了也不算数）'
);

// 后台设完要**立刻生效**，不用重启 —— 否则还是得进服务器改 .env，白做
const savedDefault = await getSetting(SETTING_KEYS.imageProvider, '');
const other = (await listModels()).map((m) => m.key).find((k) => k !== savedDefault);
if (other) {
  await setSetting(SETTING_KEYS.imageProvider, other);
  chk((await pickModel()).key === other, `后台改默认后立刻生效（临时切到 ${other}）`);
  await setSetting(SETTING_KEYS.imageProvider, savedDefault);
  chk((await pickModel()).key === savedDefault, `改回来也立刻生效（还原成 ${savedDefault}）`);
}

// Gemini 那套没有宽高，只有比例。我们按打印定的宽高要能落到最近的一档
chk(nearestRatio(1536, 2048) === '3:4', '记录表 1536×2048 → 3:4');
chk(nearestRatio(2048, 1152) === '16:9', '环创背景 2048×1152 → 16:9');
chk(nearestRatio(1536, 1536) === '1:1', '材料图 1536×1536 → 1:1');

// 一句话里说了好几样。
// 实测坑：老师写「我需要准备小狗、小猫和兔子的头饰」，出来的图**只有小狗** ——
// 头饰构图规则里写死了 "one outlined shape in the center"，模型只能从三个里挑一个，
// 另外两样被悄悄丢掉，而配额已经扣了一张。现在改成一张纸上排三条。
const { countSubjects, purposeSpec } = await import('../src/services/imagePurpose.js');
chk(countSubjects('小鱼头饰') === 1, '「小鱼头饰」= 1 样');
chk(countSubjects('我需要准备小狗、小猫和兔子的头饰') === 3, '「小狗、小猫和兔子」= 3 样');
chk(countSubjects('') === 1, '没写描述时按 1 样');
chk(countSubjects('一、二、三、四、五、六') === 4, '再多也封顶 4 条（每条会窄到剪不动）');

const hw1 = purposeSpec('headwear', 1);
const hw3 = purposeSpec('headwear', 3);
chk(hw3.height > hw1.height, `排 3 条时画布要更高（${hw1.height} → ${hw3.height}）`);
chk(hw3.width === hw1.width, '宽度不变 —— 带子要横着通到画面边缘');
chk(/sheet of 3 separate cut-out headband templates/.test(hw3.style), '构图规则改成「一张纸上 3 条」');
chk(/one outlined shape in the center/.test(hw1.style), '只说一样时还是单条那套');
chk(purposeSpec('worksheet', 3).height === purposeSpec('worksheet', 1).height, '记录表不受这条影响');

// ---------------------------------------------------------------
L('\n=== 11. 两个 POST .../update 别名（2026-08-21）===');
//
// 小程序发不出 PATCH，所以 PATCH /me 和 PATCH /lesson-plans/:id 各挂了一条 POST 别名。
// 这一节要钉住的**不是「POST 通了」**，而是「两个方法真的是同一个 handler」——
// 别名很容易被写成第二份实现，而两份实现里总有一份是没人测的：
// 表现会是「小程序里改了没生效、H5 里改了生效」，还不报错。
{
  // ---- POST /lesson-plans/:id/update ----
  const before = (await call('GET', `/lesson-plans/${planId}`)).data;
  const NEW_EXT = `别名测试改的延伸_${RND}`;

  const viaPost = await call('POST', `/lesson-plans/${planId}/update`, { path: 'extension', value: NEW_EXT });
  chk(viaPost.ok, `POST /lesson-plans/:id/update → ${viaPost.status}`);
  chk(viaPost.data?.content_json?.extension === NEW_EXT, '按 path 改的那一段真的变了');
  chk(
    viaPost.data?.content_md?.includes(NEW_EXT),
    'content_md 跟着重渲染了 —— md 是 json 的投影，不许各自漂移'
  );

  // 同一个 handler：PATCH 也必须收，且行为一致
  const viaPatch = await call('PATCH', `/lesson-plans/${planId}`, { path: 'extension', value: `${NEW_EXT}_2` });
  chk(viaPatch.ok, `PATCH /lesson-plans/:id 仍然收（${viaPatch.status}）—— 别名不是替换`);
  chk(viaPatch.data?.content_json?.extension === `${NEW_EXT}_2`, 'PATCH 的效果跟 POST 一样');

  // 图片不许被编辑碰掉（跟改稿、回退同一条铁律）
  chk(viaPatch.data?.images?.length === before.images.length, `编辑之后图还是 ${before.images.length} 张`);

  // 别名不许绕过校验：不存在的路径要被拒
  const badPath = await call('POST', `/lesson-plans/${planId}/update`, { path: 'nope.deep.x', value: '1' });
  chk(badPath.status === 400, `别名照样校验路径（不存在的路径 → ${badPath.status}）`);
  const nothing = await call('POST', `/lesson-plans/${planId}/update`, {});
  chk(nothing.status === 400, `空 body 被拒（${nothing.status}）`);

  // 别人的教案改不动 —— 别名最容易漏掉的正是这道 teacher_id 过滤
  const stolen = await call('POST', `/lesson-plans/999999/update`, { path: 'extension', value: 'x' });
  chk(stolen.status === 404, `别人（或不存在）的教案 → ${stolen.status}`);

  // ---- POST /me/update ----
  const KG = `别名测试园_${RND}`;
  const up = await call('POST', '/me/update', { kindergarten_name: KG, teaching_years: 7, age_group: '中班' });
  chk(up.ok, `POST /me/update → ${up.status}`);
  chk(up.data?.kindergarten_name === KG, '园所名存下来了');
  chk(up.data?.teaching_years === 7, '教龄存下来了');
  chk(up.data?.age_group === '中班', '年龄班改掉了（激活时名单给的是小班）');

  // profile_completed 在这条路通之前对任何老师都恒为 false ——
  // 因为它要 kindergarten_name，而激活只写 kindergarten_id
  chk(up.data?.profile_completed === true, 'profile_completed 终于能变成 true 了');

  const me = (await call('GET', '/me')).data;
  chk(me.kindergarten_name === KG && me.teaching_years === 7, '重新拉一次档案，改动确实落了库');

  // 白名单：不在名单上的字段一个都不许进
  await call('POST', '/me/update', { openid: 'hacked', activated_at: '2000-01-01', real_name: '张三' });
  const after = (await call('GET', '/me')).data;
  chk(after.kindergarten_name === KG, '传了白名单外的字段，已有数据没被冲掉');
  chk(!('openid' in after) && !('real_name' in after), 'openid 和真实姓名从来不下发前端');

  const badBand = await call('POST', '/me/update', { age_group: '托班' });
  chk(badBand.status === 400, `年龄班校验还在（"托班" → ${badBand.status}）`);
  const badYears = await call('POST', '/me/update', { teaching_years: 99 });
  chk(badYears.status === 400, `教龄上限还在（99 → ${badYears.status}）`);

  // ---- 018 加的三项挑选题：岗位 / 最高学历 / 职称 ----
  const picked = await call('POST', '/me/update', {
    position: '配班', education: '本科', professional_title: '一级教师',
  });
  chk(picked.ok && picked.data?.position === '配班', '岗位能改（名单给的是主班）');
  chk(picked.data?.education === '本科' && picked.data?.professional_title === '一级教师',
    '最高学历和职称存下来了（018 迁移那两列）');

  for (const [k, v] of [['position', '实习生'], ['education', '博士后'], ['professional_title', '特级教师']]) {
    const r = await call('POST', '/me/update', { [k]: v });
    chk(r.status === 400, `${k} 的白名单挡住了 "${v}"（${r.status}）`);
    chk(/只能是/.test(r.error?.message || ''), `  报错里列出了可选项：${String(r.error?.message).slice(0, 28)}…`);
  }

  // 「未评定」是她主动选的值，跟 null（没填过）不是一回事 —— 两者都要存得进去
  const unrated = await call('POST', '/me/update', { professional_title: '未评定' });
  chk(unrated.data?.professional_title === '未评定', '「未评定」是一个可选值，不是空');
  const cleared = await call('POST', '/me/update', { professional_title: null });
  chk(cleared.data?.professional_title === null, '传 null 能清回「没填过」—— 跟「未评定」分得开');

  // 教龄 0 是有意义的值（今年刚入职），不许被当成空丢掉
  const zero = await call('POST', '/me/update', { teaching_years: 0 });
  chk(zero.data?.teaching_years === 0, '教龄 0 年存得进去（新手老师那一档）');

  const patchMe = await call('PATCH', '/me', { teaching_years: 8 });
  chk(patchMe.ok && patchMe.data?.teaching_years === 8, 'PATCH /me 仍然收，行为一致');
}

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`);
await closePool();
process.exit(failed === 0 ? 0 : 1);
