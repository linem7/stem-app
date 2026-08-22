/**
 * 激活链路：码 + **从名单里选自己是哪一位**（operations.md 第 1 节，016 迁移）
 *
 * 这是这一轮最容易写错的地方 —— 边界比功能多，而且错了的表现都是
 * 「老师进不来」，她只会在微信上说一句「用不了」，没有别的线索。
 *
 * 最要紧的两条：
 *   1. **校验失败不能消耗那个码**（不然她永远进不来）
 *   2. **拉名单必须先有有效的码**（不然任何人打开小程序就能看到一整个园的老师）
 *
 * 库里没有手机号 —— 016 迁移把那一列删了。名单是一份**岗位清单**。
 * 自造隔离数据，可反复跑。
 */
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
const newWx = async (tag) => (await usr('POST', '/auth/login', null, { code: `dev:act_${RND}_${tag}` })).data.token;
const mkCodes = async (n = 1) =>
  (await adm('POST', '/codes/batch', { count: n, init_text: 20, init_image: 10, grant_reason: `激活回归 ${RND}` })).data.created;
// 走 `/codes/items`（按单个码查）而不是 `/codes` ——
// 后者 2026-08-21 改成了「一行一次建码操作」（019 迁移），里面没有单个码了
const codeStatus = async (code) =>
  (await adm('GET', `/codes/items?code=${encodeURIComponent(code)}`))
    .data.items.find((c) => c.code === code)?.status;

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

L('=== 拉名单必须先有有效的码 ===');
const T1 = await newWx('a');
const noCode = await usr('POST', '/auth/roster/options', T1, {});
chk(!noCode.ok, `不给码不给名单：${noCode.error?.message}`);
const badCode = await usr('POST', '/auth/roster/options', T1, { code: 'STEM-XXXX-XXXX' });
chk(!badCode.ok && !badCode.data, `🔴 码不对时一行名单都不回：${badCode.error?.message}`);

const kgs = await usr('POST', '/auth/roster/options', T1, { code: codes[0] });
chk(kgs.ok && kgs.data.kindergartens.some((k) => k.id === kgId),
  `有码就能看到有空位的园：${kgs.data?.kindergartens?.length} 个`);
const mine = kgs.data.kindergartens.find((k) => k.id === kgId);
chk(mine.open === 4, `这个园有 ${mine.open} 个空位`);

const entries = (await usr('POST', '/auth/roster/options', T1, { code: codes[0], kindergarten_id: kgId })).data.entries;
chk(entries.length === 4, `列出 4 个位置`);
chk(entries.every((e) => e.surname && e.surname.length === 1),
  `🔴 姓名只给姓氏：${entries.map((e) => e.surname).join('')}`);
chk(entries.every((e) => !('real_name' in e)), '响应里根本没有 real_name 字段');
// 同一个班两个岗位要区分得开 —— 这是「她认得出自己」的最低要求
const 小一班 = entries.filter((e) => e.class_name === '小一班');
chk(小一班.length === 2 && new Set(小一班.map((e) => e.position)).size === 2,
  `小一班两个位置靠岗位分得开：${小一班.map((e) => e.position).join(' / ')}`);

L('=== 激活：码 + 选一个位置 ===');
const noPick = await usr('POST', '/auth/redeem', T1, { code: codes[0] });
chk(!noPick.ok, `光有码不够，还要选：${noPick.error?.message}`);
chk(await codeStatus(codes[0]) === 'unused',
  '🔴 没选位置时那个码还是未使用 —— 消耗掉她就永远进不来了');

const target = entries.find((e) => e.class_name === '小一班' && e.position === '主班');
const act = await usr('POST', '/auth/redeem', T1, { code: codes[0], roster_entry_id: target.id });
chk(act.ok && act.data.kind === 'activate', `激活成功（kind=${act.data?.kind}）`);
chk(act.data.quota.text.left === 20, `首笔额度到账：${act.data?.quota?.text?.left}`);
chk(act.data.teacher.class_name === '小一班' && act.data.teacher.age_group === '小班',
  `名单那一行的身份写进了账号：${act.data?.teacher?.class_name} / ${act.data?.teacher?.age_group}`);
chk(act.data.teacher.real_name === undefined && act.data.teacher.phone === undefined,
  '响应里没有 real_name 也没有 phone（前者是铁律，后者根本不存在了）');

L('=== 认领留痕：谁选了哪个位置要查得到 ===');
const claimed = (await adm('GET', '/roster?status=claimed')).data.items.find((r) => r.id === target.id);
chk(Boolean(claimed), '名单那一行变成 claimed');
chk(Boolean(claimed?.claimed_openid), `记下了是哪个微信认领的：${claimed?.claimed_openid}`);
chk(Boolean(claimed?.claimed_teacher_id), '也记了 teacher_id（两个都要：行可能以后被注销清空）');

L('=== 已认领的位置不再出现在选择器里 ===');
const T2 = await newWx('b');
const left = (await usr('POST', '/auth/roster/options', T2, { code: codes[1], kindergarten_id: kgId })).data.entries;
chk(left.length === 3 && !left.some((e) => e.id === target.id),
  `🔴 只剩 3 个位置，被认领的那个不出现 —— 让她看到一个选不了的选项只会困惑`);

L('=== 同一个位置不能被认领两次（并发/她硬提交旧 id）===');
const stolen = await usr('POST', '/auth/redeem', T2, { code: codes[1], roster_entry_id: target.id });
chk(!stolen.ok, `已被认领的位置拒绝：${stolen.error?.message}`);
chk(/同事|已经有人/.test(stolen.error?.message || ''), '文案给出路：被同事选错了跟我们说一声');
chk(await codeStatus(codes[1]) === 'unused', '🔴 这一次也没消耗掉码');

L('=== 一个码只能兑一次 ===');
const reuse = await usr('POST', '/auth/redeem', T2, { code: codes[0], roster_entry_id: left[0].id });
chk(!reuse.ok, `用过的码被拒：${reuse.error?.message}`);
chk((await adm('GET', '/roster?status=pending')).data.items.some((r) => r.id === left[0].id),
  '失败的尝试没有把那个位置改坏');

L('=== 名单那一条作废之后不能被认领 ===');
const toVoid = left.find((e) => e.position === '保育员');
await adm('POST', `/roster/${toVoid.id}/void`);
const voided = await usr('POST', '/auth/redeem', T2, { code: codes[1], roster_entry_id: toVoid.id });
chk(!voided.ok, `作废的位置拒绝：${voided.error?.message}`);
chk(await codeStatus(codes[1]) === 'unused', '码还在');

L('=== 续兑：只要码，不用再选身份，身份一个字段都不动 ===');
const before = act.data.teacher;
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
// 她自己什么都不用做，下次进小程序就是新班级
const meNow = (await usr('GET', '/me', T1)).data;
chk(meNow.class_name === '中二班', `她的账号跟着更新了：${meNow.class_name}`);
const noMove = await adm('POST', `/roster/${moved.data.entry.id}/reassign`, { class_name: '中二班', position: '配班' });
chk(!noMove.ok, `什么都没变时不让挪：${noMove.error?.message}`);

L('=== 注销之后位置放回去（位置是园所的，不是她的）===');
const T3 = await newWx('c');
const openNow = (await usr('POST', '/auth/roster/options', T3, { code: codes[3], kindergarten_id: kgId })).data.entries;
const pick = openNow[0];
await usr('POST', '/auth/redeem', T3, { code: codes[3], roster_entry_id: pick.id });
await usr('DELETE', '/me', T3);
const back = (await adm('GET', '/roster?status=pending')).data.items.find((r) => r.id === pick.id);
chk(Boolean(back), '🔴 她注销之后那个位置放回「等她来认领」—— 明年这个班还有主班，只是换了人');
const rec = (await adm('GET', '/roster?status=pending')).data.items.find((r) => r.id === pick.id);
chk(Boolean(rec?.claimed_openid), '但「谁认领过」的历史留着（出争议时要查得到）');

L(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
