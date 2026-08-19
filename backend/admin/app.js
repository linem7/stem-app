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
  // fbKind 默认落在「关于产品」那个 tab：那是需要我动手回应的一类。
  // 教案评价是研究数据，看的是趋势，不是逐条处理
  filter: {
    kg: '', q: '', codeStatus: 'all', fbKind: 'suggestion',
    log: { admin_id: '', action: '', from: '', to: '', page: 1 },
    roster: { status: 'all', q: '' },
  },
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
//
// **园所排在老师前面**（2026-08-18 用户定）：合作是按园谈的，老师是园带进来的。
// 原来的顺序（老师 → 兑换码 → 园所）反映的是「一个个老师」的视角，
// 而实际要管的是「哪个园在用、我的钱剩多少、该给谁派任务」。
const PAGES = {
  overview: '概览',
  kindergartens: '园所',
  // 名单紧跟园所：它是园所给的，也是激活的第二把钥匙。
  // 排在「老师」前面，因为名单里的人还不是老师 —— 她们要先激活才会出现在那一页
  roster: '名单',
  teachers: '老师',
  codes: '兑换码',
  feedback: '反馈',
  tasks: '任务',
};
/** 只有超级管理员看得到的页 */
const SUPER_PAGES = { imagemodels: '配图模型', admins: '管理员', logs: '操作记录' };

function shell(inner) {
  const n = S.data.overview?.todo?.feedback_new || 0;
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
//
// 2026-08-18 重做。删掉了「最近写的」（用户原话「没有实际意义」）和
// 「今天写了几份 / 累计多少老师」这类只会一直变大的累计数 ——
// 看一眼就没用了，不告诉你今天该做什么。
//
// 现在只回答四句话：我的钱 / 谁在用 / 哪个园用了多少 / 等我处理。

const yuan = (cents) => `￥${((cents || 0) / 100).toFixed(2)}`;

function overviewView() {
  const o = S.data.overview || {};
  const m = o.money || {};
  const u = o.usage || {};
  const td = o.todo || {};
  const q = o.quality || {};
  const rated = (q.usable || 0) + (q.needs_edit || 0) + (q.unusable || 0);

  // 要处理的事排在最前面 —— 它才决定你今天做什么
  const todo = [
    td.feedback_new ? `<b>${td.feedback_new}</b> 条反馈没看` : '',
    td.gen_failed_7d ? `<b>${td.gen_failed_7d}</b> 次生成失败（近 7 天）` : '',
    td.images_failed_7d ? `<b>${td.images_failed_7d}</b> 张配图失败（近 7 天）` : '',
    (td.codes_unused ?? 0) < 5 ? `没用的兑换码只剩 <b>${td.codes_unused ?? 0}</b> 个，该建一批了` : '',
    (td.low_quota || []).length ? `<b>${td.low_quota.length}</b> 位老师额度快用完` : '',
    // 钱要见底了得提前知道 —— 停在半路上是老师的教案生成失败
    m.left_cents != null && m.left_cents < 2000 ? `<b>账面只剩 ${yuan(m.left_cents)}</b>，该充值了` : '',
  ].filter(Boolean);

  return `<h2>概览</h2>
    ${todo.length
      ? `<div class="note" style="background:var(--amber-soft)"><b>要处理</b><br>${todo.join('<br>')}</div>`
      : '<div class="note"><b>没有待处理的事</b></div>'}

    <div class="sub" style="margin-bottom:8px"><b>我的钱</b></div>
    <div class="stats">
      <div class="stat"><div class="n ${(m.left_cents || 0) < 2000 ? 'low' : ''}">${yuan(m.left_cents)}</div>
        <div class="l">账面还剩<br>充了 ${yuan(m.topup_cents)}，花了 ${yuan(m.spent_cents)}</div></div>
      <div class="stat"><div class="n">${yuan(m.spent_image_cents)}</div>
        <div class="l">配图花的<br>本月 ${yuan(m.month_image_cents)}</div></div>
      <div class="stat"><div class="n">${yuan(m.spent_text_cents)}</div>
        <div class="l">文本花的<br>本月 ${yuan(m.month_text_cents)}</div></div>
      <div class="stat" style="border-style:dashed">
        <button class="btn-sm" onclick="openTopup()">记一笔充值</button>
        <div class="l" style="margin-top:8px">充值台账<br>${(S.data.topups?.items || []).length} 笔</div></div>
    </div>
    <!-- **诚实标注**，不是解释性小字：不说这句，上面那个「花了多少」会被当成全部历史 -->
    ${(m.images_missing_cost || !m.text_tracked_since) ? `<div class="note" style="margin-top:-8px">
      这个数偏低：${[
        m.images_missing_cost ? `早期 ${m.images_missing_cost} 张图没记成本` : '',
        m.text_tracked_since ? `文本成本从 ${fmtDay(m.text_tracked_since)} 起才有记录` : '文本成本还没开始记',
      ].filter(Boolean).join('，')}
    </div>` : ''}

    <div class="sub" style="margin:18px 0 8px"><b>谁在用</b></div>
    <div class="stats">
      <div class="stat"><div class="n">${u.kindergartens ?? '—'}</div>
        <div class="l">园所<br>近 7 天有人用 ${u.kindergartens_active_7d ?? 0} 个</div></div>
      <div class="stat"><div class="n">${u.teachers ?? '—'}</div>
        <div class="l">激活的老师<br>近 7 天来过 ${u.teachers_active_7d ?? 0} 位</div></div>
      <div class="stat"><div class="n ${rated === 0 ? '' : (q.unusable > q.usable ? 'low' : '')}">${rated || '—'}</div>
        <div class="l">教案被评价过<br>${rated
          ? `能用 ${q.usable} · 改改 ${q.needs_edit} · 不能用 ${q.unusable}`
          : '这是产品最大的未知数'}</div></div>
    </div>

    <div class="sub" style="margin:18px 0 8px"><b>哪个园用了多少</b></div>
    ${(o.by_kindergarten || []).length
      ? `<table>
        <tr><th>园所</th><th>地区</th><th>老师</th><th>教案额度</th><th>配图</th><th>花了</th><th></th></tr>
        ${o.by_kindergarten.map((k) => `<tr>
          <td><b>${esc(k.name)}</b></td>
          <td>${k.province ? esc(`${k.province}·${k.city || ''}`.replace(/·$/, '')) : '—'}</td>
          <td class="num">${k.teachers}</td>
          <td class="num">${k.granted_text ? `${k.used_text} / ${k.granted_text}` : '—'}</td>
          <td class="num">${k.images}</td>
          <td class="num">${(k.image_cost_cents + k.text_cost_cents)
              ? yuan(k.image_cost_cents + k.text_cost_cents) : '—'}</td>
          <td>${k.teachers ? `<button class="btn-sm" onclick="kgTeachers(${k.id})">看老师</button>` : ''}</td>
        </tr>`).join('')}
      </table>`
      : '<div class="empty">还没有园所</div>'}

    ${(td.low_quota || []).length ? `
    <div class="sub" style="margin:18px 0 8px"><b>额度快用完的老师</b></div>
    <table>${td.low_quota.map((t) =>
      `<tr><td>${esc(t.name || '—')}</td><td>${esc(t.kindergarten || '—')}</td>
       <td class="num low">还剩 ${t.text_left} 次</td>
       <td><button class="btn-sm" onclick="goto('codes')">去建个码</button></td></tr>`).join('')}</table>` : ''}`;
}

/**
 * 记一笔充值。只追加，不修改 —— 记错了记一笔负数冲账，不改历史。
 * 跟额度台账同一个纪律：账面余额是算出来的，不存字段。
 */
window.openTopup = () => {
  const items = S.data.topups?.items || [];
  const channels = S.data.topups?.channels || ['deepseek', '12ai', 'minimax', 'other'];
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
    <div class="box" style="width:560px">
    <h3>充值台账</h3>
    <div class="grid2">
      <div class="field"><label>充了多少（元）</label>
        <input type="number" id="tp_amt" step="0.01" placeholder="200" style="width:100%"></div>
      <div class="field"><label>充到哪家</label>
        <select id="tp_ch" style="width:100%">
          ${channels.map((c) => `<option value="${c}">${c}</option>`).join('')}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>什么时候充的</label>
        <input type="date" id="tp_on" value="${new Date().toISOString().slice(0, 10)}" style="width:100%"></div>
      <div class="field"><label>备注</label>
        <input type="text" id="tp_note" placeholder="8月充值" style="width:100%"></div>
    </div>
    <button class="btn" onclick="saveTopup()">记下来</button>

    ${items.length ? `<table style="margin-top:16px">
      <tr><th>日期</th><th>哪家</th><th>金额</th><th>备注</th></tr>
      ${items.map((t) => `<tr>
        <td>${fmtDay(t.occurred_on)}</td><td>${esc(t.channel)}</td>
        <td class="num ${t.amount_cents < 0 ? 'low' : ''}">${yuan(t.amount_cents)}</td>
        <td>${esc(t.note || '—')}</td></tr>`).join('')}
    </table>` : '<div class="empty">还没记过充值</div>'}

    <div class="foot"><button class="btn" onclick="closeModal()">好</button></div>
  </div></div>`;
  render();
};
window.saveTopup = async () => {
  const amt = document.getElementById('tp_amt').value.trim();
  if (!amt) { toast('填一下充了多少钱'); return; }
  try {
    await api('POST', '/topups', {
      amount_yuan: Number(amt),
      channel: document.getElementById('tp_ch').value,
      occurred_on: document.getElementById('tp_on').value,
      note: document.getElementById('tp_note').value.trim(),
    });
    toast('记下了'); S.modal = null; await load(); openTopup();
  } catch (e) { toast(e.message); }
};

/* ============ 老师 ============ */
function teachersView() {
  const items = S.data.teachers?.items || [];
  const kgs = S.data.kindergartens?.items || [];
  return `<h2>老师</h2><div class="sub">共 ${items.length} 位已激活。<b>编号</b>对上我的名单，<b>兑换码</b>对上问卷星那边</div>
    <div class="row">
      <input type="text" id="q" placeholder="搜姓名 / 班级 / 编号 / 兑换码" value="${esc(S.filter.q)}"
        onkeydown="if(event.key==='Enter')doSearch()" style="width:220px">
      <select id="kg" onchange="doSearch()">
        <option value="">全部园所</option>
        ${kgs.map((k) => `<option value="${k.id}" ${S.filter.kg == k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}
      </select>
      <button class="btn-sm" onclick="doSearch()">搜索</button>
    </div>
    ${items.length ? `<table>
      <tr><th>编号</th><th>姓名</th><th>兑换码</th><th>园所</th><th>班级 / 岗位</th>
          <th>教案额度</th><th>配图额度</th><th>最近登录</th><th></th></tr>
      ${items.map((t) => `<tr>
        <!-- 编号 = teacher_ref = 人。她换班也不变，研究追人靠它 -->
        <td class="mono">${t.teacher_ref ?? '—'}</td>
        <td>${esc(t.real_name || '—')} ${t.status === 'disabled' ? '<span class="pill p-off">已停用</span>' : ''}</td>
        <td class="mono" style="font-size:12px">${esc(t.redeem_code || '—')}</td>
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

/** 配图五种用途的中文名，跟 services/imagePurpose.js 的 PURPOSES 对齐 */
const PURPOSE_CN = {
  material: '材料图', worksheet: '记录表', headwear: '头饰',
  display: '展示图', backdrop: '环创背景',
};

/** 会话状态。库里存的是英文，别把 draft / generating 直接甩到中文界面上 */
const CONV_STATUS = {
  draft: '答题中', generating: '生成中', completed: '已完成', failed: '生成失败',
};
const convStatusPill = (s) => (s === 'completed'
  ? '<span class="pill p-ok">已完成</span>'
  : s === 'failed'
    ? '<span class="pill p-bad">生成失败</span>'
    : `<span class="pill p-off">${esc(CONV_STATUS[s] || s)}</span>`);

/**
 * 老师详情。这一页要回答四件事，缺哪一件都得跳出去查：
 *   1. 她是谁 —— 三层：**编号**（teacher_ref，换班也不变）、**位置**（人×园×班×岗位）、她兑的那个码。
 *      库里没有手机号（016 删了那一列），要联系她去问卷星那边看答卷
 *   2. 额度够不够 —— 发放是这一页最常用的动作，所以留在最上面
 *   3. 她用得怎么样 —— 写了几份、画了几张、花了多少
 *   4. 她说了什么 —— 评价与建议，带上那份教案的标题
 */
window.openTeacher = async (id) => {
  try {
    const d = await api('GET', `/teachers/${id}`);
    const t = d.teacher;
    const q = d.quota;
    const img = d.images || {};
    const plans = d.plans || [];
    // 名单里没填姓名的话，认她靠编号和她兑的那个码
    const who = t.real_name || (t.teacher_ref ? `编号 ${t.teacher_ref}` : '（未填姓名）');

    // 比默认 520 宽：三张统计卡要排成一行，底下的教案表也有六列
    S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
      <div class="box" style="width:640px">
      <h3>${esc(who)}
        ${t.status === 'disabled' ? '<span class="pill p-bad">已停用</span>' : ''}
        ${t.status === 'deleted' ? '<span class="pill p-off">已注销</span>' : ''}</h3>
      <div class="sub" style="margin-bottom:14px">
        ${esc(t.kindergarten || '未指定园所')} · ${esc(t.class_name || '—')} · ${esc(t.position || '—')} · ${esc(t.age_group || '—')}<br>
        编号 <span class="mono">${t.teacher_ref ?? '—'}</span>${t.name_masked ? '（超管可见全名）' : ''}
        　兑的码 <span class="mono">${esc(t.redeem_code || '—')}</span><br>
        激活 ${fmtDate(t.activated_at)}　同意协议 ${fmtDate(t.agreed_at)}　最近登录 ${fmtDate(t.last_login_at)}
      </div>

      <!-- 三张，不是四张：配图花费单独占一张卡时那个大字通常是「￥0.72」，
           撑不起一张卡的分量，并进配图那张当小字正好 -->
      <div class="stats">
        <div class="stat"><div class="n ${q.text.left <= 2 ? 'low' : ''}">${q.text.left}</div>
          <div class="l">教案额度还剩<br>已发 ${q.text.granted}，用了 ${q.text.used}</div></div>
        <div class="stat"><div class="n ${q.image.left <= 2 ? 'low' : ''}">${q.image.left}</div>
          <div class="l">配图额度还剩<br>已发 ${q.image.granted}，画了 ${img.ready || 0} 张，花 ￥${((img.cost_cents || 0) / 100).toFixed(2)}${img.failed ? `<br><span class="low">${img.failed} 张失败（没扣额度）</span>` : ''}</div></div>
        <div class="stat"><div class="n">${plans.length}</div>
          <div class="l">写完的教案<br>${d.drafts ? `还有 ${d.drafts} 个答到一半` : '没有半途停下的'}</div></div>
      </div>

      <b style="font-size:13px">额度台账</b>
      ${d.grants.length ? `<table style="margin:8px 0 16px">
        <tr><th>时间</th><th>教案</th><th>配图</th><th>原因</th></tr>
        ${d.grants.map((g) => `<tr><td>${fmtDay(g.created_at)}</td>
          <td class="num">${g.delta_text > 0 ? '+' : ''}${g.delta_text}</td>
          <td class="num">${g.delta_image > 0 ? '+' : ''}${g.delta_image}</td>
          <td>${esc(g.reason)}</td></tr>`).join('')}
      </table>` : '<div class="empty">还没发过额度</div>'}

      <!-- 只列**写完的**。答题中的草稿不是「她写过的教案」，是被叫走留下的半截 -->
      <b style="font-size:13px">写完的教案（${plans.length}${d.plans_truncated ? '，只显示最近 50 份' : ''}）</b>
      ${d.can_view_content === false ? `<div class="note" style="margin:8px 0">
        教案标题和内容只有超级管理员看得到。
      </div>` : ''}
      ${plans.length ? `<table style="margin:8px 0 16px">
        <tr><th>标题</th><th>年龄班</th><th>改了几次</th><th>时间</th><th></th></tr>
        ${plans.map((p) => `<tr>
          <td>${p.title === undefined ? '<span style="color:var(--ink-3)">超管可见</span>' : esc(p.title || '—')}</td>
          <td>${esc(p.age_group || '—')}</td>
          <!-- 「出到 v3、现在停在 v2」= 她改完又退回去了，这本身是关于教案质量的信号 -->
          <td class="num">${p.version > 1
              ? `改了 ${p.version - 1} 次${p.current_version && p.current_version !== p.version
                  ? `<br><span class="low">退回 v${p.current_version}</span>` : ''}`
              : '没改过'}</td>
          <td>${fmtDay(p.created_at)}</td>
          <td>${p.plan_id ? `<button class="btn-sm" onclick="openPlan(${p.plan_id},${id})">看正文</button>` : ''}</td>
        </tr>`).join('')}
      </table>` : '<div class="empty">还没写完过教案</div>'}

      ${(img.by_purpose || []).length ? `<b style="font-size:13px">她画的配图（按用途）</b>
      <div class="row" style="margin:8px 0 16px">
        ${img.by_purpose.map((p) =>
          `<span class="pill p-off">${esc(PURPOSE_CN[p.purpose] || p.purpose || '未分类')} × ${p.n}</span>`).join('')}
      </div>` : ''}

      ${d.feedback.length ? `<b style="font-size:13px">她的反馈（${d.feedback.length}）</b>
      <table style="margin:8px 0 16px">
        <tr><th>类型</th><th>内容</th><th>说的哪一份</th><th>时间</th></tr>
        ${d.feedback.map((f) => `<tr>
          <td>${f.kind === 'lesson_rating' ? ratingPill(f.rating) : '<span class="pill p-off">建议</span>'}</td>
          <td>${esc(f.text || '—')}</td>
          <td>${f.lesson_plan_id
              ? (f.plan_title === undefined
                  ? `<span style="color:var(--ink-3)">超管可见</span>`
                  : `<button class="btn-sm" onclick="openPlan(${f.lesson_plan_id},${id})">${esc(f.plan_title || '这份教案')} v${f.plan_version || '?'}</button>`)
              : '—'}</td>
          <td>${fmtDay(f.created_at)}</td></tr>`).join('')}
      </table>` : ''}

      <!-- 已经有一把没用的换绑钥匙在外面时**显示它**，而不是让人又生成一把。
           两把钥匙同时能接管同一个账号，而我不知道另一把在谁手上 -->
      ${d.pending_rebind ? `<div class="note" style="margin-top:14px">
        有一个换绑码还没用：<b class="mono">${esc(d.pending_rebind.code)}</b>
        （${fmtDay(d.pending_rebind.expires_at)} 过期）
        <button class="btn-sm" style="margin-left:8px" onclick="copyCode('${esc(d.pending_rebind.code)}')">复制</button>
        <button class="btn-sm btn-danger" onclick="voidRebind(${d.pending_rebind.id},${id})">作废</button>
      </div>` : ''}

      <div class="foot">
        ${t.status === 'active' && d.pending_rebind === null
          ? `<button class="btn-sm" onclick="askRebind(${id})">她换微信了</button>` : ''}
        <button class="btn-sm btn-danger" onclick="toggleStatus(${id},'${t.status === 'active' ? 'disabled' : 'active'}')">
          ${t.status === 'active' ? '停用这个账号' : '恢复账号'}</button>
        <button class="btn" onclick="closeModal()">关闭</button>
      </div>
    </div></div>`;
    render();
  } catch (e) { toast(e.message); }
};

/**
 * 生成换绑码。
 *
 * 这把钥匙能把一整个账号（教案、额度、记忆）交给另一个微信，所以：
 *   · 后端锁超管
 *   · 生成前先确认一次 —— 这一步的意义是提醒我**线下核实这个人真是她**
 *
 * 怎么核：不收手机号验证，只能问她只有她知道的东西 ——
 * 她兑的是哪个码（这一页上就有），或者她最近写的教案标题（也在这一页上）。
 * 见 operations.md 第 1.7 节。
 */
window.askRebind = (id) => {
  if (!confirm('生成之前先确认这个人真是她：问她兑的是哪个码，或者她最近写的教案标题。\n\n这个码能把整个账号交给另一个微信。确定生成？')) return;
  doRebind(id);
};
async function doRebind(id) {
  try {
    const d = await api('POST', `/teachers/${id}/rebind-code`);
    toast(d.reused ? '已经有一个没用的，就用它' : '生成好了');
    await load();
    await openTeacher(id);
  } catch (e) { toast(e.message); }
}
window.voidRebind = async (rebindId, teacherId) => {
  try {
    await api('POST', `/rebind-codes/${rebindId}/void`);
    toast('已作废');
    await load(); await openTeacher(teacherId);
  } catch (e) { toast(e.message); }
};

/**
 * 看一份教案的正文和对话记录 —— **超管专属**（后端 `GET /plans/:id` 也拦着）。
 *
 * 接口早就有，界面上一直没有入口，等于没有。而这是回答产品最大未知数
 * （AI 写的教案到底适不适龄）唯一的办法：老师标了「用不了」，得能立刻翻出那一份看为什么。
 *
 * **必须能按版本看**（2026-08-18）：评价是绑在某一个版本上的，
 * 而 lesson_plans 那一行只存当前内容 —— 她改过之后，
 * 当前内容已经不是她当初评价的那一份了。看错版本 = 看错证据。
 *
 * 正文直接按 content_md 原样铺开，不引 markdown 渲染器：
 * 这一屏是给一个人查证用的，半套渲染器的收益抵不上它出错的概率。
 *
 * @param backTo  关掉这一屏回到哪位老师的详情（从她页面点进来时）
 * @param version 想看第几版。不传 = 当前内容
 */
window.openPlan = async (id, backTo, version) => {
  try {
    const qs = version ? `?version=${version}` : '';
    const d = await api('GET', `/plans/${id}${qs}`);
    const p = d.plan;
    const vs = d.versions || [];
    const shown = d.shown_version;
    const back = backTo ? `openTeacher(${backTo})` : 'closeModal()';
    // 对话记录里 system 那条本来就不在库里（每次实时拼装），这里防一手历史数据
    const msgs = (d.messages || []).filter((m) => m.role !== 'system');
    // **界面上直接看 JSON**（用户定的）：这一屏的用处是拿去做研究分析，
    // 一个能整块选中复制的 JSON 比一张排好的表更有用
    const transcript = msgs.map((m) => ({
      role: m.role === 'user' ? '老师' : 'AI',
      content: m.content || null,
      payload: m.payload || undefined,
      at: m.created_at,
    }));

    S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
      <div class="box" style="width:780px">
      <h3>${esc(p.title || '未命名')}</h3>
      <div class="sub" style="margin-bottom:12px">
        ${esc(p.age_group || '—')} · ${p.duration_min || '—'} 分钟 ·
        ${esc(p.real_name || '匿名')} @ ${esc(p.kindergarten || '—')} · ${fmtDate(p.created_at)}
      </div>

      ${vs.length > 1 ? `<div class="row" style="margin-bottom:12px">
        ${vs.map((v) => `<button class="btn-sm"
            style="${v.version === shown ? 'background:var(--amber);border-color:var(--amber-line);color:var(--ink);font-weight:600' : ''}"
            onclick="openPlan(${id},${backTo || 'null'},${v.version})"
            title="${esc(v.revise_note || '初稿')}">v${v.version}</button>`).join('')}
        ${(() => {
          // 认版本靠的是「她当时说了什么」，不是版本号 —— 所以这句话必须显示出来
          const cur = vs.find((v) => v.version === shown);
          return cur?.revise_note
            ? `<span style="font-size:12.5px;color:var(--ink-2)">因为她说：${esc(cur.revise_note)}</span>`
            : '<span style="font-size:12.5px;color:var(--ink-3)">初稿</span>';
        })()}
      </div>` : ''}

      <div class="card" style="white-space:pre-wrap;font-size:13.5px;line-height:1.8;max-height:44vh;overflow-y:auto">${esc(p.content_md || '（没有正文）')}</div>

      ${p.quality_self ? `<b style="font-size:13px">模型自检</b>
      <div class="card" style="font-size:12.5px;color:var(--ink-2);white-space:pre-wrap;max-height:20vh;overflow-y:auto">${esc(JSON.stringify(p.quality_self, null, 1))}</div>` : ''}

      <b style="font-size:13px">对话记录（${transcript.length} 条）</b>
      ${transcript.length ? `<textarea readonly rows="14"
        style="width:100%;margin-top:8px;font-family:ui-monospace,Consolas,monospace;
               font-size:12px;line-height:1.6;resize:vertical"
        >${esc(JSON.stringify(transcript, null, 2))}</textarea>` : '<div class="empty">没有对话记录</div>'}

      <div class="foot"><button class="btn" onclick="${back}">返回</button></div>
    </div></div>`;
    render();
  } catch (e) { toast(e.message); }
};

// 「发额度」这个动作 2026-08-18 从界面上撤掉了：**额度只走兑换码一条路** ——
// 我建码，通过别的渠道发给她，她在「我的」页自己兑。
//
// 为什么撤：发额度要先在几十个老师里找到她，而匿名码激活的老师
// 根本没有手机号可搜，「找到她」这一步本身就不成立。发一个码是无状态的。
//
// 后端 `POST /teachers/:id/grant` **还留着**（回归脚本在测它，出错时是应急通道），
// 只是这一页不给入口。能力留着 ≠ 要摆在最常用的那一页上。
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
  // 这句是**实情提醒**不是解释：旧规则是「码只用于首次激活，之后去老师页加额度」，
  // 而那个按钮已经撤了。不写这一句，下次我会去老师页找一个不存在的按钮
  return `<h2>兑换码</h2><div class="sub">额度只走这里。老师完成新任务也是再发一个码，她自己兑</div>
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
      <tr><th>兑换码</th><th>发给哪个园</th><th>初始额度</th><th>说明</th><th>状态</th><th></th></tr>
      ${items.map((c) => `<tr>
        <td class="mono"><b>${esc(c.code)}</b></td>
        <!-- 码上没有身份了（016 删了那几列）—— 它只是一张入场券，
             身份来自名单，她激活时自己从名单里选 -->
        <td>${esc(c.kindergarten || '不指定')}</td>
        <td class="num">${c.init_text} 教案 / ${c.init_image} 配图</td>
        <td>${esc(c.grant_reason || '—')}</td>
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

/**
 * 建一个码。
 *
 * **码只是一张入场券**，不带任何身份（016 迁移把那几列删了）——
 * 身份来自名单，她激活时自己从名单里选是哪一位。
 * 所以这张表单从九项缩到三项：给哪个园、初始额度、说明。
 */
window.openNewCode = () => {
  const kgs = S.data.kindergartens?.items || [];
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>新建兑换码</h3>
    <div class="grid2">
      <div class="field"><label>发给哪个园（可不填）</label>
        <select id="c_kg" style="width:100%"><option value="">不指定</option>
          ${kgs.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select></div>
      <div class="field"><label>说明（会存进台账）</label>
        <input type="text" id="c_reason" value="完成问卷 · 首次" style="width:100%"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>初始教案次数</label><input type="number" id="c_text" value="20" style="width:100%"></div>
      <div class="field"><label>初始配图张数</label><input type="number" id="c_img" value="10" style="width:100%"></div>
    </div>
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
      kindergarten_id: g('c_kg') || null,
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
//
// 这一页的**重心是特征**，不是用量（2026-08-18 用户定）。
// 特征不只是档案：省市 / 城乡 / 办园性质就是**任务定向筛的那几个字段** ——
// 一个园的这几项没填，它就收不到任何定向任务，而这件事只在这一页看得出来。
//
// 用量汇总（老师数、没兑的码、教案、额度、配图、花费）收进详情弹窗。
// 理由跟老师详情同一条：一张表塞 15 列谁都读不下来。

const AREA_CN = { city: '城市', county: '县镇', rural: '农村' };
const OWNER_CN = { public: '公办', private: '民办' };

function kgView() {
  const items = S.data.kindergartens?.items || [];
  // 特征没填全的园收不到定向任务，这是这一页唯一需要提醒的事
  const incomplete = items.filter((k) => !k.province || !k.area_type || !k.ownership).length;
  return `<h2>园所</h2>
    <div class="sub">${items.length ? `共 ${items.length} 个` : ''}${
      incomplete ? `　<span class="low">${incomplete} 个还没填齐地区和类型，收不到定向任务</span>` : ''}</div>
    <div class="row">
      <input type="text" id="kgname" placeholder="园所名称" style="width:220px">
      <button class="btn-sm" onclick="addKg()">添加</button>
    </div>
    ${items.length ? `<table>
      <tr><th>园所</th><th>地区</th><th>城乡</th><th>性质</th><th>在园教师</th><th>在园幼儿</th>
          <th>联系人</th><th>在用</th><th>备注</th><th></th></tr>
      ${items.map((k) => `<tr>
        <td><b>${esc(k.name)}</b></td>
        <td>${k.province ? esc(`${k.province}·${k.city || ''}`.replace(/·$/, '')) : '<span class="low">未填</span>'}</td>
        <td>${k.area_type ? AREA_CN[k.area_type] : '<span class="low">未填</span>'}</td>
        <td>${k.ownership ? OWNER_CN[k.ownership] : '<span class="low">未填</span>'}</td>
        <td class="num">${k.teacher_count ?? '—'}</td>
        <td class="num">${k.child_count ?? '—'}</td>
        <td>${esc(k.contact_name || '—')}${k.contact_phone ? `<br><span class="mono" style="font-size:11.5px;color:var(--ink-3)">${esc(k.contact_phone)}</span>` : ''}</td>
        <td class="num">${k.teachers
            // 发了一批码但一个老师都没兑 = 这次合作还没落地，是要跟进的事
            ? `${k.teachers} 位${k.active_7d ? `<br><span style="font-size:11.5px;color:var(--mint-deep)">7 天 ${k.active_7d} 位</span>` : ''}`
            : (k.codes_unused ? `<span class="low">发了 ${k.codes_unused} 个码没人兑</span>` : '—')}</td>
        <td style="max-width:160px">${esc(k.note || '—')}</td>
        <td><button class="btn-sm" onclick="openKg(${k.id})">详情</button></td>
      </tr>`).join('')}
    </table>` : `<div class="empty">还没有园所，先加一个</div>`}`;
}
window.addKg = async () => {
  const name = document.getElementById('kgname').value.trim();
  if (!name) { toast('填个名字'); return; }
  try {
    // 只要名字就能建：省市、人数、联系人这些往往要过几天才从园长那儿问齐，
    // 建的时候逼着填全等于逼人瞎填
    await api('POST', '/kindergartens', { name });
    toast('加好了，进详情把地区和类型填上'); await load();
  } catch (e) { toast(e.message); }
};

/** 不为「这个园的老师」再做一份界面 —— 老师页那张表已经能按园所筛，做两份迟早不一致 */
window.kgTeachers = async (id) => {
  S.filter.kg = String(id); S.filter.q = '';
  await goto('teachers');
};

/** 园所详情：编辑特征 + 用量汇总，一屏看完 */
window.openKg = (id) => {
  const k = (S.data.kindergartens?.items || []).find((x) => x.id === id);
  if (!k) return;
  const sel = (cur, map) => Object.entries(map)
    .map(([v, cn]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${cn}</option>`).join('');

  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
    <div class="box" style="width:620px">
    <h3>${esc(k.name)}</h3>

    <div class="stats">
      <div class="stat"><div class="n">${k.teachers}</div>
        <div class="l">在这儿注册的老师<br>7 天在用 ${k.active_7d || 0} 位</div></div>
      <div class="stat"><div class="n">${k.plans}</div>
        <div class="l">写过的教案<br>配图 ${k.images} 张</div></div>
      <div class="stat"><div class="n">${k.granted_text ? `${k.used_text}/${k.granted_text}` : '—'}</div>
        <div class="l">教案额度用了多少<br>花 ￥${((k.cost_cents || 0) / 100).toFixed(2)}</div></div>
      <div class="stat"><div class="n ${k.teachers === 0 && k.codes_unused ? 'low' : ''}">${k.codes_unused}</div>
        <div class="l">还没被兑的码<br>最近有人用 ${fmtDay(k.last_active_at)}</div></div>
    </div>

    <div class="field"><label>园所名称</label>
      <input type="text" id="k_name" value="${esc(k.name)}" style="width:100%"></div>
    <div class="grid2">
      <div class="field"><label>省份</label>
        <input type="text" id="k_prov" value="${esc(k.province || '')}" placeholder="广东" style="width:100%"></div>
      <div class="field"><label>城市</label>
        <input type="text" id="k_city" value="${esc(k.city || '')}" placeholder="广州" style="width:100%"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>城乡</label>
        <select id="k_area" style="width:100%"><option value="">未填</option>${sel(k.area_type, AREA_CN)}</select></div>
      <div class="field"><label>办园性质</label>
        <select id="k_own" style="width:100%"><option value="">未填</option>${sel(k.ownership, OWNER_CN)}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>在园教师人数</label>
        <input type="number" id="k_tc" value="${k.teacher_count ?? ''}" style="width:100%"></div>
      <div class="field"><label>在园幼儿人数</label>
        <input type="number" id="k_cc" value="${k.child_count ?? ''}" style="width:100%"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>联系人</label>
        <input type="text" id="k_cn" value="${esc(k.contact_name || '')}" placeholder="李园长" style="width:100%"></div>
      <div class="field"><label>联系电话</label>
        <input type="text" id="k_cp" value="${esc(k.contact_phone_masked ? '' : (k.contact_phone || ''))}"
          placeholder="${k.contact_phone_masked ? esc(k.contact_phone || '') + '（超管可见全号）' : ''}" style="width:100%"></div>
    </div>
    <div class="field"><label>备注</label>
      <input type="text" id="k_note" value="${esc(k.note || '')}" placeholder="合作起止、别的要记的事" style="width:100%"></div>

    <div class="foot">
      ${k.teachers ? `<button class="btn-sm" onclick="kgTeachers(${id})">看这个园的老师</button>` : ''}
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveKg(${id},${Boolean(k.contact_phone_masked)})">保存</button>
    </div>
  </div></div>`;
  render();
};

window.saveKg = async (id, phoneMasked) => {
  const v = (x) => document.getElementById(x).value.trim();
  const body = {
    name: v('k_name'), note: v('k_note'),
    province: v('k_prov'), city: v('k_city'),
    area_type: v('k_area'), ownership: v('k_own'),
    teacher_count: v('k_tc'), child_count: v('k_cc'),
    contact_name: v('k_cn'),
  };
  // 一般管理员看到的是打过码的号，输入框是空的 —— 她留空只是「没动」，
  // **不能当成「清空」**，否则她一保存就把全号刷掉了
  // （跟 image_models 那把 api_key 留空 = 不改，同一个坑）。
  // 超管看到的是全号，她清空就是真想清空，所以要传。
  const phone = v('k_cp');
  if (phone || !phoneMasked) body.contact_phone = phone;
  try {
    await api('POST', `/kindergartens/${id}/update`, body);
    toast('改好了'); S.modal = null; await load();
  } catch (e) { toast(e.message); }
};

/* ============ 反馈 ============ */
//
// **两个 tab，不是一个下拉筛选**（2026-08-18 用户提）。
// 原来「全部 / 教案评价 / 产品建议」混在一张表里，那张表只能取两类的并集：
// 教案评价有「哪一份、第几版」，产品建议有「分类」，两者都得留一列给对方，
// 于是每一行都有一半是「—」。分成两个 tab 之后每张表的列才能真正对上内容。

const SUGGEST_CN = { quality: '教案质量', feature: '想要新功能', usability: '用着别扭', other: '其他' };

function feedbackView() {
  const items = S.data.feedback?.items || [];
  const kind = S.filter.fbKind === 'lesson_rating' ? 'lesson_rating' : 'suggestion';
  const isRating = kind === 'lesson_rating';
  const tab = (k, label) =>
    `<button class="btn-sm ${S.filter.fbKind === k ? 'on' : ''}"
       style="${S.filter.fbKind === k ? 'background:var(--amber);border-color:var(--amber-line);color:var(--ink);font-weight:600' : ''}"
       onclick="pickFbKind('${k}')">${label}</button>`;

  return `<h2>反馈</h2>
    <div class="sub">${items.length ? `${items.length} 条，${items.filter((f) => !f.handled).length} 条没处理` : ''}</div>
    <div class="row">
      ${tab('suggestion', '关于产品')}
      ${tab('lesson_rating', '关于教案质量')}
    </div>
    ${items.length ? `<table>
      <tr><th>谁</th>${isRating ? '<th>评价</th><th>说的哪一份</th>' : '<th>分类</th>'}
          <th>内容</th><th>时间</th><th></th></tr>
      ${items.map((f) => `<tr style="${f.handled ? 'opacity:.55' : ''}">
        <td>${esc(f.real_name || '—')}<br><span style="font-size:11.5px;color:var(--ink-3)">${esc(f.kindergarten || '')}</span></td>
        ${isRating
          ? `<td>${ratingPill(f.rating)}</td>
             <td>${f.lesson_plan_id
                // 看到「用不了」能立刻翻出那一版的原文 —— 这是评价数据唯一的用处
                ? (f.plan_title === undefined
                    ? '<span style="color:var(--ink-3)">超管可见</span>'
                    : `<button class="btn-sm" onclick="openPlan(${f.lesson_plan_id},null,${f.plan_version || 'null'})">${esc(f.plan_title || '这份教案')} v${f.plan_version || '?'}</button>
                       <br><span style="font-size:11.5px;color:var(--ink-3)">${esc(f.age_group || '')}</span>`)
                : '—'}</td>`
          : `<td><span class="pill p-off">${SUGGEST_CN[f.category] || '其他'}</span></td>`}
        <td style="max-width:360px">${esc(f.text || '—')}</td>
        <td>${fmtDay(f.created_at)}</td>
        <td><button class="btn-sm" onclick="markHandled(${f.id},${!f.handled})">
          ${f.handled ? '标为未处理' : '标为已处理'}</button></td>
      </tr>`).join('')}
    </table>` : `<div class="empty">${isRating ? '还没有人评价过教案' : '还没有产品建议'}</div>`}`;
}
window.pickFbKind = async (k) => { S.filter.fbKind = k; await load(); };
window.markHandled = async (id, handled) => {
  try { await api('POST', `/feedback/${id}/handled`, { handled }); await load(); } catch (e) { toast(e.message); }
};

/* ============ 加载与渲染 ============ */
async function load() {
  if (!S.token) return render();
  S.loading = true; render();
  try {
    const jobs = {
      overview: api('GET', '/overview'),
      kindergartens: api('GET', '/kindergartens'),
      // 充值台账：概览那张卡要显示笔数，弹框打开时也要现成的列表
      topups: api('GET', '/topups'),
    };
    if (S.page === 'teachers') {
      const qs = new URLSearchParams();
      if (S.filter.q) qs.set('q', S.filter.q);
      if (S.filter.kg) qs.set('kindergarten_id', S.filter.kg);
      jobs.teachers = api('GET', `/teachers?${qs}`);
    }
    if (S.page === 'roster') {
      const q = new URLSearchParams();
      if (S.filter.roster.status !== 'all') q.set('status', S.filter.roster.status);
      if (S.filter.roster.q) q.set('q', S.filter.roster.q);
      jobs.roster = api('GET', `/roster?${q}`);
    }
    if (S.page === 'tasks') jobs.tasks = api('GET', '/tasks');
    if (S.page === 'codes') jobs.codes = api('GET', `/codes?status=${S.filter.codeStatus}`);
    if (S.page === 'feedback') jobs.feedback = api('GET', `/feedback?kind=${S.filter.fbKind}`);
    if (S.page === 'imagemodels' && isSuper()) jobs.imagemodels = api('GET', '/image-models');
    if (S.page === 'admins' && isSuper()) jobs.admins = api('GET', '/admins');
    if (S.page === 'logs' && isSuper()) {
      const q = new URLSearchParams();
      Object.entries(S.filter.log).forEach(([k, v]) => { if (v) q.set(k, v); });
      jobs.logs = api('GET', `/logs?${q}`);
    }

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
    kindergartens: kgView, roster: rosterView, feedback: feedbackView, tasks: tasksView,
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
  grant_quota: '发额度', create_code: '建兑换码', create_codes_batch: '批量建码',
  void_code: '作废码', export_codes: '导出兑换码',
  teacher_status: '停用/恢复老师',
  create_kindergarten: '建园所', update_kindergarten: '改园所',
  add_topup: '记充值',
  import_roster: '导入名单', void_roster: '作废名单一行', reassign_roster: '她换班了',
  create_task: '建任务', update_task: '改任务', publish_task: '发布任务', close_task: '收了任务',
  create_rebind_code: '生成换绑码', void_rebind_code: '作废换绑码',
  create_admin: '建管理员',
  admin_status: '停用/恢复管理员', reset_password: '重置密码',
  change_own_password: '改自己密码',
  create_image_model: '加配图模型', update_image_model: '改配图模型',
  delete_image_model: '删配图模型', test_image_model: '试画一张',
  set_default_image_model: '换默认配图模型',
};
//
// 2026-08-18 加了筛选和翻页。原来是一张倒序裸表 LIMIT 200 ——
// 攒到几百条之后它自己就废了：翻不动，而且第 201 条起根本看不到，
// 也就是说「查得到」这件事在数据变多之后悄悄失效了。
//
// 筛选下拉只列**真正出现过的**人和动作（后端回 admins / actions）：
// 列一堆从来没发生过的动作，筛选框自己就变成噪音。
function logsView() {
  const d = S.data.logs || {};
  const items = d.items || [];
  const f = S.filter.log;
  const total = d.total || 0;
  const page = d.page || 1;
  const pages = d.pages || 1;

  return `<h2>操作记录</h2>
    <div class="sub">${total ? `共 ${total} 条${pages > 1 ? `，第 ${page} / ${pages} 页` : ''}` : ''}</div>
    <div class="row">
      <select onchange="setLogFilter('admin_id',this.value)">
        <option value="">谁都行</option>
        ${(d.admins || []).map((a) => `<option value="${a.admin_id}" ${f.admin_id == a.admin_id ? 'selected' : ''}
          >${esc(a.display_name || a.username || `#${a.admin_id}`)}</option>`).join('')}
      </select>
      <select onchange="setLogFilter('action',this.value)">
        <option value="">做了什么都行</option>
        ${(d.actions || []).map((a) => `<option value="${esc(a.action)}" ${f.action === a.action ? 'selected' : ''}
          >${ACTIONS[a.action] || esc(a.action)}（${a.n}）</option>`).join('')}
      </select>
      <input type="date" value="${esc(f.from)}" onchange="setLogFilter('from',this.value)">
      <span style="color:var(--ink-3)">到</span>
      <input type="date" value="${esc(f.to)}" onchange="setLogFilter('to',this.value)">
      ${(f.admin_id || f.action || f.from || f.to)
        ? '<button class="btn-sm" onclick="clearLogFilter()">不筛了</button>' : ''}
    </div>
    ${items.length ? `<table>
      <tr><th>时间</th><th>谁</th><th>做了什么</th><th>对象</th><th>详情</th></tr>
      ${items.map((l) => `<tr>
        <td style="white-space:nowrap">${fmtDate(l.created_at)}</td>
        <td>${esc(l.display_name || l.username || '—')}</td>
        <td style="white-space:nowrap">${ACTIONS[l.action] || esc(l.action)}</td>
        <td class="mono">${esc(l.target || '—')}</td>
        <td style="font-size:12.5px;color:var(--ink-3)">${esc(JSON.stringify(l.detail || {}) === '{}' ? '' : JSON.stringify(l.detail))}</td>
      </tr>`).join('')}
    </table>
    ${pages > 1 ? `<div class="row" style="margin-top:14px;justify-content:center">
      <button class="btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="logPage(${page - 1})">上一页</button>
      <span style="font-size:13px;color:var(--ink-2)">第 ${page} / ${pages} 页</span>
      <button class="btn-sm" ${page >= pages ? 'disabled' : ''} onclick="logPage(${page + 1})">下一页</button>
    </div>` : ''}`
    : `<div class="empty">${(f.admin_id || f.action || f.from || f.to) ? '这个条件下没有记录' : '还没有操作记录'}</div>`}`;
}
window.setLogFilter = async (k, v) => {
  S.filter.log[k] = v;
  S.filter.log.page = 1;   // 换了条件回第一页，否则会停在一个不存在的页码上
  await load();
};
window.clearLogFilter = async () => {
  S.filter.log = { admin_id: '', action: '', from: '', to: '', page: 1 };
  await load();
};
window.logPage = async (p) => { S.filter.log.page = p; await load(); };

load();

/* ============ 批量建码与导出 ============ */
//
// 一次只能建一个的时候，实际流程是「问卷星导出一批答卷 → 一个个建」，
// 二十个老师就要点二十遍。
//
// **码不绑手机号**（2026-08-18 用户原话：「任何手机都可以使用这个兑换码，
// 兑换完之后会落到这个手机号所在的账户上而已」）。所以这里不收名册 ——
// 只说「要几个、每个给多少」，谁拿到谁能兑。
//
// 这也是额度**唯一**的入口了：后台的「发额度」按钮撤掉了，
// 老师完成新任务也是再发一个码，她自己兑（`POST /auth/redeem` 支持续兑）。

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

/**
 * 建完一批之后，**当场就要能拿走**（2026-08-18 用户提）。
 *
 * 原来只 toast 一句「建了 20 个」，然后得回列表页从几十个未使用的码里
 * 认出刚才那 20 个 —— 而列表是按创建时间倒序混在一起的，分不出哪批是哪批。
 * 现在一行一个铺出来，两个按钮：全选复制（贴进微信）、下载 CSV（发给园所或灌问卷星）。
 */
window.saveBatchCodes = async () => {
  try {
    const d = await api('POST', '/codes/batch', {
      count: Number(document.getElementById('b_count').value) || 20,
      init_text: Number(document.getElementById('b_text').value) || 20,
      init_image: Number(document.getElementById('b_image').value) || 10,
      kindergarten_id: document.getElementById('b_kg').value || null,
      grant_reason: document.getElementById('b_reason').value.trim(),
    });
    S.batch = d;                 // 下载 CSV 时要用到整批的参数
    showBatchResult(d);
    load();
  } catch (e) { toast(e.message); }
};

function showBatchResult(d) {
  const b = d.batch || {};
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
    <div class="box" style="width:560px">
    <h3>建好了 ${d.created.length} 个</h3>
    <div class="sub" style="margin-bottom:12px">每个 ${b.init_text} 教案 / ${b.init_image} 配图${
      b.kindergarten ? ` · ${esc(b.kindergarten)}` : ''}</div>
    <textarea id="batchbox" readonly rows="10"
      style="width:100%;font-family:ui-monospace,Consolas,monospace;font-size:13.5px;
             letter-spacing:.04em;line-height:1.9;resize:vertical"
      >${esc(d.created.join('\n'))}</textarea>
    <div class="foot">
      <button class="btn-sm" onclick="copyBatch()">全选复制</button>
      <button class="btn-sm" onclick="downloadBatchCsv()">下载 CSV</button>
      <button class="btn" onclick="closeModal()">好</button>
    </div>
  </div></div>`;
  render();
}

window.copyBatch = () => {
  const ta = document.getElementById('batchbox');
  if (!ta) return;
  // 先 select 再写剪贴板：clipboard 被浏览器策略挡住时，选中状态还能让人手动 Ctrl+C
  ta.select();
  navigator.clipboard?.writeText(ta.value)
    .then(() => toast(`复制了 ${ta.value.split('\n').length} 个码`))
    .catch(() => toast('复制被浏览器挡了，已经选中，按 Ctrl+C'));
};

/** 就地生成 CSV：整批的参数都在手上，不用再跑一趟后端 */
window.downloadBatchCsv = () => {
  const d = S.batch;
  if (!d) return;
  const b = d.batch || {};
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['兑换码', '幼儿园', '教案额度', '配图额度', '说明'].map(cell).join(',')]
    .concat(d.created.map((c) =>
      [c, b.kindergarten || '', b.init_text, b.init_image, b.grant_reason || ''].map(cell).join(',')));
  // BOM：没有它 Excel 打开中文列头是乱码
  const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `兑换码-${d.created.length}个.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('下载好了');
};

/** 导出 CSV。可能带手机号全号，所以后端只让超管调；单个码也走同一条路 */
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
