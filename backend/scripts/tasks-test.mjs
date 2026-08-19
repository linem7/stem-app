/**
 * 发任务：定向匹配的边界（operations.md 第 6.5 节）
 *
 * 这一轮最容易写错的地方就是定向 —— 而错了的表现**不会报错**：
 *   · 定向写宽了 → 发给了不该发的人，只有她们困惑
 *   · 定向写窄了 → 该收到的人没收到，我以为没人愿意做
 *   · 试算和实际不一致 → 「后台说发给 12 个人，实际只有 8 个人看到」
 *
 * 所以这个脚本盯三件事：
 *   1. 六个维度各自筛得准，**叠加是 AND**
 *   2. **空数组 = 不限**，而拼错的维度名不能悄悄让定向变宽
 *   3. **试算的人数 = 老师端实际拿到的人数**（两边共用同一个谓词）
 *
 * 自造隔离数据（三个特征不同的园 + 五位老师），可反复跑。
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
A = (await adm('POST', '/login', { username: 'admin', password: '123456' })).data.token;

L('=== 准备：三个特征不同的园 + 五位老师 ===');
/**
 * 建一个园并填上特征。
 *
 * ⚠️ **省市名字带上 RND**。第一版用的是真省市名（广东/浙江），
 * 于是「发给广东的农村园」会连上几轮留下的园一起命中 ——
 * 断言写成绝对人数（`=== 2`）就永远对不上，而这是个**会随轮次变化的红**，
 * 跟 roles-test 里那条「每位老师都有手机号」是同一类错。
 * 省市做成本轮独有，人数才是可断言的。
 */
async function mkKg(tag, p) {
  const kg = await adm('POST', '/kindergartens', { name: `任务园${tag}_${RND}`, ...p });
  return kg.data.id;
}
const PROV_GD = `粤${RND}`;
const PROV_ZJ = `浙${RND}`;
const gdRural = await mkKg('粤农', { province: PROV_GD, city: `穗${RND}`, area_type: 'rural', ownership: 'public' });
const gdCity = await mkKg('粤城', { province: PROV_GD, city: `深${RND}`, area_type: 'city', ownership: 'private' });
const zjCity = await mkKg('浙城', { province: PROV_ZJ, city: `杭${RND}`, area_type: 'city', ownership: 'public' });

/**
 * 名单 + 码 + 激活，返回她的 token。
 *
 * ⚠️ `slug` 必须是 **ASCII**。`dev:` 假登录把 openid 里的非
 * `[a-zA-Z0-9_-]` 字符全部剥掉（见 services/wechat.js），
 * 所以用中文当 tag 会让所有人**塌成同一个 openid** ——
 * 于是「五位老师」其实是一个账号，测出来的结果看着随机、查半天。
 * 第一版就是这么错的。名字用中文（可读），openid 用 slug（ASCII）。
 */
async function mkTeacher(slug, name, kgId, cls, age) {
  const imp = await adm('POST', '/roster/import',
    // 名字带上 RND：回归脚本要能反复跑，上一轮留下的名单不该让这一轮变成 duplicate
    { text: `${name}${RND}, ${cls}, 主班, ${age}`, kindergarten_id: kgId, dry_run: false });
  if (!imp.ok) throw new Error(`导名单 ${name} 失败：${imp.error?.message}`);
  const code = (await adm('POST', '/codes/batch',
    { count: 1, init_text: 20, init_image: 10, grant_reason: `任务回归 ${RND}` })).data.created[0];
  const tok = (await usr('POST', '/auth/login', null, { code: `dev:tk${RND}${slug}` })).data.token;
  const r = await usr('POST', '/auth/redeem', tok, { code, roster_entry_id: imp.data.created[0].id });
  if (!r.ok) throw new Error(`造老师 ${name} 失败：${r.error?.message}`);
  await usr('POST', '/me/agree', tok);
  return tok;
}
const 粤农小 = await mkTeacher('a', '任务粤农小', gdRural, '小一班', '小班');
const 粤农中 = await mkTeacher('b', '任务粤农中', gdRural, '中二班', '中班');
const 粤城小 = await mkTeacher('c', '任务粤城小', gdCity, '小一班', '小班');
const 浙城大 = await mkTeacher('d', '任务浙城大', zjCity, '大三班', '大班');
// 没有园所的老师：名单里没填园所（kindergarten_id 传 null）
const 无园 = await mkTeacher('e', '任务无园', null, '小一班', '小班');
chk(true, '五位老师就位：粤农小 / 粤农中 / 粤城小 / 浙城大 / 无园');
// 确认她们真是五个不同的账号 —— 上面那个 openid 的坑值得一条断言盯着
const ids = [];
for (const tok of [粤农小, 粤农中, 粤城小, 浙城大, 无园]) {
  ids.push((await usr('GET', '/me', tok)).data.id);
}
chk(new Set(ids).size === 5, `🔴 五个不同的账号（id ${ids.join('/')}）—— openid 塌成一个的话下面全是假结果`);

/** 发一个任务，返回 id 和试算人数 */
async function publish(title, target) {
  const t = await adm('POST', '/tasks', {
    title: `${title} ${RND}`, body: '填完这份问卷，我会给你发一个兑换码。',
    survey_url: 'https://www.wjx.cn/vm/test.aspx',
    reward_text: 20, reward_image: 10, target,
  });
  const pre = await adm('POST', '/tasks/preview', { target });
  const pub = await adm('POST', `/tasks/${t.data.id}/publish`);
  return { id: t.data.id, preview: pre.data.teachers, published: pub.data.covers, target: pre.data.target };
}
/** 她能不能看到这个任务 */
const sees = async (tok, id) =>
  (await usr('GET', '/tasks', tok)).data.items.some((x) => x.id === id);

L('=== 一个维度：按省份 ===');
const t1 = await publish('只发广东', { provinces: [PROV_GD] });
chk(await sees(粤农小, t1.id) && await sees(粤城小, t1.id), '广东两个园的老师都收到');
chk(!(await sees(浙城大, t1.id)), '浙江那位收不到');
chk(!(await sees(无园, t1.id)), '🔴 没有园所的老师收不到园所相关的定向 —— 这是对的，但要记住');

L('=== 叠加是 AND：广东 + 农村 ===');
const t2 = await publish('广东农村园', { provinces: [PROV_GD], area_types: ['rural'] });
chk(await sees(粤农小, t2.id) && await sees(粤农中, t2.id), '广东农村园两位都收到');
chk(!(await sees(粤城小, t2.id)), '🔴 广东但是城市的收不到（AND 不是 OR）');
chk(!(await sees(浙城大, t2.id)), '浙江的收不到');

L('=== 三维叠加：广东 + 城市 + 民办 ===');
const t3 = await publish('广东城市民办', { provinces: [PROV_GD], area_types: ['city'], ownerships: ['private'] });
chk(await sees(粤城小, t3.id), '只有粤城那位命中');
chk(!(await sees(粤农小, t3.id)) && !(await sees(浙城大, t3.id)), '另外两位都不命中');

L('=== 按年龄班（跨园）===');
const t4 = await publish('只发小班老师', { age_groups: ['小班'] });
chk(await sees(粤农小, t4.id) && await sees(粤城小, t4.id), '两个园的小班老师都收到');
chk(!(await sees(粤农中, t4.id)) && !(await sees(浙城大, t4.id)), '中班大班收不到');
chk(await sees(无园, t4.id), '🔴 没有园所的老师**收得到**只按年龄班定向的任务（这一维不碰园所）');

L('=== 按具体园所 ===');
const t5 = await publish('只发这一个园', { kindergarten_ids: [zjCity] });
chk(await sees(浙城大, t5.id), '那个园的老师收到');
chk(!(await sees(粤农小, t5.id)), '别的园收不到');

L('=== 六维全空 = 发给所有人 ===');
const t6 = await publish('发给所有人', {});
chk(t6.target && Object.values(t6.target).every((v) => v.length === 0), '规范化之后六个维度都是空数组');
for (const [n, tok] of [['粤农小', 粤农小], ['粤城小', 粤城小], ['浙城大', 浙城大], ['无园', 无园]]) {
  chk(await sees(tok, t6.id), `${n} 收到`);
}

L('=== 拼错的维度名不能悄悄让定向变宽 ===');
const t7 = await publish('拼错维度', { province: [PROV_GD], areatype: ['rural'] });   // 少了 s / 少了下划线
chk(Object.values(t7.target).every((v) => v.length === 0),
  '🔴 不认识的键被丢掉了 —— 但要注意：它于是变成「发给所有人」');
chk(t7.preview > 4, `所以覆盖人数是全部（${t7.preview} 位）—— 界面上必须显眼地说「这会发给所有人」`);

L('=== 试算的人数 = 老师端实际拿到的人数（两边共用同一个谓词）===');
for (const [name, id, toks] of [
  ['只发广东', t1.id, [粤农小, 粤农中, 粤城小]],
  ['广东农村', t2.id, [粤农小, 粤农中]],
  ['只发小班', t4.id, [粤农小, 粤城小, 无园]],
]) {
  const seen = [];
  for (const tok of toks) if (await sees(tok, id)) seen.push(1);
  chk(seen.length === toks.length, `${name}：我造的 ${toks.length} 位应收的全都收到了`);
}
const pre1 = await adm('POST', '/tasks/preview', { target: { provinces: [PROV_GD], area_types: ['rural'] } });
chk(pre1.data.teachers === 2, `🔴 试算说 ${pre1.data.teachers} 位 —— 跟上面实收的人数对得上`);
chk(pre1.data.sample.every((s) => /老师|未填/.test(s.surname)), '试算样本只给姓氏');
chk(pre1.data.unrestricted === false, '试算告诉界面「这个定向有限制」');
chk((await adm('POST', '/tasks/preview', { target: {} })).data.unrestricted === true,
  '六维全空时 unrestricted=true —— 界面靠它警告「这会发给所有人」');

L('=== 草稿老师看不到；收了之后也看不到 ===');
const draft = await adm('POST', '/tasks', { title: `草稿 ${RND}`, reward_text: 5 });
chk(!(await sees(粤农小, draft.data.id)), '🔴 草稿老师看不到（编到一半不该让人看见）');
await adm('POST', `/tasks/${t5.id}/close`);
chk(!(await sees(浙城大, t5.id)), '收了之后就不出现了');

L('=== 截止日期：当天还算，过期不出现，过期的也不许发布 ===');
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const t8 = await publish('今天截止', { kindergarten_ids: [gdRural] });
await adm('POST', `/tasks/${t8.id}/update`, { deadline: today });
chk(await sees(粤农小, t8.id), '🔴 今天截止的任务今天还看得到（写成 < 就会当天消失）');
await adm('POST', `/tasks/${t8.id}/update`, { deadline: yesterday });
chk(!(await sees(粤农小, t8.id)), '过了截止日期就不出现');
const expired = await adm('POST', '/tasks', { title: `过期发布 ${RND}`, deadline: yesterday });
const pubExpired = await adm('POST', `/tasks/${expired.data.id}/publish`);
chk(!pubExpired.ok, `🔴 过期的不许发布：${pubExpired.error?.message}（否则是「发布成功但没人收到」）`);

L('=== 未读计数与标已读 ===');
const list = await usr('GET', '/tasks', 粤农中);
chk(list.data.unread === list.data.items.filter((x) => x.unread).length,
  `unread=${list.data.unread} 跟逐条数出来的一致（首页那条条带靠它决定出不出现）`);
chk(list.data.unread > 0, '有未读');
const one = list.data.items[0];
chk((await usr('POST', `/tasks/${one.id}/read`, 粤农中)).ok, '标已读');
const after = await usr('GET', '/tasks', 粤农中);
chk(after.data.unread === list.data.unread - 1, `未读少了一条：${list.data.unread} → ${after.data.unread}`);
chk((await usr('POST', `/tasks/${one.id}/read`, 粤农中)).ok, '重复标已读不报错（复合主键防重）');
chk(!(await usr('POST', '/tasks/99999999/read', 粤农中)).ok, '乱填的 id 标不了（不写脏数据）');

L('=== 问卷链接要能点开 ===');
const badUrl = await adm('POST', '/tasks', { title: `坏链接 ${RND}`, survey_url: '见群里' });
chk(!badUrl.ok, `不是 http(s) 的拒掉：${badUrl.error?.message}`);
chk(one.survey_url.startsWith('https://'), '正常任务带得出链接');
chk(typeof one.days_left === 'number' || one.days_left === null,
  `带「剩几天」：${one.days_left}（她判断今天来不来得及靠这个，不是靠一个日期）`);

L('=== 管理端列表带覆盖人数和已读数 ===');
const admList = (await adm('GET', '/tasks')).data.items;
const mine = admList.find((x) => x.id === t2.id);
chk(mine && mine.covers === 2, `列表带覆盖人数：${mine?.covers}`);
chk(admList.find((x) => x.id === one.id)?.reads >= 1, '也带已读数（不然那一页只是一堆标题）');

L(fail ? `\n✗ ${fail} 项失败` : '\n✓ 全部通过');
process.exit(fail ? 1 : 0);
