/**
 * xlsx 批量导入的回归（2026-08-21 新增）。
 *
 *   API_BASE=http://localhost:3100 node scripts/import-test.mjs
 *
 * 查的是「模板发下去、人在 Excel 里改过、再传回来」这条路上会出的事：
 * 挪列、删列、别名列头、枚举写歪、重名、空行、表头。
 *
 * 🔴 **为什么必须有这个脚本**：导入的失败模式几乎全是**静默**的。
 * 列头按位置认而不按内容认，错位之后「广东」被当成园所名字导进去 ——
 * 库里多了一个叫「广东」的园，不报错，看起来完全正常。
 * 枚举认不出来时静默留空同理：那个园从此收不到任何定向任务，
 * 而这件事只在园所页看得出来。
 *
 * 自造隔离数据（名字带时间戳），跑完自己清掉，可反复跑。
 * 不调模型，不花钱。
 */
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const BASE = (process.env.API_BASE || 'http://localhost:3000').replace(/\/$/, '');
const A = `${BASE}/admin/api`;
const RND = String(Date.now()).slice(-8);
const TAG = `导入回归_${RND}`;

let token = '';
let pass = 0;
const fails = [];

function check(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fails.push(`${name} —— ${e.message}`); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

async function call(method, path, body, raw = false) {
  const res = await fetch(A + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: j.ok, data: j.data, error: j.error };
}

/** 就地造一个 xlsx，返回 base64。列头和数据都由调用方给 —— 这才测得到「人改过模板」 */
async function makeXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('表');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

const section = (t) => console.log(`\n${t}`);

// ── 0. 登录 ──────────────────────────────────────────────────────
const login = await call('POST', '/login', { username: 'admin', password: '123456' });
if (!login.data?.token) {
  console.error(`登录失败（${BASE}）。后端起着吗？admin/123456 对吗？`, login.error || login.status);
  process.exit(1);
}
token = login.data.token;
console.log(`后端 ${BASE}，标记 ${TAG}`);

// ── 1. 两个模板本身 ──────────────────────────────────────────────
section('1. 模板下载');
for (const [path, want] of [['/kindergartens/template', '园所导入模板.xlsx'], ['/roster/template', '老师名单模板.xlsx']]) {
  const r = await call('GET', path, null, true);
  check(`${path} 回 200 且是合法 xlsx`, () => {
    assert.equal(r.status, 200);
    // .xlsx 是个 zip，头两字节必须是 PK
    assert.ok(r.buf[0] === 0x50 && r.buf[1] === 0x4b, `头两字节不是 PK：${r.buf.slice(0, 4).toString('hex')}`);
    assert.ok(r.buf.length > 3000, `文件太小：${r.buf.length}B`);
  });
  check(`${path} 的中文文件名没被 HTTP 头搞成乱码`, () => {
    const cd = r.headers.get('content-disposition') || '';
    // filename*=UTF-8'' 那一段才是中文名的正解；只有 filename= 时浏览器拿到的是乱码
    assert.ok(cd.includes("filename*=UTF-8''"), `缺 RFC 5987 文件名：${cd}`);
    assert.equal(decodeURIComponent(cd.split("''")[1]), want);
  });
}

{
  const r = await call('GET', '/roster/template', null, true);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const ws = wb.worksheets[0];
  check('名单模板有列头 + 至少两行示例', () => {
    // 空模板的下场：人填出来的「岗位」会是「班主任」这种，parseRoster 认不出来
    assert.ok(ws.rowCount >= 3, `只有 ${ws.rowCount} 行`);
  });
  check('名单模板冻结了首行', () => {
    assert.equal(ws.views?.[0]?.ySplit, 1);
  });
}

// ── 2. 名单：xlsx 和粘贴走同一个解析器 ───────────────────────────
section('2. 名单导入');
{
  const tpl = await call('GET', '/roster/template', null, true);
  const r = await call('POST', '/roster/import', { file_base64: tpl.buf.toString('base64'), dry_run: true });
  check('模板原样传回来，认出 2 个人、表头被跳过', () => {
    assert.equal(r.data.summary.ok, 2, JSON.stringify(r.data.summary));
    assert.equal(r.data.summary.invalid, 0);
  });
  check('行号对得上 Excel 里看到的行号', () => {
    // 表头在第 1 行，所以第一个人是第 2 行。对不上的话报错信息会指向错误的行
    assert.deepEqual(r.data.rows.map((x) => x.line), [2, 3]);
  });
}
{
  // 同一份数据，一份走 xlsx 一份走粘贴 —— 结果必须一致。
  // 这一条是文件头那段「只有一套认字段的规则」的断言：
  // 哪天有人为 xlsx 单写一份解析，这里会红
  const cells = [['姓名', '班级', '岗位', '年级'], ['甲小美', '小一班', '主班', '小班'], ['乙红', '中二班', '配班', '中班']];
  const viaFile = await call('POST', '/roster/import', { file_base64: await makeXlsx(cells), dry_run: true });
  const viaText = await call('POST', '/roster/import', { text: cells.map((r) => r.join('\t')).join('\n'), dry_run: true });
  check('xlsx 和粘贴文本解析结果完全一致', () => {
    assert.deepEqual(viaFile.data.summary, viaText.data.summary);
    assert.deepEqual(
      viaFile.data.rows.map((r) => [r.real_name, r.class_name, r.position, r.age_group, r.ok]),
      viaText.data.rows.map((r) => [r.real_name, r.class_name, r.position, r.age_group, r.ok])
    );
  });
}
{
  // 列挪了位置。parseRoster 按内容认，所以岗位在第一列也该认对
  const r = await call('POST', '/roster/import', {
    file_base64: await makeXlsx([['岗位', '姓名', '年级'], ['主班', '丙芳', '大班']]), dry_run: true,
  });
  check('名单的列挪了位置也认得出来', () => {
    const x = r.data.rows[0];
    assert.equal(x.ok, true, x.reason || '');
    assert.equal(x.real_name, '丙芳');
    assert.equal(x.position, '主班');
    assert.equal(x.age_group, '大班');
  });
}
{
  const r = await call('POST', '/roster/import', {
    file_base64: await makeXlsx([['姓名'], ['丁丽'], [], ['戊兰'], ['']]), dry_run: true,
  });
  check('中间的空行跳过而不是报错', () => {
    assert.equal(r.data.summary.ok, 2, JSON.stringify(r.data.summary));
  });
}

// ── 3. 园所：按列头认，不按列位认 ────────────────────────────────
section('3. 园所导入');
const KG_HEAD = ['园所名称', '省份', '城市', '城乡', '办园性质', '在园教师数', '在园幼儿数', '联系人', '联系电话', '备注'];
{
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([KG_HEAD,
      [`${TAG}甲`, '广东', '广州', '城市', '公办', 42, 310, '李园长', '', '备注一']]),
    dry_run: true,
  });
  check('中文枚举映射成库里的英文码', () => {
    const x = r.data.rows[0];
    assert.equal(x.ok, true, x.reason || '');
    assert.equal(x.area_type, 'city');
    assert.equal(x.ownership, 'public');
    assert.equal(x.teacher_count, 42);
    assert.equal(x.child_count, 310);
  });
}
{
  // 🔴 最关键的一条：**列被挪过**。
  // 按列位认的实现会把「广东」当成园所名字建出一个叫「广东」的园，不报错
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([
      ['序号', '省份', '园所名称', '办园性质', '城乡'],
      [1, '浙江', `${TAG}乙`, '民办', '农村'],
    ]),
    dry_run: true,
  });
  check('园所的列挪了位置、前面多一列序号，仍然认对', () => {
    const x = r.data.rows[0];
    assert.equal(x.ok, true, x.reason || '');
    assert.equal(x.name, `${TAG}乙`, `园所名字认成了「${x.name}」`);
    assert.equal(x.province, '浙江');
    assert.equal(x.ownership, 'private');
    assert.equal(x.area_type, 'rural');
  });
}
{
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([['幼儿园名称', '地市', '城乡性质'], [`${TAG}丙`, '深圳', '县镇']]),
    dry_run: true,
  });
  check('列头别名也认（幼儿园名称 / 地市 / 城乡性质）', () => {
    const x = r.data.rows[0];
    assert.equal(x.ok, true, x.reason || '');
    assert.equal(x.city, '深圳');
    assert.equal(x.area_type, 'county');
  });
}
{
  // 枚举写歪必须**整行拒绝**。静默留空的下场是这个园收不到定向任务
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([KG_HEAD, [`${TAG}丁`, '广东', '广州', '城区周边', '公办']]),
    dry_run: true,
  });
  check('城乡写成认不出的词 → 整行 invalid，不静默留空', () => {
    const x = r.data.rows[0];
    assert.equal(x.ok, false);
    assert.equal(x.duplicate, undefined);
    assert.match(x.reason, /城乡/);
    assert.equal(r.data.summary.invalid, 1, JSON.stringify(r.data.summary));
  });
}
{
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([KG_HEAD, [`${TAG}戊`, '广东', '广州', '城市', '股份制']]),
    dry_run: true,
  });
  check('办园性质写歪 → 整行 invalid', () => {
    assert.equal(r.data.rows[0].ok, false);
    assert.match(r.data.rows[0].reason, /办园性质/);
  });
}
{
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([['省份', '城市'], ['广东', '广州']]), dry_run: true,
  });
  check('第一行认不出园所名称那一列 → 400，而不是导进一堆空名字', () => {
    assert.equal(r.status, 400);
    assert.match(r.error?.message || '', /园所名称/);
  });
}
{
  /*
    🔴 反过来那一半：**一行普通数据不许被当成表头**（2026-08-22 用户报的真 bug）。

    原来的判据是「至少两格能在别名表里查到」—— 而一行**完全正常的数据**
    就能凑到两格：城乡那格填「城市」（同时也是 city 列的列头别名），
    备注那格填「备注」（note 的列头）。于是整行被当表头吃掉，
    接着报「认不出园所名称这一列」，而人只是粘了一行数据。

    这一条和上面那一条是**同一个函数的两个方向**，必须一起在：
    只顾一头的修法会把另一头换回来（我就是这么来回踩了一次）。
  */
  const r = await call('POST', '/kindergartens/import', {
    text: `${TAG}粘贴甲, 广东, 广州, 城市, 公办, 10, 60, 陈园长, , 2026-09-01, 备注`,
    dry_run: true,
  });
  check('粘一行数据（城乡=城市、备注=备注）不被误判成表头', () => {
    assert.equal(r.status, 200, JSON.stringify(r.error));
    assert.equal(r.data.summary.ok, 1, JSON.stringify(r.data.rows));
    assert.equal(r.data.rows[0].name, `${TAG}粘贴甲`);
    assert.equal(r.data.rows[0].area_type, 'city');
    assert.equal(r.data.rows[0].note, '备注');
  });
}
{
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([KG_HEAD, [`${TAG}己`], [`${TAG}己`], ['']]), dry_run: true,
  });
  check('同一份文件里重名 → 第二行标 duplicate（不是 invalid）', () => {
    assert.equal(r.data.summary.ok, 1, JSON.stringify(r.data.summary));
    assert.equal(r.data.summary.duplicate, 1);
    assert.equal(r.data.rows[1].duplicate, true);
  });
}
{
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([KG_HEAD, ['阳光幼儿园']]), dry_run: true,
  });
  check('库里已有的园 → duplicate，跳过不覆盖', () => {
    assert.equal(r.data.rows[0].duplicate, true);
    assert.equal(r.data.rows[0].ok, false);
  });
}
{
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([KG_HEAD, ['阳光幼儿园']]), dry_run: false,
  });
  check('一个都没认出来时不许真写（400）', () => {
    assert.equal(r.status, 400);
  });
}

// ── 4. 非 xlsx 的文件要给一句能看懂的话 ──────────────────────────
section('4. 传错文件');
for (const [name, payload, want] of [
  ['csv 当 xlsx 传', Buffer.from('姓名,班级\n王小美,小一班').toString('base64'), /xlsx/],
  ['空内容', '', /文件/],
]) {
  const r = await call('POST', '/roster/import', { file_base64: payload, dry_run: true });
  check(`${name} → 400 且报错能看懂`, () => {
    assert.equal(r.status, 400, `回的是 ${r.status}`);
    assert.match(r.error?.message || '', want);
  });
}
{
  // data URL 前缀（FileReader.readAsDataURL 会带上）要在服务端剥掉
  const tpl = await call('GET', '/roster/template', null, true);
  const r = await call('POST', '/roster/import', {
    file_base64: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${tpl.buf.toString('base64')}`,
    dry_run: true,
  });
  check('带 data URL 前缀也认', () => assert.equal(r.data.summary.ok, 2));
}

// ── 5. 真写一次，然后清掉 ────────────────────────────────────────
section('5. 真导入');
let createdIds = [];
{
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([KG_HEAD,
      [`${TAG}真甲`, '广东', '广州', '城市', '公办', 30, 200, '张园长', '', ''],
      [`${TAG}真乙`, '浙江', '杭州', '农村', '民办', 12, 80, '', '', '']]),
    dry_run: false,
  });
  check('真导入写进 2 行', () => {
    assert.equal(r.data.imported, 2, JSON.stringify(r.data.summary));
    createdIds = r.data.created.map((c) => c.id);
  });
  const list = await call('GET', '/kindergartens');
  check('列表里查得到，特征字段都落对了', () => {
    const k = list.data.items.find((x) => x.name === `${TAG}真乙`);
    assert.ok(k, '新导的园不在列表里');
    assert.equal(k.area_type, 'rural');
    assert.equal(k.ownership, 'private');
    assert.equal(k.child_count, 80);
  });
  const logs = await call('GET', '/logs?action=import_kindergartens');
  check('操作记录里有 import_kindergartens', () => {
    assert.ok((logs.data?.items || []).length > 0, '一条都没有');
  });
}

// ── 5.5 起始合作日期：**日期是这份表里唯一会自己变值的东西** ─────────
//
// 🔴 这一节盯的是**时区偏移**，08-22 真踩了：DATE 列被 pg 解析成「本地时区午夜」，
// 序列化成 JSON 就成了前一天的 UTC 时刻（东八区 2026-09-01 → "2026-08-31T16:00:00Z"），
// 前端一 slice(0,10) 就少一天。修法是 db/pool.js 里把 DATE（oid 1082）原样回字符串。
//
// 为什么值得一条断言：**差一天是不报错的**。日期照样显示、照样能排序，
// 只是每个园的合作起始日都早了一天；而任务的截止日期更糟 ——
// 编辑弹窗把前一天填回输入框，一保存就真的存成前一天，**每编辑一次退一天**。
section('5.5 起始合作日期不许自己偏一天');
{
  const DAY = '2026-09-01';
  const r = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([[...KG_HEAD, '起始合作日期'],
      [`${TAG}日期甲`, '广东', '广州', '城市', '公办', 10, 60, '', '', '', DAY],
      [`${TAG}日期乙`, '广东', '广州', '城市', '公办', 10, 60, '', '', '', '9月1号']]),
    dry_run: true,
  });
  check('认得出日期列，解析成 YYYY-MM-DD', () => {
    const row = r.data.rows.find((x) => x.name === `${TAG}日期甲`);
    assert.equal(row.cooperation_started_at, DAY, JSON.stringify(row));
  });
  // 跟城乡、办园性质同一条纪律：认不出来**整行拒绝**，不静默留空。
  // 静默留空的下场是这个园的起始合作永远是空的，而填表的人以为自己填了
  check('日期写歪整行拒绝，不静默留空', () => {
    const row = r.data.rows.find((x) => x.name === `${TAG}日期乙`);
    assert.equal(row.ok, false, '「9月1号」应该被拒');
    assert.match(row.reason || '', /起始合作日期/);
  });

  const w = await call('POST', '/kindergartens/import', {
    file_base64: await makeXlsx([[...KG_HEAD, '起始合作日期'],
      [`${TAG}日期丙`, '广东', '广州', '城市', '公办', 10, 60, '', '', '', DAY]]),
    dry_run: false,
  });
  check('真写进库', () => assert.equal(w.data.imported, 1));
  const list = await call('GET', '/kindergartens');
  check(`存进去是 ${DAY}，读回来还是 ${DAY}（不是前一天）`, () => {
    const k = list.data.items.find((x) => x.name === `${TAG}日期丙`);
    assert.equal(k.cooperation_started_at, DAY,
      `时区把日期挪了：${k.cooperation_started_at} —— 看 db/pool.js 里 oid 1082 那段`);
  });
  // 改一次再读回来：编辑往返也不许偏。任务截止日期就是这么被改坏的
  const kk = list.data.items.find((x) => x.name === `${TAG}日期丙`);
  await call('POST', `/kindergartens/${kk.id}/update`, { cooperation_started_at: DAY });
  const list2 = await call('GET', '/kindergartens');
  check('编辑往返一次也不偏', () => {
    const k = list2.data.items.find((x) => x.name === `${TAG}日期丙`);
    assert.equal(k.cooperation_started_at, DAY);
  });
}

// ── 6. 改自己的称呼 ──────────────────────────────────────────────
section('6. 个人信息');
{
  const before = (await call('GET', '/admins')).data.items.find((a) => a.username === 'admin');
  const r = await call('POST', '/me/profile', { display_name: `回归${RND}` });
  check('改称呼成功', () => assert.equal(r.data.admin.display_name, `回归${RND}`));

  // 🔴 用户名和角色在这个接口里改不了 —— 否则一般管理员能把自己提成超管
  const hack = await call('POST', '/me/profile', {
    display_name: `回归${RND}b`, role: 'admin', username: `hacked_${RND}`,
  });
  check('请求体里带 role / username 一律不看', () => {
    assert.equal(hack.data.admin.role, 'super', '角色被改动了');
    assert.equal(hack.data.admin.username, 'admin', '用户名被改动了');
  });
  const empty = await call('POST', '/me/profile', { display_name: '   ' });
  check('称呼不能是空的', () => assert.equal(empty.status, 400));

  await call('POST', '/me/profile', { display_name: before?.display_name || '超级管理员' });
}

// ── 7. 批量建码不再绑园所 ────────────────────────────────────────
section('7. 批量建码');
{
  const r = await call('POST', '/codes/batch', {
    count: 3, init_text: 5, init_image: 2, grant_reason: `导入回归 ${RND}`,
  });
  check('不传 kindergarten_id 也能建', () => assert.equal(r.data.created.length, 3));
  check('回的 batch.kindergarten 是 null（批量码不绑园）', () => {
    assert.equal(r.data.batch.kindergarten, null);
  });
  // 查单个码走 `/codes/items` —— `/codes` 2026-08-21 改成了「一行一次操作」，
  // 里面已经没有单个码了（019 迁移）
  const list = await call('GET', '/codes/items?status=unused');
  check('建出来的码确实没挂园所', () => {
    const mine = list.data.items.filter((c) => r.data.created.includes(c.code));
    assert.equal(mine.length, 3, `按码查到 ${mine.length} 个`);
    mine.forEach((c) => assert.equal(c.kindergarten, null, `${c.code} 挂着 ${c.kindergarten}`));
  });
  // 传了也不该报错，只是不生效 —— 前端老版本可能还在传
  const legacy = await call('POST', '/codes/batch', {
    count: 1, kindergarten_id: 1, grant_reason: `导入回归 ${RND}`,
  });
  check('老前端还传 kindergarten_id 时不报错，只是不生效', () => {
    assert.equal(legacy.status, 200);
    assert.equal(legacy.data.batch.kindergarten, null);
  });
}

// ── 8. 兑换码：一行一次操作 ──────────────────────────────────────
section('8. 兑换码按操作登记');
{
  // 2026-08-21（019 迁移）：`GET /codes` 从「一行一个码」改成「一行一次建码操作」。
  // 这一节原来验的是上一轮加的「谁兑的」那一列 —— 那一列在批次模型下没有意义了
  // （一次批量操作对应很多个兑换者），所以断言换成验新形状。
  const one = await call('POST', '/codes', { init_text: 6, init_image: 2, grant_reason: `批次回归 ${RND}` });
  const many = await call('POST', '/codes/batch', { count: 3, init_text: 6, init_image: 2, grant_reason: `批次回归 ${RND}` });
  const list = await call('GET', '/codes');
  const mine = list.data.items.filter((b) => b.grant_reason === `批次回归 ${RND}`);

  check('单张建码和批量建码各占一行', () => {
    assert.equal(mine.length, 2, `拿到 ${mine.length} 行`);
    assert.ok(mine.some((b) => b.kind === 'single' && b.total === 1), '缺单张那一行');
    assert.ok(mine.some((b) => b.kind === 'batch' && b.total === 3), '缺批量那一行');
  });
  check('已用张数是算出来的，一张都没兑时是 0', () => {
    mine.forEach((b) => assert.equal(b.used, 0, `${b.id} 的 used 是 ${b.used}`));
  });
  check('列表里没有单个码的字段了（那是 /codes/items 的事）', () => {
    assert.ok(!('code' in mine[0]), '批次行上还挂着 code');
  });

  const batchId = many.data.batch.id;
  const detail = await call('GET', `/codes/batches/${batchId}`);
  check('批次详情给出那一批的全部码，且跟建出来的一致', () => {
    assert.deepEqual(detail.data.codes, many.data.created);
  });
  check('详情里**不标**哪一张已被使用（用户明确说不需要）', () => {
    // 只是一个字符串数组。标注反而让人以为「已用的不用抄了」，
    // 而没收到的那个人可能正好拿的是已用的那一张
    assert.ok(detail.data.codes.every((c) => typeof c === 'string'));
  });

  const byCode = await call('GET', `/codes/items?code=${encodeURIComponent(one.data.code)}`);
  check('按单个码查得到状态（「她说码用不了」时要查的那条路）', () => {
    const hit = byCode.data.items.find((c) => c.code === one.data.code);
    assert.ok(hit, '查不到这个码');
    assert.equal(hit.status, 'unused');
  });

  const del = await call('POST', '/codes/batches/delete', { ids: mine.map((b) => b.id) });
  check('删操作：未兑的码跟着删，已兑的留下', () => {
    assert.equal(del.data.batches, 2);
    assert.equal(del.data.dropped, 4, `删了 ${del.data.dropped} 个码`);
    assert.equal(del.data.kept, 0);
  });
  const after = await call('GET', '/codes');
  check('删完这两行不在列表里了', () => {
    assert.equal(after.data.items.filter((b) => b.grant_reason === `批次回归 ${RND}`).length, 0);
  });
}

// ── 收尾：清掉这一轮造的数据 ──────────────────────────────────────
section('清理');
{
  const { query, closePool } = await import('../src/db/pool.js');
  const kg = await query(`DELETE FROM kindergartens WHERE name LIKE $1 RETURNING id`, [`${TAG}%`]);
  const codes = await query(`DELETE FROM redemption_codes WHERE grant_reason = $1 RETURNING id`, [`批次回归 ${RND}`]);
  const logs = await query(
    `DELETE FROM admin_logs WHERE action IN ('import_kindergartens','create_codes_batch',
                                            'update_own_profile','update_kindergarten')
       AND created_at > now() - interval '10 minutes' RETURNING id`);
  console.log(`  清掉 ${kg.rowCount} 个园、${codes.rowCount} 个码、${logs.rowCount} 条操作记录`);
  await closePool();
}

console.log(`\n${fails.length ? '✗' : '✓'} ${pass} 条通过${fails.length ? `，${fails.length} 条失败：` : ''}`);
fails.forEach((f) => console.log(`  · ${f}`));
process.exit(fails.length ? 1 : 0);
