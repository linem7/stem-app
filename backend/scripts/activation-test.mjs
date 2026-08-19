/**
 * 激活链路：码 + 手机号（operations.md 第 1 节）
 *
 * 这是这一轮最容易写错的地方 —— 边界比功能多，而且错了的表现都是
 * 「老师进不来」，她只会在微信上说一句「用不了」，没有别的线索。
 *
 * 最要紧的一条：**校验失败不能消耗那个码**。她手打 11 位数字，
 * 打错一位是常事；打错一次废掉一个码，她就永远进不来了。
 *
 * 自造隔离数据，可反复跑。手机号全部是假号（138 + 时间戳）——
 * 🔴 真实手机号进库的前提是伦理审查 + 协议文案，见 CLAUDE.md
 */
const B = 'http://localhost:3000';
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
const phoneOf = (n) => `138${RND.slice(0, 5)}${String(n).padStart(3, '0')}`;
/** 开一个全新的微信（新 openid），拿它的 token */
const newWx = async (tag) => (await usr('POST', '/auth/login', null, { code: `dev:act_${RND}_${tag}` })).data.token;
/** 建一个匿名码 */
const mkCode = async (n = 1) =>
  (await adm('POST', '/codes/batch', { count: n, init_text: 20, init_image: 10, grant_reason: `激活回归 ${RND}` })).data.created;

A = (await adm('POST', '/login', { username: 'admin', password: '123456' })).data.token;

L('=== 准备：一份假名单 + 一池匿名码 ===');
const kgId = (await adm('GET', '/kindergartens')).data.items[0]?.id;
const roster = [
  `甲老师, ${phoneOf(1)}, 小一班, 主班, 小班`,
  `乙老师, ${phoneOf(2)}, 中二班, 配班, 中班`,
  `丙老师, ${phoneOf(3)}, 大三班, 主班, 大班`,
].join('\n');
const imp = await adm('POST', '/roster/import', { text: roster, kindergarten_id: kgId, dry_run: false });
chk(imp.ok && imp.data.imported === 3, `名单导入 3 个：${imp.data?.summary?.ok} 个认出来`);
const codes = await mkCode(6);
chk(codes.length === 6, `码池 ${codes.length} 个`);

L('=== 两把钥匙：码 + 手机号 ===');
const T1 = await newWx('a');
// 只给码不给手机号 —— 主路径必须两样都要
const noPhone = await usr('POST', '/auth/redeem', T1, { code: codes[0] });
chk(!noPhone.ok, `只给码不行：${noPhone.error?.message}`);
chk((await adm('GET', '/codes?status=unused')).data.items.some((c) => c.code === codes[0]),
  '🔴 那个码还是未使用 —— 缺手机号不能消耗掉它');

// 手机号打错一位（不在名单里）
const wrongPhone = await usr('POST', '/auth/redeem', T1, { code: codes[0], phone: `138${RND.slice(0, 5)}999` });
chk(!wrongPhone.ok, `号不在名单里被拒：${wrongPhone.error?.message}`);
chk(/名单里没有|打错/.test(wrongPhone.error?.message || ''), '文案说清了「可能是打错了，或者问园长」');
chk((await adm('GET', '/codes?status=unused')).data.items.some((c) => c.code === codes[0]),
  '🔴 打错手机号之后那个码仍然是未使用 —— 打错一次废一个码，她就永远进不来了');

// 两样都对
const good = await usr('POST', '/auth/redeem', T1, { code: codes[0], phone: phoneOf(1) });
chk(good.ok, `码 + 对的手机号 → 激活成功（kind=${good.data?.kind}）`);
chk(good.data.kind === 'activate', 'kind 回的是 activate');
chk(good.data.quota.text.left === 20, `首笔额度到账：${good.data?.quota?.text?.left}`);
// 身份从名单那一行搬过来
chk(good.data.teacher.class_name === '小一班' && good.data.teacher.age_group === '小班',
  `名单里的身份写进了账号：${good.data?.teacher?.class_name} / ${good.data?.teacher?.age_group}`);
chk(good.data.teacher.phone === undefined && good.data.teacher.real_name === undefined,
  '响应里没有 phone 和 real_name（永不下发前端那条铁律）');

L('=== 认领留痕：谁顶了谁的名额要查得到 ===');
const rlist = (await adm('GET', '/roster?status=claimed')).data.items;
const claimed = rlist.find((r) => r.phone === phoneOf(1));
chk(Boolean(claimed), '名单那一行变成 claimed');
chk(Boolean(claimed?.claimed_openid), `记下了是哪个微信认领的：${claimed?.claimed_openid}`);
chk(Boolean(claimed?.claimed_teacher_id), '也记了 teacher_id（两个都要：行可能以后被注销清空）');

L('=== 同一个号不能被认领两次 ===');
const T2 = await newWx('b');
const stolen = await usr('POST', '/auth/redeem', T2, { code: codes[1], phone: phoneOf(1) });
chk(!stolen.ok, `已被认领的号拒绝：${stolen.error?.message}`);
chk(/换绑/.test(stolen.error?.message || ''), '文案给出路：换了微信就找人要换绑码');
chk((await adm('GET', '/codes?status=unused')).data.items.some((c) => c.code === codes[1]),
  '🔴 这一次也没消耗掉码');

L('=== 一个码只能兑一次 ===');
const T3 = await newWx('c');
const reuse = await usr('POST', '/auth/redeem', T3, { code: codes[0], phone: phoneOf(2) });
chk(!reuse.ok, `用过的码被拒：${reuse.error?.message}`);
// 那个号还没被认领，所以名单那行必须还是 pending —— 别被一次失败的尝试改坏
chk((await adm('GET', '/roster?status=pending')).data.items.some((r) => r.phone === phoneOf(2)),
  '失败的尝试没有把名单那一行改坏');

L('=== 名单作废之后不能再激活 ===');
const rPending = (await adm('GET', '/roster?status=pending')).data.items.find((r) => r.phone === phoneOf(3));
await adm('POST', `/roster/${rPending.id}/void`);
const voided = await usr('POST', '/auth/redeem', T3, { code: codes[1], phone: phoneOf(3) });
chk(!voided.ok, `名单那行作废了 → 拒绝：${voided.error?.message}`);
chk((await adm('GET', '/codes?status=unused')).data.items.some((c) => c.code === codes[1]), '码还在');

L('=== 续兑：只要码，不问手机号，身份一个字段都不动 ===');
const before = good.data.teacher;
const top = await usr('POST', '/auth/redeem', T1, { code: codes[2] });
chk(top.ok && top.data.kind === 'topup', `已激活的老师兑新码 → kind=${top.data?.kind}`);
chk(top.data.quota.text.granted === 40, `额度累加：${top.data?.quota?.text?.granted}`);
const after = top.data.teacher;
chk(after.class_name === before.class_name && after.age_group === before.age_group
    && after.kindergarten_name === before.kindergarten_name,
  '身份一个字段都没变（续兑不该拿码上的信息去覆盖她的资料）');
// 名单里没有的号也能续兑 —— 因为续兑压根不看手机号
const top2 = await usr('POST', '/auth/redeem', T1, { code: codes[3], phone: '13800000000' });
chk(top2.ok, '续兑时传了个无关的手机号也没关系，后端不看');

L('=== 绑定码那条老路还通（名单外的个别情况）===');
const boundPhone = phoneOf(7);
const bc = await adm('POST', '/codes', { phone: boundPhone, real_name: '绑定码老师', kindergarten_id: kgId,
  class_name: '中一班', position: '主班', age_group: '中班', init_text: 5, init_image: 5 });
chk(bc.ok, `建绑定码 ${bc.data?.code}`);
const T4 = await newWx('d');
// 绑定码自带身份，不查名单 —— 这个号不在名单里也能激活
const bound = await usr('POST', '/auth/redeem', T4, { code: bc.data.code });
chk(bound.ok && bound.data.teacher.class_name === '中一班',
  `绑定码自带身份、不查名单：${bound.data?.teacher?.class_name}`);
// 但拿错码要拦住
const bc2 = await adm('POST', '/codes', { phone: phoneOf(8), real_name: '另一位', init_text: 5, init_image: 5 });
const T5 = await newWx('e');
const mismatch = await usr('POST', '/auth/redeem', T5, { code: bc2.data.code, phone: phoneOf(9) });
chk(!mismatch.ok, `绑定码 + 对不上的手机号被拒：${mismatch.error?.message}`);

L(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
