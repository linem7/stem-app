/* 管理后台前端。原生 JS，无构建步骤 —— 这个后台只有一个人用，
   为它引一套打包工具链不值得。 */

const API = '/admin/api';
const app = document.getElementById('app');
const S = {
  token: localStorage.getItem('admin_token') || null,
  me: JSON.parse(localStorage.getItem('admin_me') || 'null'),   // { id, username, role, display_name }
  page: 'overview',
  data: {},
  loading: false,
  modal: null,
  filter: { kg: '', q: '', codeStatus: 'all', fbKind: 'all' },
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '—');

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2600);
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => ({ ok: false, error: { message: '响应不是 JSON' } }));
  if (res.status === 401) { S.token = null; localStorage.removeItem('admin_token'); render(); throw new Error('登录过期'); }
  if (!res.ok || j.ok === false) throw new Error(j.error?.message || '出错了');
  return j.data;
}

/* ============ 登录 ============ */
function loginView() {
  return `<div class="login"><div class="box">
    <h1>STEAM 教案助手 · 管理后台</h1>
    <p>老师的登录进不来这里。</p>
    <input id="usr" type="text" placeholder="用户名" autocomplete="username" autofocus
      onkeydown="if(event.key==='Enter')document.getElementById('pwd').focus()">
    <input id="pwd" type="password" placeholder="密码" autocomplete="current-password"
      style="margin-top:10px" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="btn" onclick="doLogin()">进入</button>
  </div></div>`;
}
window.doLogin = async () => {
  const username = document.getElementById('usr').value.trim();
  const password = document.getElementById('pwd').value;
  try {
    const d = await api('POST', '/login', { username, password });
    S.token = d.token; S.me = d.admin;
    localStorage.setItem('admin_token', d.token);
    localStorage.setItem('admin_me', JSON.stringify(d.admin));
    S.page = 'overview'; await load();
  } catch (e) { toast(e.message); }
};
const isSuper = () => S.me?.role === 'super';

/* ============ 框架 ============ */
const PAGES = {
  overview: '概览',
  teachers: '老师',
  codes: '兑换码',
  kindergartens: '园所',
  feedback: '反馈',
};
/** 只有超级管理员看得到的页 */
const SUPER_PAGES = { imagemodels: '配图模型', admins: '管理员', logs: '操作记录' };

function shell(inner) {
  const n = S.data.overview?.feedback_new || 0;
  return `<div class="wrap">
    <div class="side">
      <div class="brand">STEAM 教案助手<small>管理后台</small></div>
      ${Object.entries(PAGES).map(([k, v]) => `
        <button class="nav ${S.page === k ? 'on' : ''}" onclick="goto('${k}')">${v}
          ${k === 'feedback' && n ? `<span class="badge">${n}</span>` : ''}</button>`).join('')}
      ${isSuper() ? `<div class="navsec">超级管理员</div>
        ${Object.entries(SUPER_PAGES).map(([k, v]) => `
          <button class="nav ${S.page === k ? 'on' : ''}" onclick="goto('${k}')">${v}</button>`).join('')}` : ''}
      <div class="who">
        ${esc(S.me?.display_name || S.me?.username || '')}
        <span class="pill ${isSuper() ? 'p-warn' : 'p-off'}">${isSuper() ? '超级管理员' : '一般管理员'}</span>
        <button class="lnk" onclick="openChangePwd()">改密码</button>
        <button class="lnk" onclick="logout()">退出</button>
      </div>
    </div>
    <div class="main">${inner}</div>
  </div>${S.modal || ''}`;
}
window.goto = async (p) => { S.page = p; S.modal = null; await load(); };
window.logout = () => {
  S.token = null; S.me = null;
  localStorage.removeItem('admin_token'); localStorage.removeItem('admin_me');
  render();
};
window.closeModal = () => { S.modal = null; render(); };

/* ============ 概览 ============ */
function overviewView() {
  const o = S.data.overview || {};
  const q = o.quality || {};
  const rated = (q.usable || 0) + (q.needs_edit || 0) + (q.unusable || 0);
  const yuan = ((o.cost_cents_month || 0) / 100).toFixed(2);

  // 要处理的事排在最前面。累计数看一眼就没用了，待办才决定你今天做什么
  const todo = [
    o.feedback_new ? `<b>${o.feedback_new}</b> 条反馈没看` : '',
    o.gen_failed_7d ? `<b>${o.gen_failed_7d}</b> 次生成失败（近 7 天）` : '',
    o.images_failed_7d ? `<b>${o.images_failed_7d}</b> 张配图失败（近 7 天）` : '',
    (o.codes_unused ?? 0) < 5 ? `没用的兑换码只剩 <b>${o.codes_unused ?? 0}</b> 个，该批量建一批了` : '',
    (o.low_quota || []).length ? `<b>${o.low_quota.length}</b> 位老师额度快用完` : '',
  ].filter(Boolean);

  const cards = [
    ['plans_today', '今天写的教案'], ['images_today', '今天的配图'],
    ['active_7d', '7 天活跃老师'], ['plans_7d', '7 天教案'],
    ['teachers', '激活的老师'],
  ];

  return `<h2>概览</h2><div class="sub">这些数只有你看得到</div>
    ${todo.length
      ? `<div class="note" style="background:var(--amber-soft)"><b>要处理</b><br>${todo.join('<br>')}</div>`
      : '<div class="note"><b>没有待处理的事</b></div>'}
    <div class="stats">${cards.map(([k, l]) =>
      `<div class="stat"><div class="n">${o[k] ?? '—'}</div><div class="l">${l}</div></div>`).join('')}
      <div class="stat"><div class="n">￥${yuan}</div><div class="l">本月配图成本</div></div>
    </div>

    <div class="row" style="align-items:flex-start;gap:16px">
      <div style="flex:1;min-width:260px">
        <div class="sub" style="margin-bottom:8px"><b>教案能不能直接用</b>（老师自己标的）</div>
        ${rated
          ? `<table><tr><th>直接能用</th><th>改改能用</th><th>用不了</th></tr>
             <tr><td class="num">${q.usable}</td><td class="num">${q.needs_edit}</td>
             <td class="num ${q.unusable > q.usable ? 'low' : ''}">${q.unusable}</td></tr></table>`
          : '<div class="empty" style="padding:18px">还没有人评价过 —— 这是产品最大的未知数，有了数据第一时间看这里</div>'}
      </div>
      <div style="flex:1;min-width:260px">
        <div class="sub" style="margin-bottom:8px"><b>额度快用完的老师</b></div>
        ${(o.low_quota || []).length
          ? `<table>${o.low_quota.map((t) =>
              `<tr><td>${esc(t.name || '—')}</td><td>${esc(t.kindergarten || '—')}</td>
               <td class="num low">还剩 ${t.text_left} 次</td>
               <td><button class="btn-sm" onclick="goto('teachers')">去发额度</button></td></tr>`).join('')}</table>`
          : '<div class="empty" style="padding:18px">都还够用</div>'}
      </div>
    </div>

    <div class="sub" style="margin:18px 0 8px"><b>最近写的</b></div>
    ${(o.recent_plans || []).length
      ? `<table>${o.recent_plans.map((p) =>
          `<tr><td>${esc(p.title || '未命名')}</td><td>${esc(p.age_group || '—')}</td>
           <td>${esc(p.kindergarten || '—')}</td><td>${fmtDate(p.created_at)}</td></tr>`).join('')}</table>`
      : '<div class="empty">还没有人写过教案</div>'}`;
}

/* ============ 老师 ============ */
function teachersView() {
  const items = S.data.teachers?.items || [];
  const kgs = S.data.kindergartens?.items || [];
  return `<h2>老师</h2><div class="sub">共 ${items.length} 位已激活。批量码激活的老师没有手机号，按<b>兑换码</b>找她</div>
    <div class="row">
      <input type="text" id="q" placeholder="搜手机号 / 姓名 / 兑换码" value="${esc(S.filter.q)}"
        onkeydown="if(event.key==='Enter')doSearch()" style="width:200px">
      <select id="kg" onchange="doSearch()">
        <option value="">全部园所</option>
        ${kgs.map((k) => `<option value="${k.id}" ${S.filter.kg == k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}
      </select>
      <button class="btn-sm" onclick="doSearch()">搜索</button>
    </div>
    ${items.length ? `<table>
      <tr><th>姓名</th><th>手机号 / 兑换码</th><th>园所</th><th>班级 / 岗位</th>
          <th>教案额度</th><th>配图额度</th><th>最近登录</th><th></th></tr>
      ${items.map((t) => `<tr>
        <td>${esc(t.real_name || '—')} ${t.status === 'disabled' ? '<span class="pill p-off">已停用</span>' : ''}</td>
        <td class="mono">${t.phone_masked ? esc(t.phone_masked) : esc(t.redeem_code || '—')}</td>
        <td>${esc(t.kindergarten || '—')}</td>
        <td>${esc(t.class_name || '—')} · ${esc(t.position || '—')}</td>
        <td class="num ${t.quota.text.left <= 2 ? 'low' : ''}">${t.quota.text.left} / ${t.quota.text.granted}</td>
        <td class="num ${t.quota.image.left <= 2 ? 'low' : ''}">${t.quota.image.left} / ${t.quota.image.granted}</td>
        <td>${fmtDate(t.last_login_at)}</td>
        <td><button class="btn-sm" onclick="openTeacher(${t.id})">详情</button></td>
      </tr>`).join('')}
    </table>` : `<div class="empty">没有符合条件的老师</div>`}`;
}
window.doSearch = async () => {
  S.filter.q = document.getElementById('q')?.value || '';
  S.filter.kg = document.getElementById('kg')?.value || '';
  await load();
};

window.openTeacher = async (id) => {
  try {
    const d = await api('GET', `/teachers/${id}`);
    const t = d.teacher;
    S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
      <h3>${esc(t.real_name || '—')}　<span class="mono" style="font-size:14px;font-weight:400;color:var(--ink-2)">${esc(t.phone || '—')}</span></h3>
      <div class="sub" style="margin-bottom:14px">
        ${esc(t.kindergarten || '—')} · ${esc(t.class_name || '—')} · ${esc(t.position || '—')} · ${esc(t.age_group || '—')}<br>
        激活于 ${fmtDate(t.activated_at)}，最近登录 ${fmtDate(t.last_login_at)}
      </div>

      <div class="card">
        <b>额度</b>　教案 ${d.quota.text.left} / ${d.quota.text.granted}　·　配图 ${d.quota.image.left} / ${d.quota.image.granted}
        <div class="grid2" style="margin-top:12px">
          <div class="field"><label>加教案次数</label><input type="number" id="gt" value="20"></div>
          <div class="field"><label>加配图张数</label><input type="number" id="gi" value="10"></div>
        </div>
        <div class="field"><label>原因（必填，会存进台账）</label>
          <input type="text" id="gr" placeholder="例：完成 9 月问卷" style="width:100%"></div>
        <button class="btn" onclick="doGrant(${id})">发放</button>
      </div>

      <b style="font-size:13px">额度台账</b>
      ${d.grants.length ? `<table style="margin:8px 0 16px">
        <tr><th>时间</th><th>教案</th><th>配图</th><th>原因</th></tr>
        ${d.grants.map((g) => `<tr><td>${fmtDay(g.created_at)}</td>
          <td class="num">${g.delta_text > 0 ? '+' : ''}${g.delta_text}</td>
          <td class="num">${g.delta_image > 0 ? '+' : ''}${g.delta_image}</td>
          <td>${esc(g.reason)}</td></tr>`).join('')}
      </table>` : '<div class="empty">还没发过额度</div>'}

      <b style="font-size:13px">教案（${d.conversations.length}）</b>
      ${d.can_view_content === false ? `<div class="note" style="margin:8px 0">
        只有超级管理员能看到教案标题和内容。这里显示写了几份、什么时候写的，够你判断她的使用情况。
      </div>` : ''}
      ${d.conversations.length ? `<table style="margin:8px 0 16px">
        <tr><th>标题</th><th>年龄班</th><th>状态</th><th>版本</th><th>时间</th></tr>
        ${d.conversations.slice(0, 15).map((c) => `<tr>
          <td>${c.title === undefined ? '—' : esc(c.title || '—')}</td><td>${esc(c.age_group || '—')}</td>
          <td>${c.status === 'completed' ? '<span class="pill p-ok">已完成</span>' : `<span class="pill p-off">${esc(c.status)}</span>`}</td>
          <td class="num">${c.version ? 'v' + c.version : '—'}</td>
          <td>${fmtDay(c.created_at)}</td></tr>`).join('')}
      </table>` : '<div class="empty">还没写过教案</div>'}

      ${d.feedback.length ? `<b style="font-size:13px">她的反馈（${d.feedback.length}）</b>
      <table style="margin:8px 0 16px">
        <tr><th>类型</th><th>内容</th><th>时间</th></tr>
        ${d.feedback.map((f) => `<tr>
          <td>${f.kind === 'lesson_rating' ? ratingPill(f.rating) : '<span class="pill p-off">建议</span>'}</td>
          <td>${esc(f.text || '—')}</td><td>${fmtDay(f.created_at)}</td></tr>`).join('')}
      </table>` : ''}

      <div class="foot">
        <button class="btn-sm btn-danger" onclick="toggleStatus(${id},'${t.status === 'active' ? 'disabled' : 'active'}')">
          ${t.status === 'active' ? '停用这个账号' : '恢复账号'}</button>
        <button class="btn" onclick="closeModal()">关闭</button>
      </div>
    </div></div>`;
    render();
  } catch (e) { toast(e.message); }
};

window.doGrant = async (id) => {
  const dt = Number(document.getElementById('gt').value) || 0;
  const di = Number(document.getElementById('gi').value) || 0;
  const reason = document.getElementById('gr').value.trim();
  if (!reason) { toast('写一下原因 —— 这是对账和研究记录的依据'); return; }
  try {
    await api('POST', `/teachers/${id}/grant`, { delta_text: dt, delta_image: di, reason });
    toast(`已发放：教案 +${dt}，配图 +${di}`);
    await load(); await openTeacher(id);
  } catch (e) { toast(e.message); }
};
window.toggleStatus = async (id, status) => {
  try { await api('POST', `/teachers/${id}/status`, { status }); toast(status === 'disabled' ? '已停用' : '已恢复'); S.modal = null; await load(); }
  catch (e) { toast(e.message); }
};

const ratingPill = (r) => ({
  usable: '<span class="pill p-ok">直接能用</span>',
  needs_edit: '<span class="pill p-warn">改改能用</span>',
  unusable: '<span class="pill p-bad">用不了</span>',
}[r] || '—');

/* ============ 兑换码 ============ */
function codesView() {
  const items = S.data.codes?.items || [];
  return `<h2>兑换码</h2><div class="sub">码只用于首次激活。老师完成新任务不用发新码，去「老师」页直接加额度</div>
    <div class="row">
      <button class="btn" onclick="openNewCode()">＋ 新建兑换码</button>
      <button class="btn-sm" onclick="openBatchCodes()">批量建码</button>
      <button class="btn-sm" onclick="exportCodes()">导出 CSV</button>
      <select onchange="S.filter.codeStatus=this.value;load()">
        ${[['all', '全部'], ['unused', '未使用'], ['used', '已使用'], ['void', '已作废']].map(([k, l]) =>
          `<option value="${k}" ${S.filter.codeStatus === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${items.length ? `<table>
      <tr><th>兑换码</th><th>发给谁</th><th>手机号</th><th>园所 / 班级</th><th>初始额度</th><th>状态</th><th></th></tr>
      ${items.map((c) => `<tr>
        <td class="mono"><b>${esc(c.code)}</b></td>
        <td>${esc(c.real_name || '—')}</td>
        <td class="mono">${esc(c.phone_masked || '—')}</td>
        <td>${esc(c.kindergarten || '—')} · ${esc(c.class_name || '—')}</td>
        <td class="num">${c.init_text} 教案 / ${c.init_image} 配图</td>
        <td>${c.status === 'unused' ? '<span class="pill p-warn">待使用</span>'
            : c.status === 'used' ? `<span class="pill p-ok">已用 ${fmtDay(c.used_at)}</span>`
            : '<span class="pill p-off">已作废</span>'}</td>
        <td>${c.status === 'unused'
            ? `<button class="btn-sm" onclick="copyCode('${c.code}')">复制</button>
               <button class="btn-sm" onclick="exportCodes('${c.code}')">导出</button>
               <button class="btn-sm btn-danger" onclick="voidCode(${c.id})">作废</button>` : ''}</td>
      </tr>`).join('')}
    </table>` : `<div class="empty">还没有兑换码</div>`}`;
}

window.openNewCode = () => {
  const kgs = S.data.kindergartens?.items || [];
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>新建兑换码</h3>
    <div class="note">从问卷星的答卷里把这几项抄过来。生成后把码用微信发给她。</div>
    <div class="grid2">
      <div class="field"><label>手机号（可不填）</label><input type="text" id="c_phone" placeholder="留空 = 谁拿到谁能兑" style="width:100%"></div>
      <div class="field"><label>姓名（可不填）</label><input type="text" id="c_name" placeholder="留空 = 匿名码" style="width:100%"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>园所</label>
        <select id="c_kg" style="width:100%"><option value="">未指定</option>
          ${kgs.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select></div>
      <div class="field"><label>班级</label><input type="text" id="c_class" placeholder="如 中二班" style="width:100%"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>岗位</label>
        <select id="c_pos" style="width:100%">
          ${['主班', '配班', '保育员', '园长', '其他'].map((p) => `<option>${p}</option>`).join('')}</select></div>
      <div class="field"><label>年龄班</label>
        <select id="c_age" style="width:100%">
          ${['小班', '中班', '大班'].map((a) => `<option ${a === '中班' ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>初始教案次数</label><input type="number" id="c_text" value="20" style="width:100%"></div>
      <div class="field"><label>初始配图张数</label><input type="number" id="c_img" value="10" style="width:100%"></div>
    </div>
    <div class="field"><label>发放原因（会存进台账）</label>
      <input type="text" id="c_reason" value="完成问卷 · 首次" style="width:100%"></div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="doCreateCode()">生成</button>
    </div>
  </div></div>`;
  render();
};

window.doCreateCode = async () => {
  const g = (id) => document.getElementById(id).value.trim();
  try {
    const d = await api('POST', '/codes', {
      phone: g('c_phone'), real_name: g('c_name'),
      kindergarten_id: g('c_kg') || null, class_name: g('c_class'),
      position: g('c_pos'), age_group: g('c_age'),
      init_text: Number(g('c_text')), init_image: Number(g('c_img')),
      grant_reason: g('c_reason'),
    });
    S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
      <h3>生成好了</h3>
      <div class="codebox"><div class="c">${esc(d.code)}</div>
        <div class="t">把这串发给她，她在小程序里输进去就能开始用</div></div>
      <div class="foot">
        <button class="btn-sm" onclick="copyCode('${d.code}')">复制</button>
        <button class="btn" onclick="closeModal();load()">好</button>
      </div>
    </div></div>`;
    render();
  } catch (e) { toast(e.message); }
};
window.copyCode = (c) => { navigator.clipboard?.writeText(c); toast(`已复制 ${c}`); };
window.voidCode = async (id) => {
  if (!confirm('作废之后这个码就不能用了，确定？')) return;
  try { await api('POST', `/codes/${id}/void`); toast('已作废'); await load(); } catch (e) { toast(e.message); }
};

/* ============ 园所 ============ */
function kgView() {
  const items = S.data.kindergartens?.items || [];
  return `<h2>园所</h2>
    <div class="sub">做成固定列表而不是自由填写：手填的「阳光幼儿园」和「阳光园」会变成两个园，统计就对不上了</div>
    <div class="row">
      <input type="text" id="kgname" placeholder="园所名称" style="width:220px">
      <input type="text" id="kgnote" placeholder="备注（选填）" style="width:260px">
      <button class="btn-sm" onclick="addKg()">添加</button>
    </div>
    ${items.length ? `<table>
      <tr><th>园所</th><th>已激活老师</th><th>备注</th></tr>
      ${items.map((k) => `<tr><td><b>${esc(k.name)}</b></td>
        <td class="num">${k.teachers}</td><td>${esc(k.note || '—')}</td></tr>`).join('')}
    </table>` : `<div class="empty">还没有园所，先加一个</div>`}`;
}
window.addKg = async () => {
  const name = document.getElementById('kgname').value.trim();
  if (!name) { toast('填个名字'); return; }
  try {
    await api('POST', '/kindergartens', { name, note: document.getElementById('kgnote').value.trim() });
    toast('加好了'); await load();
  } catch (e) { toast(e.message); }
};

/* ============ 反馈 ============ */
function feedbackView() {
  const items = S.data.feedback?.items || [];
  return `<h2>反馈</h2>
    <div class="sub">教案评价绑着具体版本 —— 看到「用不了」时能直接翻出那份原文</div>
    <div class="row">
      <select onchange="S.filter.fbKind=this.value;load()">
        ${[['all', '全部'], ['lesson_rating', '教案评价'], ['suggestion', '产品建议']].map(([k, l]) =>
          `<option value="${k}" ${S.filter.fbKind === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${items.length ? `<table>
      <tr><th>谁</th><th>类型</th><th>内容</th><th>关联教案</th><th>时间</th><th></th></tr>
      ${items.map((f) => `<tr style="${f.handled ? 'opacity:.55' : ''}">
        <td>${esc(f.real_name || '—')}<br><span style="font-size:11.5px;color:var(--ink-3)">${esc(f.kindergarten || '')}</span></td>
        <td>${f.kind === 'lesson_rating' ? ratingPill(f.rating)
            : `<span class="pill p-off">${({ quality: '质量', feature: '新功能', usability: '别扭', other: '其他' })[f.category] || '建议'}</span>`}</td>
        <td style="max-width:280px">${esc(f.text || '—')}</td>
        <td>${f.plan_title ? `${esc(f.plan_title)}<br><span style="font-size:11.5px;color:var(--ink-3)">${esc(f.age_group || '')} · v${f.plan_version}</span>` : '—'}</td>
        <td>${fmtDay(f.created_at)}</td>
        <td><button class="btn-sm" onclick="markHandled(${f.id},${!f.handled})">
          ${f.handled ? '标为未处理' : '标为已处理'}</button></td>
      </tr>`).join('')}
    </table>` : `<div class="empty">还没有反馈</div>`}`;
}
window.markHandled = async (id, handled) => {
  try { await api('POST', `/feedback/${id}/handled`, { handled }); await load(); } catch (e) { toast(e.message); }
};

/* ============ 加载与渲染 ============ */
async function load() {
  if (!S.token) return render();
  S.loading = true; render();
  try {
    const jobs = { overview: api('GET', '/overview'), kindergartens: api('GET', '/kindergartens') };
    if (S.page === 'teachers') {
      const qs = new URLSearchParams();
      if (S.filter.q) qs.set('q', S.filter.q);
      if (S.filter.kg) qs.set('kindergarten_id', S.filter.kg);
      jobs.teachers = api('GET', `/teachers?${qs}`);
    }
    if (S.page === 'codes') jobs.codes = api('GET', `/codes?status=${S.filter.codeStatus}`);
    if (S.page === 'feedback') jobs.feedback = api('GET', `/feedback?kind=${S.filter.fbKind}`);
    if (S.page === 'imagemodels' && isSuper()) jobs.imagemodels = api('GET', '/image-models');
    if (S.page === 'admins' && isSuper()) jobs.admins = api('GET', '/admins');
    if (S.page === 'logs' && isSuper()) jobs.logs = api('GET', '/logs');

    const keys = Object.keys(jobs);
    const vals = await Promise.all(Object.values(jobs));
    keys.forEach((k, i) => { S.data[k] = vals[i]; });
  } catch (e) { toast(e.message); }
  S.loading = false; render();
}

function render() {
  if (!S.token) { app.innerHTML = loginView(); document.getElementById('pwd')?.focus(); return; }
  const view = ({
    overview: overviewView, teachers: teachersView, codes: codesView,
    kindergartens: kgView, feedback: feedbackView,
    imagemodels: imageModelsView, admins: adminsView, logs: logsView,
  })[S.page];
  // 一般管理员手动改 URL 也进不去超管页 —— 后端还有一道守卫，这里只是不让界面出错
  const body = (SUPER_PAGES[S.page] && !isSuper()) ? (S.page = 'overview', overviewView()) : view();
  app.innerHTML = shell(body);
}


/* ============ 管理员账号（只有超管进得来）============ */
function adminsView() {
  const items = S.data.admins?.items || [];
  const meId = S.data.admins?.me;
  return `<h2>管理员</h2>
    <div class="sub">同事只做运营：发额度、建兑换码、看反馈。<b>手机号全号和老师写的内容，只有超级管理员看得到</b></div>
    <div class="note">
      老师同意的协议里写着「你的幼儿园和园长看不到这里的任何东西」。同事不是园方，这句话依然成立 ——
      但每多一个人能读老师写的东西，这句承诺就少一分是真的。所以一般管理员默认看不到对话正文和完整手机号。
      要给谁开超级管理员，先想清楚他是不是真的需要读这些。
    </div>
    <div class="row"><button class="btn" onclick="openNewAdmin()">＋ 新建管理员</button></div>
    <table>
      <tr><th>用户名</th><th>称呼</th><th>角色</th><th>状态</th><th>创建者</th><th>最近登录</th><th></th></tr>
      ${items.map((a) => `<tr>
        <td class="mono"><b>${esc(a.username)}</b>${a.id === meId ? ' <span class="pill p-off">我</span>' : ''}</td>
        <td>${esc(a.display_name || '—')}</td>
        <td>${a.role === 'super' ? '<span class="pill p-warn">超级管理员</span>' : '<span class="pill p-off">一般管理员</span>'}</td>
        <td>${a.status === 'active' ? '<span class="pill p-ok">正常</span>' : '<span class="pill p-bad">已停用</span>'}</td>
        <td>${esc(a.created_by_name || '—')}</td>
        <td>${fmtDate(a.last_login_at)}</td>
        <td>
          <button class="btn-sm" onclick="openResetPwd(${a.id},'${esc(a.username)}')">重置密码</button>
          ${a.id === meId ? '' : `<button class="btn-sm btn-danger"
            onclick="toggleAdmin(${a.id},'${a.status === 'active' ? 'disabled' : 'active'}')">
            ${a.status === 'active' ? '停用' : '恢复'}</button>`}
        </td>
      </tr>`).join('')}
    </table>`;
}

window.openNewAdmin = () => {
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>新建管理员</h3>
    <div class="grid2">
      <div class="field"><label>用户名（小写字母/数字/下划线）</label>
        <input type="text" id="a_user" placeholder="如 zhangsan" style="width:100%"></div>
      <div class="field"><label>称呼</label><input type="text" id="a_name" placeholder="如 张三" style="width:100%"></div>
    </div>
    <div class="field"><label>初始密码（至少 6 位，让他登录后自己改）</label>
      <input type="text" id="a_pwd" style="width:100%"></div>
    <div class="field"><label>角色</label>
      <select id="a_role" style="width:100%">
        <option value="admin">一般管理员 —— 发额度、建码、看反馈；看不到手机号全号和对话内容</option>
        <option value="super">超级管理员 —— 全部权限，含管理账号、看对话正文</option>
      </select></div>
    <div class="note" style="margin-top:10px">
      给谁开超级管理员，先想清楚他是不是真的需要读老师写的东西。
    </div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="doCreateAdmin()">创建</button>
    </div>
  </div></div>`;
  render();
};
window.doCreateAdmin = async () => {
  const g = (id) => document.getElementById(id).value.trim();
  try {
    await api('POST', '/admins', {
      username: g('a_user'), password: g('a_pwd'),
      role: g('a_role'), display_name: g('a_name'),
    });
    toast('建好了 —— 把用户名和初始密码发给他，让他登录后自己改');
    S.modal = null; await load();
  } catch (e) { toast(e.message); }
};

window.openResetPwd = (id, username) => {
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>重置 ${esc(username)} 的密码</h3>
    <div class="field"><label>新密码（至少 6 位）</label><input type="text" id="r_pwd" style="width:100%"></div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="doResetPwd(${id})">重置</button>
    </div>
  </div></div>`;
  render();
};
window.doResetPwd = async (id) => {
  try {
    await api('POST', `/admins/${id}/password`, { password: document.getElementById('r_pwd').value });
    toast('改好了'); S.modal = null; await load();
  } catch (e) { toast(e.message); }
};
window.toggleAdmin = async (id, status) => {
  try { await api('POST', `/admins/${id}/status`, { status }); toast(status === 'disabled' ? '已停用' : '已恢复'); await load(); }
  catch (e) { toast(e.message); }
};

/* 改自己的密码 —— 一般管理员也能用 */
window.openChangePwd = () => {
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>改我的密码</h3>
    <div class="field"><label>原密码</label><input type="password" id="p_old" style="width:100%"></div>
    <div class="field"><label>新密码（至少 6 位）</label><input type="password" id="p_new" style="width:100%"></div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="doChangePwd()">保存</button>
    </div>
  </div></div>`;
  render();
};
window.doChangePwd = async () => {
  try {
    await api('POST', '/me/password', {
      old_password: document.getElementById('p_old').value,
      new_password: document.getElementById('p_new').value,
    });
    toast('改好了，下次用新密码登录'); S.modal = null; render();
  } catch (e) { toast(e.message); }
};

/* ============ 操作记录 ============ */
const ACTIONS = {
  grant_quota: '发额度', create_code: '建兑换码', void_code: '作废码',
  teacher_status: '停用/恢复老师', create_admin: '建管理员',
  admin_status: '停用/恢复管理员', reset_password: '重置密码',
  change_own_password: '改自己密码',
};
function logsView() {
  const items = S.data.logs?.items || [];
  return `<h2>操作记录</h2>
    <div class="sub">多个人能改额度之后，「这 20 次是谁发的」必须能查</div>
    ${items.length ? `<table>
      <tr><th>时间</th><th>谁</th><th>做了什么</th><th>对象</th><th>详情</th></tr>
      ${items.map((l) => `<tr>
        <td>${fmtDate(l.created_at)}</td>
        <td>${esc(l.display_name || l.username || '—')}</td>
        <td>${ACTIONS[l.action] || esc(l.action)}</td>
        <td class="mono">${esc(l.target || '—')}</td>
        <td style="font-size:12.5px;color:var(--ink-3)">${esc(JSON.stringify(l.detail || {}) === '{}' ? '' : JSON.stringify(l.detail))}</td>
      </tr>`).join('')}
    </table>` : `<div class="empty">还没有操作记录</div>`}`;
}

load();

/* ============ 批量建码与导出 ============ */
//
// 一次只能建一个的时候，实际流程是「问卷星导出一批答卷 → 一个个建」，
// 二十个老师就要点二十遍。这里收一份名册，一行一个人。
//
// **码依然绑手机号**：它是对账问卷与小程序账号的唯一锚点，
// 也是「换个微信重登不能白拿一份额度」那条约束的依据。

window.openBatchCodes = () => {
  const kgs = S.data.kindergartens?.items || [];
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>批量建码</h3>
    <div class="grid2">
      <div class="field"><label>建几个</label>
        <input type="number" id="b_count" value="20" min="1" max="200" style="width:100%"></div>
      <div class="field"><label>园所（可不填）</label>
        <select id="b_kg" style="width:100%"><option value="">不指定</option>
          ${kgs.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>每个码给多少教案</label>
        <input type="number" id="b_text" value="20" style="width:100%"></div>
      <div class="field"><label>每个码给多少配图</label>
        <input type="number" id="b_image" value="10" style="width:100%"></div>
    </div>
    <div class="field"><label>原因</label>
      <input type="text" id="b_reason" value="批量发放" style="width:100%"></div>
    <div class="foot">
      <button class="btn btn-plain" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveBatchCodes()">建码</button>
    </div>
  </div></div>`;
  render();
};

window.saveBatchCodes = async () => {
  try {
    const d = await api('POST', '/codes/batch', {
      count: Number(document.getElementById('b_count').value) || 20,
      init_text: Number(document.getElementById('b_text').value) || 20,
      init_image: Number(document.getElementById('b_image').value) || 10,
      kindergarten_id: document.getElementById('b_kg').value || null,
      grant_reason: document.getElementById('b_reason').value.trim(),
    });
    closeModal();
    toast(`建了 ${d.created.length} 个`);
    load();
  } catch (e) { toast(e.message); }
};

/** 导出 CSV。带手机号全号，所以后端只让超管调；单个码也走同一条路 */
window.exportCodes = (code) => {
  const q = code ? `code=${encodeURIComponent(code)}` : `status=${S.filter.codeStatus}`;
  // 用 fetch 而不是直接开新窗口：这个接口要带 Authorization 头
  fetch(`${API}/codes/export?${q}`, { headers: { Authorization: `Bearer ${S.token}` } })
    .then((r) => (r.ok ? r.blob() : r.json().then((j) => Promise.reject(new Error(j.error?.message || '导出失败')))))
    .then((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = code ? `code-${code}.csv` : `codes-${S.filter.codeStatus}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('导出好了');
    })
    .catch((e) => toast(e.message));
};
