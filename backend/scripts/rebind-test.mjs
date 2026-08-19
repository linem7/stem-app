/**
 * 换绑：她换了微信号（operations.md 第 1.7 节）
 *
 * 换绑存在的**唯一理由**是保住她的教案 —— 所以这个脚本最要紧的断言不是
 * 「换绑成功了」，而是「换绑之后教案、额度台账、记忆、已同意的协议一条都不少」。
 * 如果那些东西丢了，换绑不如不做（不如让她重新激活一个新账号，至少诚实）。
 *
 * 自造隔离数据，可反复跑。
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
const phoneOf = (n) => `139${RND.slice(0, 5)}${String(n).padStart(3, '0')}`;
const newWx = async (tag) => (await usr('POST', '/auth/login', null, { code: `dev:rb_${RND}_${tag}` })).data.token;
const mkCode = async () =>
  (await adm('POST', '/codes/batch', { count: 1, init_text: 20, init_image: 10, grant_reason: `换绑回归 ${RND}` })).data.created[0];

A = (await adm('POST', '/login', { username: 'admin', password: '123456' })).data.token;

L('=== 准备：一位有内容的老师（旧微信）===');
const kgId = (await adm('GET', '/kindergartens')).data.items[0]?.id;
await adm('POST', '/roster/import', { text: `换绑老师, ${phoneOf(1)}, 小一班, 主班, 小班`, kindergarten_id: kgId, dry_run: false });
const OLD = await newWx('old');
const act = await usr('POST', '/auth/redeem', OLD, { code: await mkCode(), phone: phoneOf(1) });
chk(act.ok, '旧微信激活成功');
await usr('POST', '/me/agree', OLD);
// 给她攒点东西：一条记忆 + 一次开会话（教案要真调模型太慢，会话足够证明「内容跟过来了」）
await usr('POST', '/memories', OLD, { fact: `换绑测试的记忆 ${RND}` });
const conv = await usr('POST', '/conversations', OLD, { seed_input: '我想做个影子的活动' });
chk(conv.ok, '旧微信开了一个会话');
const oldMe = (await usr('GET', '/me', OLD)).data;
const oldQuota = (await usr('GET', '/me/quota', OLD)).data;
const oldMem = (await usr('GET', '/memories', OLD)).data.items.length;
const teacherId = oldMe.id;
L(`    旧账号 #${teacherId}：额度 ${oldQuota.quota.text.granted}、记忆 ${oldMem} 条、已同意协议 ${oldMe.agreed}`);

L('=== 生成换绑码：重复点只给同一把钥匙 ===');
const r1 = await adm('POST', `/teachers/${teacherId}/rebind-code`);
chk(r1.ok && r1.data.code, `生成了 ${r1.data?.code}，${String(r1.data?.expires_at).slice(0, 10)} 过期`);
chk(r1.data.reused === false, '第一次是新生成的');
const r2 = await adm('POST', `/teachers/${teacherId}/rebind-code`);
chk(r2.data.code === r1.data.code && r2.data.reused === true,
  '🔴 再点一次返回同一把 —— 否则外面同时有两把能接管她账号的钥匙');
chk((await adm('GET', `/teachers/${teacherId}`)).data.pending_rebind?.code === r1.data.code,
  '老师详情带出这把待用的钥匙（界面要显示它，而不是又生成一把）');

L('=== 新微信上不空 → 拒绝，且它的数据一条都没被删 ===');
const DIRTY = await newWx('dirty');
await usr('POST', '/auth/redeem', DIRTY, { code: await mkCode() })
  .catch(() => {});   // 它没激活也没名单，这一步大概会失败，不影响下面
// 造一点「不空」：给它兑一个绑定码，就有额度台账了
const bcode = await adm('POST', '/codes', { phone: phoneOf(9), real_name: '脏账号', init_text: 3, init_image: 3 });
await usr('POST', '/auth/redeem', DIRTY, { code: bcode.data.code });
const dirtyBefore = (await usr('GET', '/me/quota', DIRTY)).data.quota.text.granted;
const dirtyTry = await usr('POST', '/auth/redeem', DIRTY, { code: r1.data.code });
chk(!dirtyTry.ok, `新微信上已经有内容 → 拒绝：${dirtyTry.error?.message}`);
chk((await usr('GET', '/me/quota', DIRTY)).data.quota.text.granted === dirtyBefore,
  '🔴 被拒之后它自己的额度一分没少（拒绝不能顺手删东西）');
chk((await adm('GET', `/teachers/${teacherId}`)).data.pending_rebind?.code === r1.data.code,
  '失败的尝试没有把那把钥匙用掉');

L('=== 真换绑：教案额度记忆协议一条都不少 ===');
const NEW = await newWx('new');
// **不传手机号**。这一条盯的是界面上踩到的坑：换绑发生在一个全新的微信上，
// 她落在「首次激活」那一屏、手上却是换绑码 —— 没有手机号要填。
// 第一版把手机号设成了必填，按钮永远是灰的，换绑在界面上直接被堵死。
// 所以接口这边必须接受「只有码、没有手机号」的换绑请求
const rb = await usr('POST', '/auth/redeem', NEW, { code: r1.data.code });
chk(rb.ok && rb.data.kind === 'rebind', `换绑成功（kind=${rb.data?.kind}）`);
chk(Boolean(rb.data.token), '🔴 回了新 token —— 她手上那个 JWT 指向刚被删掉的行，不换就 401');
const NEWTOKEN = rb.data.token;
chk(rb.data.teacher.id === teacherId, `还是同一个账号 #${rb.data?.teacher?.id}`);
chk(rb.data.teacher.agreed === true, '已同意的协议保留 —— 她不用再签一遍');

const me2 = (await usr('GET', '/me', NEWTOKEN)).data;
const q2 = (await usr('GET', '/me/quota', NEWTOKEN)).data;
const mem2 = (await usr('GET', '/memories', NEWTOKEN)).data.items.length;
const conv2 = (await usr('GET', '/conversations', NEWTOKEN)).data.items.length;
chk(q2.quota.text.granted === oldQuota.quota.text.granted, `额度台账没变：${q2.quota.text.granted}`);
chk(mem2 === oldMem, `记忆还在：${mem2} 条`);
chk(conv2 >= 1, `会话还在：${conv2} 个`);
chk(me2.class_name === oldMe.class_name, `身份没变：${me2.class_name}`);

L('=== 旧设备当场失去访问（token_version，015 迁移）===');
// 这一条第一版是错的，而错法值得记下来：换绑是把 openid 挪到**旧那一行**上，
// 所以旧 token（payload 只有 teacher_id）指向的行还在、status 还是 active ——
// requireAuth 那道「非 active 就拒」拦不住它，旧设备能再用满 30 天。
// 而换绑的常见起因之一就是手机丢了。所以加了 token_version：换绑时 +1。
const oldNow = await usr('GET', '/me', OLD);
chk(!oldNow.ok && oldNow.status === 401,
  `🔴 旧 token 当场失效：${oldNow.error?.message || oldNow.status}`);
chk((await usr('GET', '/me', NEWTOKEN)).ok, '新 token 正常能用');

L('=== 同一个换绑码不能用第二次 ===');
const NEW2 = await newWx('new2');
const again = await usr('POST', '/auth/redeem', NEW2, { code: r1.data.code });
chk(!again.ok, `用过的换绑码被拒：${again.error?.message}`);

L('=== 换绑留痕：谁把哪个账号挪给了哪个微信 ===');
const logs = (await adm('GET', '/logs?action=create_rebind_code')).data;
chk(logs.total > 0, `操作记录里有 ${logs.total} 条「生成换绑码」`);

L('=== 注销过的账号不能被换绑回来（那会绕过注销）===');
const DEL = await newWx('del');
const delPhone = phoneOf(5);
await adm('POST', '/roster/import', { text: `注销老师, ${delPhone}, 中一班, 主班, 中班`, kindergarten_id: kgId, dry_run: false });
await usr('POST', '/auth/redeem', DEL, { code: await mkCode(), phone: delPhone });
const delId = (await usr('GET', '/me', DEL)).data.id;
const rbDel = await adm('POST', `/teachers/${delId}/rebind-code`);   // 先拿一把钥匙
await usr('DELETE', '/me', DEL);                                    // 再注销
const afterDel = await usr('POST', '/auth/redeem', await newWx('afterdel'), { code: rbDel.data.code });
chk(!afterDel.ok, `注销过的账号换绑被拒：${afterDel.error?.message}`);
// 给一个已注销的账号生成新钥匙也该拦住
const rbDel2 = await adm('POST', `/teachers/${delId}/rebind-code`);
chk(!rbDel2.ok, `给已注销的账号生成换绑码被拒：${rbDel2.error?.message}`);

L('=== 作废换绑码 ===');
const T9 = await newWx('void');
const rbv = await adm('POST', `/teachers/${rb.data.teacher.id}/rebind-code`);
const rows = (await adm('GET', `/teachers/${rb.data.teacher.id}`)).data.pending_rebind;
const voided = await adm('POST', `/rebind-codes/${rows.id}/void`);
chk(voided.ok, '能作废');
chk(!(await usr('POST', '/auth/redeem', T9, { code: rbv.data.code })).ok, '作废之后用不了');

L(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
