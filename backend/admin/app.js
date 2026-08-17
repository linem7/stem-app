/* 管理后台前端。原生 JS，无构建步骤 —— 这个后台只有一个人用，
   为它引一套打包工具链不值得。 */

const API = '/admin/api';
const app = document.getElementById('app');
const S = {
  token: localStorage.getItem('admin_token') || null,
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
    <p>只有一个账号。老师的登录进不来这里。</p>
    <input id="pwd" type="password" placeholder="管理密码" autofocus>
    <button class="btn" onclick="doLogin()">进入</button>
  </div></div>`;
}
window.doLogin = async () => {
  const pwd = document.getElementById('pwd').value;
  try {
    const d = await api('POST', '/login', { password: pwd });
    S.token = d.token; localStorage.setItem('admin_token', d.token);
    S.page = 'overview'; await load();
  } catch (e) { toast(e.message); }
};

/* ============ 框架 ============ */
const PAGES = {
  overview: '概览',
  teachers: '老师',
  codes: '兑换码',
  kindergartens: '园所',
  feedback: '反馈',
};

function shell(inner) {
  const n = S.data.overview?.feedback_new || 0;
  return `<div class="wrap">
    <div class="side">
      <div class="brand">STEAM 教案助手<small>管理后台</small></div>
      ${Object.entries(PAGES).map(([k, v]) => `
        <button class="nav ${S.page === k ? 'on' : ''}" onclick="goto('${k}')">${v}
          ${k === 'feedback' && n ? `<span class="badge">${n}</span>` : ''}</button>`).join('')}
      <button class="nav" style="margin-top:18px;color:var(--ink-3)" onclick="logout()">退出</button>
    </div>
    <div class="main">${inner}</div>
  </div>${S.modal || ''}`;
}
window.goto = async (p) => { S.page = p; S.modal = null; await load(); };
window.logout = () => { S.token = null; localStorage.removeItem('admin_token'); render(); };
window.closeModal = () => { S.modal = null; render(); };

/* ============ 概览 ============ */
function overviewView() {
  const o = S.data.overview || {};
  const cards = [
    ['teachers', '激活的老师'], ['kindergartens', '合作园'], ['codes_unused', '待用兑换码'],
    ['plans', '生成的教案'], ['images', '生成的配图'], ['feedback_new', '待处理反馈'],
  ];
  return `<h2>概览</h2><div class="sub">这些数只有你看得到</div>
    <div class="stats">${cards.map(([k, l]) =>
      `<div class="stat"><div class="n">${o[k] ?? '—'}</div><div class="l">${l}</div></div>`).join('')}</div>
    <div class="note">
      <b>发额度的日常流程</b>：问卷星导出答卷 → 用手机号在「老师」页搜 →
      搜得到就直接加一笔额度（不用发新码）；搜不到就是新老师，去「兑换码」页建一个。
      每笔额度都要写原因，那既是对账依据也是研究记录。
    </div>`;
}

/* ============ 老师 ============ */
function teachersView() {
  const items = S.data.teachers?.items || [];
  const kgs = S.data.kindergartens?.items || [];
  return `<h2>老师</h2><div class="sub">共 ${items.length} 位已激活</div>
    <div class="row">
      <input type="text" id="q" placeholder="搜手机号或姓名" value="${esc(S.filter.q)}"
        onkeydown="if(event.key==='Enter')doSearch()" style="width:200px">
      <select id="kg" onchange="doSearch()">
        <option value="">全部园所</option>
        ${kgs.map((k) => `<option value="${k.id}" ${S.filter.kg == k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}
      </select>
      <button class="btn-sm" onclick="doSearch()">搜索</button>
    </div>
    ${items.length ? `<table>
      <tr><th>姓名</th><th>手机号</th><th>园所</th><th>班级 / 岗位</th>
          <th>教案额度</th><th>配图额度</th><th>最近登录</th><th></th></tr>
      ${items.map((t) => `<tr>
        <td>${esc(t.real_name || '—')} ${t.status === 'disabled' ? '<span class="pill p-off">已停用</span>' : ''}</td>
        <td class="mono">${esc(t.phone_masked || '—')}</td>
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
      ${d.conversations.length ? `<table style="margin:8px 0 16px">
        <tr><th>标题</th><th>年龄班</th><th>状态</th><th>版本</th><th>时间</th></tr>
        ${d.conversations.slice(0, 15).map((c) => `<tr>
          <td>${esc(c.title || '—')}</td><td>${esc(c.age_group || '—')}</td>
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
      <select onchange="S.filter.codeStatus=this.value;load()">
        ${[['all', '全部'], ['unused', '未使用'], ['used', '已使用'], ['void', '已作废']].map(([k, l]) =>
          `<option value="${k}" ${S.filter.codeStatus === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${items.length ? `<table>
      <tr><th>兑换码</th><th>发给谁</th><th>手机号</th><th>园所 / 班级</th><th>初始额度</th><th>状态</th><th></th></tr>
      ${items.map((c) => `<tr>
        <td class="mono"><b>${esc(c.code)}</b></td>
        <td>${esc(c.real_name)}</td>
        <td class="mono">${esc(c.phone_masked)}</td>
        <td>${esc(c.kindergarten || '—')} · ${esc(c.class_name || '—')}</td>
        <td class="num">${c.init_text} 教案 / ${c.init_image} 配图</td>
        <td>${c.status === 'unused' ? '<span class="pill p-warn">待使用</span>'
            : c.status === 'used' ? `<span class="pill p-ok">已用 ${fmtDay(c.used_at)}</span>`
            : '<span class="pill p-off">已作废</span>'}</td>
        <td>${c.status === 'unused'
            ? `<button class="btn-sm" onclick="copyCode('${c.code}')">复制</button>
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
      <div class="field"><label>手机号（必填）</label><input type="text" id="c_phone" placeholder="11 位" style="width:100%"></div>
      <div class="field"><label>姓名（必填）</label><input type="text" id="c_name" style="width:100%"></div>
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

    const keys = Object.keys(jobs);
    const vals = await Promise.all(Object.values(jobs));
    keys.forEach((k, i) => { S.data[k] = vals[i]; });
  } catch (e) { toast(e.message); }
  S.loading = false; render();
}

function render() {
  if (!S.token) { app.innerHTML = loginView(); document.getElementById('pwd')?.focus(); return; }
  const body = ({
    overview: overviewView, teachers: teachersView, codes: codesView,
    kindergartens: kgView, feedback: feedbackView,
  })[S.page]();
  app.innerHTML = shell(body);
}

load();
