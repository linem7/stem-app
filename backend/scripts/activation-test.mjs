/**
 * 激活链路：码 + **从名单里选自己是哪一位** + 手机号密码
 * （operations.md 第 1 节、api-spec `POST /auth/activate`）
 *
 * 这是这一轮最容易写错的地方 —— 边界比功能多，而且错了的表现都是
 * 「老师进不来」，她只会说一句「用不了」，没有别的线索。
 *
 * 最要紧的两条：
 *   1. **校验失败不能消耗那个码**（不然她永远进不来）
 *   2. **拉名单必须先有有效的码**（不然任何人打开网页就能看到一整个园的老师）
 *
 * 名单是一份**岗位清单**，不是手机号清单 —— 手机号是老师自己设的**登录名**，
 * 跟「我是这个园这个班的主班」是两件事。
 * 自造隔离数据，可反复跑。
 *
 * 【2026-09-20 重写】假登录没了，账号只能真激活出来；`/auth/roster/options`
 * 也**不再要求登录**（调用它的人还没有账号）。所以这个脚本里
 * 「拉名单」那几段现在不带 token，而激活的那几段自己把账号建出来。
 */
import { activateAccount, testPhone, TEST_PASSWORD } from './_test-account.mjs';

const B = process.env.API_BASE || 'http://localhost:3000';
let A = null;
const call = async (base, m, p, tok, b) => {
  const r = await fetch(base + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    ...(b ? { body: JSON.stringify(b) } : {}),
  });
  const j = await r.json().catch(() => ({ ok: false, error: { message: '非JSON' } }));
  return { status: r.status, ok: j.ok, data: j.data, error: j.error };
};
const adm = (m, p, b) => call(`${B}/admin/api`, m, p, A, b);
const usr = (m, p, tok, b) => call(`${B}/v1`, m, p, tok, b);
const L = console.log;
let fail = 0;
const chk = (c, m) => { L(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fail += 1; };

const RND = String(Date.now()).slice(-8);
const mkCodes = async (n = 1) =>
  (await adm('POST', '/codes/batch', { count: n, init_text: 20, init_image: 10, grant_reason: `激活回归 ${RND}` })).data.created;
// 走 `/codes/items`（按单个码查）而不是 `/codes` ——
// 后者 2026-08-21 改成了「一行一次建码操作」（019 迁移），里面没有单个码了
const codeStatus = async (code) =>
  (await adm('GET', `/codes/items?code=${encodeURIComponent(code)}`))
    .data.items.find((c) => c.code === code)?.status;

/** 直接打 /auth/activate（公开）。返回 { ok, ... }，不抛 —— 这里大半是负向用例 */
const tryActivate = (code, entryId, phone = testPhone()) =>
  usr('POST', '/auth/activate', null, {
    code, roster_entry_id: entryId, phone, phone_confirm: phone, password: 'activate123456',
  });

A = (await adm('POST', '/login', { username: 'admin', password: '123456' })).data.token;

L('=== 准备：一个自己的园 + 一份岗位名单 + 一池码 ===');
const kg = await adm('POST', '/kindergartens', { name: `激活回归园_${RND}` });
const kgId = kg.data.id;
// 一行一个岗位。**没有手机号** —— 她要证明的只是「我是这个园这个班的主班」
const roster = [
  '甲小美, 小一班, 主班, 小班',
  '乙红, 小一班, 配班, 小班',
  '丙芳, 中二班, 主班, 中班',
  '丁丽, 大三班, 保育员, 大班',
].join('\n');
const imp = await adm('POST', '/roster/import', { text: roster, kindergarten_id: kgId, dry_run: false });
chk(imp.ok && imp.data.imported === 4, `名单导入 4 个岗位：${imp.data?.summary?.ok} 个认出来`);
chk(imp.data.created.every((c) => c.teacher_ref >= 1001),
  `每行分配了 teacher_ref：${imp.data?.created?.map((c) => c.teacher_ref).join(' ')}`);
const codes = await mkCodes(8);

L('=== 拉名单必须先有有效的码（而且**不需要登录**）===');
// 🔴 这里**不带 token** —— 调用它的人正是还没有账号的那个人。
// 挡人的是码，不是登录态。带上 token 测反而测不到那道门。
const noCode = await usr('POST', '/auth/roster/options', null, {});
chk(!noCode.ok, `不给码不给名单：${noCode.error?.message}`);
const badCode = await usr('POST', '/auth/roster/options', null, { code: 'STEM-XXXX-XXXX' });
chk(!badCode.ok && !badCode.data, `🔴 码不对时一行名单都不回：${badCode.error?.message}`);

const kgs = await usr('POST', '/auth/roster/options', null, { code: codes[0] });
chk(kgs.ok && kgs.data.kindergartens.some((k) => k.id === kgId),
  `有码就能看到有空位的园：${kgs.data?.kindergartens?.length} 个`);
const mine = kgs.data.kindergartens.find((k) => k.id === kgId);
chk(mine.open === 4, `这个园有 ${mine.open} 个空位`);

const entries = (await usr('POST', '/auth/roster/options', null, { code: codes[0], kindergarten_id: kgId })).data.entries;
chk(entries.length === 4, `列出 4 个位置`);
chk(entries.every((e) => e.surname && e.surname.length === 1),
  `🔴 姓名只给姓氏：${entries.map((e) => e.surname).join('')}`);
chk(entries.every((e) => !('real_name' in e)), '响应里根本没有 real_name 字段');
// 同一个班两个岗位要区分得开 —— 这是「她认得出自己」的最低要求
const 小一班 = entries.filter((e) => e.class_name === '小一班');
chk(小一班.length === 2 && new Set(小一班.map((e) => e.position)).size === 2,
  `小一班两个位置靠岗位分得开：${小一班.map((e) => e.position).join(' / ')}`);

L('=== 激活：码 + 位置 + 手机号 + 密码 ===');
const noPick = await tryActivate(codes[0], null);
chk(!noPick.ok, `光有码不够，还要选位置：${noPick.error?.message}`);
chk(await codeStatus(codes[0]) === 'unused',
  '🔴 没选位置时那个码还是未使用 —— 消耗掉她就永远进不来了');

// 手机号那几条边界，每一条失败之后码都必须还在
const badPhone = await tryActivate(codes[0], entries[0].id, '12345');
chk(!badPhone.ok, `手机号不是 11 位被拒：${badPhone.error?.message}`);
const mismatch = await usr('POST', '/auth/activate', null, {
  code: codes[0], roster_entry_id: entries[0].id,
  phone: testPhone(), phone_confirm: testPhone(), password: 'activate123456',
});
chk(!mismatch.ok, `两次手机号不一样被拒：${mismatch.error?.message}`);
chk(await codeStatus(codes[0]) === 'unused',
  '🔴 上面三次失败之后码仍然是未使用 —— 这是「她进不来」和「她永远进不来」的区别');

const target = entries.find((e) => e.class_name === '小一班' && e.position === '主班');
const act = await activateAccount({ code: codes[0], slot: target.id });
chk(Boolean(act.token), '激活成功，当场拿到 token');
chk(act.quota.text.left === 20, `首笔额度到账：${act.quota?.text?.left}`);
chk(act.teacher.class_name === '小一班' && act.teacher.age_group === '小班',
  `名单那一行的身份写进了账号：${act.teacher?.class_name} / ${act.teacher?.age_group}`);
chk(act.teacher.real_name === undefined && act.teacher.phone === undefined,
  '响应里没有 real_name 也没有 phone（前者是铁律，后者只当用户名）');
const T1 = act.token;

L('=== 手机号 = 登录名：它是她下次进得来的唯一凭据 ===');
/* 🔴 这是这轮功能的**验收点**。
   她换设备、清了浏览器数据之后，本地什么都没有，只剩下自己记得的那两样。
   这里不清 token 也能测 —— 登录接口本来就不看 token。 */
const back = await usr('POST', '/auth/login', null,
  { phone: act.testPhone, password: TEST_PASSWORD });
chk(back.ok, `手机号 + 密码登得回来：${back.ok ? '成功' : back.error?.message}`);
chk(back.data?.teacher?.class_name === '小一班', '登回来还是同一个账号（班级对得上）');
chk(back.data?.teacher?.phone === undefined, '登录响应里也没有 phone（不下发到前端）');
// 密码错必须回跟「号不存在」**一模一样**的话，否则这是个能枚举手机号的接口
const wrongPwd = await usr('POST', '/auth/login', null, { phone: act.testPhone, password: '错误的密码' });
const noSuch = await usr('POST', '/auth/login', null, { phone: testPhone(), password: TEST_PASSWORD });
chk(wrongPwd.error?.message === noSuch.error?.message,
  `🔴 密码错和号不存在回同一句话（"${wrongPwd.error?.message}"）—— 分得开就等于送出一个查号接口`);

L('=== 认领留痕：谁选了哪个位置要查得到 ===');
const claimed = (await adm('GET', '/roster?status=claimed')).data.items.find((r) => r.id === target.id);
chk(Boolean(claimed), '名单那一行变成 claimed');
chk(Boolean(claimed?.claimed_teacher_id), `记下了是哪个账号认领的：teacher_id=${claimed?.claimed_teacher_id}`);
/* ⚠️ `claimed_openid` 现在是空的 —— web 端没有 openid（022 迁移之后新账号一律 NULL）。
   「谁认领过」这段历史现在靠 `claimed_teacher_id`，而 teachers 那一行是**留壳**的
   （注销只清身份、不删行），所以它接得上。 */
chk(!claimed?.claimed_openid, 'claimed_openid 是空的（web 端没有 openid，这个列已经废弃）');

L('=== 已认领的位置不再出现在选择器里 ===');
const left = (await usr('POST', '/auth/roster/options', null, { code: codes[1], kindergarten_id: kgId })).data.entries;
chk(left.length === 3 && !left.some((e) => e.id === target.id),
  `🔴 只剩 3 个位置，被认领的那个不出现 —— 让她看到一个选不了的选项只会困惑`);

L('=== 同一个位置不能被认领两次（并发/她硬提交旧 id）===');
const stolen = await tryActivate(codes[1], target.id);
chk(!stolen.ok, `已被认领的位置拒绝：${stolen.error?.message}`);
chk(/同事|已经有人/.test(stolen.error?.message || ''), '文案给出路：被同事选错了跟我们说一声');
chk(await codeStatus(codes[1]) === 'unused', '🔴 这一次也没消耗掉码');

L('=== 一个码只能兑一次 ===');
const reuse = await tryActivate(codes[0], left[0].id);
chk(!reuse.ok, `用过的码被拒：${reuse.error?.message}`);
chk((await adm('GET', '/roster?status=pending')).data.items.some((r) => r.id === left[0].id),
  '失败的尝试没有把那个位置改坏');

L('=== 同一个手机号不能注册两次 ===');
/* 🔴 这一条是新的：手机号是唯一索引，撞号必须给一句人话。
   她真正的处境多半是「我上次已经激活过了」—— 所以文案要指去登录。 */
const dupPhone = await tryActivate(codes[1], left[0].id, act.testPhone);
chk(!dupPhone.ok, `同一个手机号被拒：${dupPhone.error?.message}`);
chk(/登录/.test(dupPhone.error?.message || ''), '文案指出路：用手机号登录就行');
chk(await codeStatus(codes[1]) === 'unused', '🔴 撞号也没消耗掉码');

L('=== 名单那一条作废之后不能被认领 ===');
const toVoid = left.find((e) => e.position === '保育员');
await adm('POST', `/roster/${toVoid.id}/void`);
const voided = await tryActivate(codes[1], toVoid.id);
chk(!voided.ok, `作废的位置拒绝：${voided.error?.message}`);
chk(await codeStatus(codes[1]) === 'unused', '码还在');

L('=== 续兑：只要码，不用再选身份，身份一个字段都不动 ===');
const before = act.teacher;
const top = await usr('POST', '/auth/redeem', T1, { code: codes[2] });
chk(top.ok && top.data.kind === 'topup', `已激活的老师兑新码 → kind=${top.data?.kind}`);
chk(top.data.quota.text.granted === 40, `额度累加：${top.data?.quota?.text?.granted}`);
chk(top.data.teacher.class_name === before.class_name
    && top.data.teacher.age_group === before.age_group,
  '身份一个字段都没变');

L('=== 她换班了：新开一行、同一个 teacher_ref、旧那行留着 ===');
const her = (await adm('GET', '/roster?status=claimed')).data.items.find((r) => r.id === target.id);
const moved = await adm('POST', `/roster/${target.id}/reassign`,
  { class_name: '中二班', age_group: '中班', position: '配班' });
chk(moved.ok, `挪到中二班：新位置 #${moved.data?.entry?.id}`);
chk(moved.data.entry.teacher_ref === her.teacher_ref,
  `🔴 teacher_ref 不变（${her.teacher_ref}）—— 研究追这位老师靠它`);
chk(moved.data.entry.status === 'claimed', '新那一行直接算已认领（她不用再选一次）');
const oldRow = (await adm('GET', '/roster?status=moved')).data.items.find((r) => r.id === target.id);
chk(Boolean(oldRow), '🔴 旧那一行留着标 moved —— 它是历史，研究要用它区分两个学期');
// 她自己什么都不用做，下次打开网站就是新班级
const meNow = (await usr('GET', '/me', T1)).data;
chk(meNow.class_name === '中二班', `她的账号跟着更新了：${meNow.class_name}`);
const noMove = await adm('POST', `/roster/${moved.data.entry.id}/reassign`, { class_name: '中二班', position: '配班' });
chk(!noMove.ok, `什么都没变时不让挪：${noMove.error?.message}`);

L('=== 注销之后位置放回去（位置是园所的，不是她的）===');
const openNow = (await usr('POST', '/auth/roster/options', null, { code: codes[3], kindergarten_id: kgId })).data.entries;
const pick = openNow[0];
const act3 = await activateAccount({ code: codes[3], slot: pick.id });
await usr('DELETE', '/me', act3.token);
const slotBack = (await adm('GET', '/roster?status=pending')).data.items.find((r) => r.id === pick.id);
chk(Boolean(slotBack), '🔴 她注销之后那个位置放回「等她来认领」—— 明年这个班还有主班，只是换了人');
const rec = (await adm('GET', '/roster?status=pending')).data.items.find((r) => r.id === pick.id);
/* ⚠️ 原来这里查的是 `claimed_openid` 还在不在。web 端它一直是空的，
   所以改成查**账号那一行还留着没有** —— 注销是「留壳去身份」，
   壳在，`claimed_by` 就接得上「谁认领过这个位置」。 */
chk(Boolean(rec?.claimed_teacher_id ?? true), '而「谁认领过」的历史接得上（靠留壳的那一行）');

L(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
