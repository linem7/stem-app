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

async function makeCode() {
  const at = (
    await (
      await fetch(`${BASE}/admin/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
      })
    ).json()
  ).data.token;
  const kg = await (await fetch(`${BASE}/admin/api/kindergartens`, { headers: { Authorization: `Bearer ${at}` } })).json();
  const r = await (
    await fetch(`${BASE}/admin/api/codes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${at}` },
      body: JSON.stringify({
        phone: `133${RND}`,
        real_name: '版本测试',
        kindergarten_id: kg.data.items[0]?.id,
        age_group: '小班',
        init_text: 30,
        init_image: 10,
        grant_reason: '版本回退回归测试',
      }),
    })
  ).json();
  return r.data.code;
}

// ---------------------------------------------------------------
L('=== 0. 准备：激活 + 生成一份教案 ===');
const code = await makeCode();
token = (await call('POST', '/auth/login', { code: `dev:ver_${RND}` })).data.token;
await call('POST', '/auth/redeem', { code });
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

// 最重要的一条：否定约束必须落在**英文风格前缀**里。
// 中文那几条只有 DeepSeek 看得到，图片模型从头到尾没见过 —— 第一版就是这么翻的车，
// 中文写着「一个字都不许画」，出来的记录表上却印着 BOAT / HEAVY STONE 和一个假签名。
const missingNoText = Object.keys(PURPOSES).filter((k) => {
  const prefix = buildPurposeSystem(k).split('\n').find((l) => l.trim().startsWith('"Flat vector')) || '';
  return !/no letters, no words, no numbers/.test(prefix);
});
chk(missingNoText.length === 0, `五种用途的英文前缀里都写死了「一个字都不许画」${missingNoText.length ? '：缺 ' + missingNoText.join('/') : ''}`);
chk(PURPOSES.worksheet.optimize === false, '记录表关掉了 MiniMax 的提示词润色（它会把标题栏和水印补回来）');

L(`\n${failed === 0 ? '全部通过' : `${failed} 项没过`}`);
await closePool();
process.exit(failed === 0 ? 0 : 1);
