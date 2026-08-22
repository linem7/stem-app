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
  mePanel: false,          // 左下角个人中心那个面板开没开
  // 反馈默认**全部**（2026-08-22 两个 tab 合成一张表之后）。
  // 原来默认落在「产品建议」那一类：那是需要动手回应的。
  // 现在一张表里两类都在，先看全部更合理 —— 要单看某一类走列头筛选
  filter: {
    kg: '', q: '', codeStatus: 'all',
    fbKind: 'all', fbCategory: '', fbHandled: '',
    // 老师页那排 tab。'current' = 在岗（pending + claimed），
    // 不含 moved —— 那是她换班后留下的历史行，跟当前那一行是同一个人
    teacherStatus: 'current',
    // 年级 / 班级 / 岗位（2026-08-22 加）。这三个是**前端筛** ——
    // 后端 GET /teachers 没有这三个参数，而这一页本来就一次把人全拿回来了
    age: '', cls: '', pos: '',
    // 园所页那三列，同样前端筛。它们正好是任务定向筛的三个字段
    kgCity: '', kgArea: '', kgOwn: '',
    // 操作记录：`group`（5 组之一）和 `range`（24h / 7d / 30d）。
    // 原来是 action（单个动作）+ from/to（两个日期框），两者 2026-08-22 都换掉了。
    // ⚠️ 后端那四个参数**还收**（回归脚本按它们断言），只是界面不再发
    log: { admin_id: '', group: '', range: '', page: 1, per: 20 },
  },
};

/* ── 分页（2026-08-22 用户对四张汇总表都提了同一件事）─────────────────
   「默认预览 20 条，可选 50 和 100，多出的翻页」——
   教师 / 兑换码 / 任务 / 操作记录四处一模一样，所以只写一份。

   ⚠️ 教师、兑换码、任务是**在前端切片**（后端一次给全部，几十到几百行量级）；
   操作记录是**后端分页**（它能攒到上万条）。所以 `pageOf` 只管前三个，
   操作记录走 `S.filter.log.page` + 后端的 `per` 参数。
   判据跟反馈页那条一样：哪一页开始变慢就把它挪到后端。 */
const PER_OPTS = [20, 50, 100];
const S_PG = {};                       // { teachers: {page, per}, ... }
const pg = (k) => (S_PG[k] ||= { page: 1, per: 20 });

/** 每页条数下拉。换条数**必须回第一页** —— 原来停在第 3 页、改成每页 100 之后
    总共只剩 1 页，那时留在第 3 页看到的是一张空表 */
const perSelect = (k) => `<select onchange="setPer('${k}',this.value)">
  ${PER_OPTS.map((n) => `<option value="${n}" ${pg(k).per === n ? 'selected' : ''}>每页 ${n} 条</option>`).join('')}
</select>`;
window.setPer = (k, n) => { pg(k).per = Number(n) || 20; pg(k).page = 1; render(); };
window.setPage = (k, p) => { pg(k).page = p; render(); };

/** 把一整份列表切成当前这一页。回 { items, page, pages, total } */
function paginate(k, all) {
  const { per } = pg(k);
  const pages = Math.max(1, Math.ceil(all.length / per));
  const page = Math.min(Math.max(1, pg(k).page), pages);
  pg(k).page = page;                   // 越界了拉回来，否则翻页条上的数字跟内容对不上
  return { items: all.slice((page - 1) * per, page * per), page, pages, total: all.length };
}

/** 翻页条。只有一页时整条不出现 —— 一条永远点不动的翻页比没有更碍眼 */
function pagerBar(k, page, pages, fn = 'setPage') {
  if (pages <= 1) return '';
  return `<div class="row" style="margin-top:14px;justify-content:center">
    <button class="btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="${fn}('${k}',${page - 1})">上一页</button>
    <span style="font-size:13px;color:var(--ink-2)">第 ${page} / ${pages} 页</span>
    <button class="btn-sm" ${page >= pages ? 'disabled' : ''} onclick="${fn}('${k}',${page + 1})">下一页</button>
  </div>`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '—');
/**
 * `2026-08-22 14:05`（2026-08-22 用户指定教案记录用这个格式）。
 *
 * 不用 toLocaleString：`zh-CN` 那套给的是「2026/8/22 14:05」——
 * 月和日不补零，一列日期长短不一，扫不齐；而这一列正是按时间排序的。
 */
const fmtStamp = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
};

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
    <p>教师账号无法登录此处。</p>
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
  // 「名单」这个顶级页 **2026-08-21 撤掉了**（用户判断它跟这两页重复：
  // 「所谓的名单，要么是园所名单（已经存在），要么是教师名单（应该归属到教师页面）」）。
  // 名单并进了「老师」——那一页现在一行 = 一个岗位，激活了的多带额度，
  // 导入名单的入口也在那儿。**别把 roster 加回这个表**，加回来就又是两份。
  teachers: '教师',
  codes: '兑换码',
  feedback: '反馈',
  tasks: '任务',
};
/**
 * 只有超级管理员看得到的页。
 *
 * 侧栏上那个小标题 2026-08-21 从「超级管理员」改成「后台管理」：
 * 原来那个名字说的是**谁能看**（一个角色），而分组该说的是**这里面是什么**。
 * 这三页共同的性质是配置和审计，不是日常运营。
 *
 * 「管理员」→「管理员账号」：那一页是账号列表，「新建」只是上面一个按钮，
 * 用名词而不是动作名。
 *
 * 顺序也换了：账号排最前 —— 三页里只有它是会经常动的。
 */
const SUPER_PAGES = { admins: '管理员账号', imagemodels: '配图模型', logs: '操作记录' };

function shell(inner) {
  const n = S.data.overview?.todo?.feedback_new || 0;
  return `<div class="wrap">
    <div class="side">
      <div class="brand">STEAM 教案助手<small>管理后台</small></div>
      ${Object.entries(PAGES).map(([k, v]) => `
        <button class="nav ${S.page === k ? 'on' : ''}" onclick="goto('${k}')">${v}
          ${k === 'feedback' && n ? `<span class="badge">${n}</span>` : ''}</button>`).join('')}
      ${isSuper() ? `<div class="navsec">后台管理</div>
        ${Object.entries(SUPER_PAGES).map(([k, v]) => `
          <button class="nav ${S.page === k ? 'on' : ''}" onclick="goto('${k}')">${v}</button>`).join('')}` : ''}
      ${mePanel()}
    </div>
    <div class="main">${inner}</div>
  </div>${S.modal || ''}`;
}

/**
 * 个人中心 —— 侧栏最底下那一行，点了向上弹（2026-08-21 用户提）。
 *
 * 为什么挪到左下角：这几项（改密码、字号、称呼、退出）跟左边那列**页面**不是一类东西。
 * 原来它们是 .who 里四行平铺的小链接，紧跟在最后一个导航项下面 ——
 * 于是「退出」读起来像第十一个页面。
 *
 * 那一行是**开关**：点开、再点收起，箭头跟着转。
 * 面板里**没有「关闭」** —— 多一个关闭等于给同一件事留两个入口。
 * 所以 toggleMe 必须是 toggle，写成「只负责打开」的话点第二下没反应。
 * （小程序那边的个人档案行踩过同一个坑，见 2026-08-21 的交接。）
 */
function mePanel() {
  // 🔴 **只显示账号名**（2026-08-22 用户提）。原来这一块把同一件事写了三遍：
  // 面板抬头「超级管理员」、那一行的 nm、再加一个「超管」胶囊 ——
  // 而侧栏底下这一行要回答的问题只有一个：「我现在用的是哪个账号」。
  // 「我是什么角色」挪进了「基本信息」（用户第二条），那里才是查身份的地方。
  const who = S.me?.username || '';
  const open = S.mePanel;
  return `<div class="me-wrap">
    ${open ? `<div class="me-panel">
      <button class="me-item" onclick="openMyProfile()">基本信息</button>
      <button class="me-item" onclick="openChangePwd()">修改密码</button>
      <button class="me-item danger" onclick="logout()" style="margin-top:6px">退出登录</button>
    </div>` : ''}
    <button class="me-row ${open ? 'on' : ''}" onclick="toggleMe()">
      <span class="nm">${esc(who)}</span>
      <span class="car">▲</span>
    </button>
  </div>`;
}
window.toggleMe = () => { S.mePanel = !S.mePanel; render(); };

/* 界面字号三档 **2026-08-22 整个撤掉了**（用户定：「不需要变化字号」）。
   FONT_SCALES / FONT_ZOOM / fontScale / applyFontScale / setFontScale 全删，
   index.html 里的 `zoom` 和 `.seg` 样式一起删。localStorage 里那个
   `admin_fs` 不去清：它只是一个没人读的旧键，清它要多写一段一次性代码。 */

/**
 * 基本信息 —— **只读的一屏**（2026-08-22）。
 *
 * 「显示名称」那个能填的框撤掉了（用户：新建管理员不要显示名称，
 * 一律按账号名认人）。撤掉之后 `admins` 表里能算「个人信息」的一项都不剩，
 * 所以这一屏没有保存按钮，也不是漏了。
 *
 * 那它还有什么用：**回答「我是谁、什么权限」**。用户明确要求
 * 「基本信息那里再写清楚是超级管理员」—— 侧栏那一行现在只有账号名了，
 * 角色得有个地方看得到。
 *
 * 后端 `POST /me/profile` 和 `display_name` 那一列**都留着**，只是没有界面入口：
 * 回归脚本在测它，而且操作记录里历史数据还带着旧的显示名。
 */
window.openMyProfile = () => {
  S.mePanel = false;
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>基本信息</h3>
    <div class="grid2">
      <div class="field"><label>用户名</label>
        <input type="text" value="${esc(S.me?.username || '')}" disabled style="width:100%"></div>
      <div class="field"><label>角色</label>
        <input type="text" value="${isSuper() ? '超级管理员' : '一般管理员'}" disabled style="width:100%"></div>
    </div>
    <div class="foot">
      <button class="btn" onclick="closeModal()">关闭</button>
    </div>
  </div></div>`;
  render();
};

window.goto = async (p) => { S.page = p; S.modal = null; S.mePanel = false; await load(); };
window.logout = () => {
  S.token = null; S.me = null; S.mePanel = false;
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
    td.feedback_new ? `<b>${td.feedback_new}</b> 条反馈待处理` : '',
    td.gen_failed_7d ? `<b>${td.gen_failed_7d}</b> 次生成失败（近 7 天）` : '',
    td.images_failed_7d ? `<b>${td.images_failed_7d}</b> 张配图失败（近 7 天）` : '',
    (td.codes_unused ?? 0) < 5 ? `未使用兑换码仅剩 <b>${td.codes_unused ?? 0}</b> 个` : '',
    (td.low_quota || []).length ? `<b>${td.low_quota.length}</b> 位教师额度不足` : '',
    // 原来这里还有一条「账面只剩 X，该充值了」。2026-08-21 跟着余额概念一起撤了 ——
    // 那个数靠手录充值算出来，漏录一笔就虚高，而它长得像个准数。
    // 真要知道还剩多少，去 DeepSeek / 12ai / MiniMax 各自的后台看
  ].filter(Boolean);

  return `<h2>概览</h2>
    ${todo.length
      ? `<div class="note" style="background:var(--amber-soft)"><b>待处理</b><br>${todo.join('<br>')}</div>`
      : '<div class="note"><b>暂无待处理事项</b></div>'}

    <!-- 2026-08-21 精简。原来每张卡的小字都是两行，其中一半是**能从别处推出来的**
         或者纯说明性的。按 CLAUDE.md 那条判据「删掉它，她还能不能把事办成」逐条过：
           · 「花了 ￥X」＝ 后面配图 + 文本两张卡加起来，删
           · 「充值台账 N 笔」＝ 那个按钮点进去第一眼就是笔数，删
           · 「这是产品最大的未知数」＝ 设计理由，属于文档不属于界面，删
           · 「充了 ￥X」保留：账面余额看不出充了多少，推不出来
           · 「本月」「7 天」保留：它们是**另一个数**，不是对主数的解释 -->
    <!-- 🔴 **只记花费，没有「剩余」**（2026-08-21 用户定）。
         原来第一张卡是「账面还剩 ￥X / 充了 ￥Y」，右边还有一个「记一笔充值」。
         余额那个数靠手录充值算出来，漏录一笔就静静地虚高，
         而真实余额在 DeepSeek / 12ai / MiniMax 各自的后台里 —— 那三个才是能对账的。
         **别把余额加回来。** -->
    <!-- 2026-08-22 又压了一轮（用户第二次提「小字还是太多」）。
         这次的做法是把**主标签压到两三个字**：原来是「花费总额 / 本月 ￥0.78」，
         主标签里的「花费」跟版块标题「花费」重复了一遍，删掉就短了两个字。
         第二行**不再删** —— 那些都是「另一个数」，不是对主数的解释。 -->
    <!-- 卡片 2026-08-22 第二轮：**标签在上、小字；数字在下、大字居中**
         （用户原话「总支出字数小一点，数字正中间大一些」）。
         顺序是「先知道这是什么，再读那个数」—— 反过来的话扫到的是一个
         不知道在说什么的数字。
         .stats--half 是「只占 50% 横向版面」（用户同一轮要的）。 -->
    <div class="sub" style="margin-bottom:8px"><b>花费</b></div>
    <div class="stats stats--half">
      <div class="stat"><div class="t">总支出</div><div class="n">${yuan(m.spent_cents)}</div>
        <div class="l">本月 ${yuan(m.month_cents)}</div></div>
      <div class="stat"><div class="t">配图</div><div class="n">${yuan(m.spent_image_cents)}</div>
        <div class="l">本月 ${yuan(m.month_image_cents)}</div></div>
      <div class="stat"><div class="t">文本</div><div class="n">${yuan(m.spent_text_cents)}</div>
        <div class="l">本月 ${yuan(m.month_text_cents)}</div></div>
    </div>
    <!-- 这条留着。它是**边界说明**不是解释性小字（CLAUDE.md 两种例外之一）：
         不说这句，上面那个总支出会被当成全部历史，而它其实缺了一段 -->
    ${(m.images_missing_cost || !m.text_tracked_since) ? `<div class="note" style="margin-top:-8px">
      统计不完整：${[
        m.images_missing_cost ? `早期 ${m.images_missing_cost} 张配图未记成本` : '',
        m.text_tracked_since ? `文本成本自 ${fmtDay(m.text_tracked_since)} 起记录` : '文本成本尚未记录',
      ].filter(Boolean).join('，')}
    </div>` : ''}

    <div class="sub" style="margin:18px 0 8px"><b>使用情况</b></div>
    <div class="stats stats--half">
      <div class="stat"><div class="t">园所</div><div class="n">${u.kindergartens ?? '—'}</div>
        <div class="l">活跃 ${u.kindergartens_active_7d ?? 0}</div></div>
      <div class="stat"><div class="t">已激活教师</div><div class="n">${u.teachers ?? '—'}</div>
        <div class="l">活跃 ${u.teachers_active_7d ?? 0}</div></div>
      <!-- 教案评价那三档现在**只在这里**看得到（反馈表那一列 08-22 撤了），
           所以这一行小字不能省 —— 它是「AI 写的教案能不能用」唯一的汇总 -->
      <div class="stat"><div class="t">教案评价</div>
        <div class="n ${rated === 0 ? '' : (q.unusable > q.usable ? 'low' : '')}">${rated || '—'}</div>
        <div class="l">${rated
          ? `可用 ${q.usable} · 需改 ${q.needs_edit} · 不可用 ${q.unusable}` : '暂无'}</div></div>
    </div>

    <!-- 「园所概况」那张表 **2026-08-22 撤掉了**（用户定）。
         它跟园所页那张表回答同一个问题、列还更少，而花费这一列已经挪进园所列表 ——
         判断「这个园值不值得续」要看的是那一整行（地区、性质、起始合作、花费），
         不是孤零零一个花费数。后端那段 SQL 一起删了，别只删一半。 -->

    ${(td.low_quota || []).length ? `
    <div class="sub" style="margin:18px 0 8px"><b>额度不足的教师</b></div>
    <table>${td.low_quota.map((t) =>
      `<tr><td>${esc(t.name || '—')}</td><td>${esc(t.kindergarten || '—')}</td>
       <td class="num low">剩余 ${t.text_left} 次</td>
       <td><button class="btn-sm" onclick="goto('codes')">新建兑换码</button></td></tr>`).join('')}</table>` : ''}`;
}

/* 充值台账 openTopup / saveTopup **2026-08-21 整个删掉了**（用户定）。
   概览不再有「账面还剩」那张卡，也没有「该充值了」那条待处理。
   理由写在 services/costLedger.js 的文件头：余额靠手录充值算出来，
   漏录一笔就静静地虚高，而真实余额在三家平台各自的后台里。
   后端 GET/POST /topups 是一起删的 —— **要恢复别只恢复一半。** */

/* ============ 老师 ============ */
/**
 * 老师 —— **名单和已激活账号一张表**（2026-08-21 用户定）。
 *
 * 一行 = 一个岗位（人 × 园 × 班 × 岗位）。激活了的那些多带账号和额度，
 * 没激活的额度那两列是「—」（她还没有账号，不是「额度为 0」）。
 *
 * ⚠️ 后端 `GET /teachers` 的 `q` **仍然支持按兑换码搜**（回归脚本在测它）。
 * 兑换码那一列上一轮删了，但能力没删 —— 只是不摆在 placeholder 里占字数。
 */
/**
 * 列标题里的筛选下拉（2026-08-22 用户提：「把下拉框放到汇总表的列标题上」）。
 *
 * 原来那排 tab 按钮的问题：五个按钮占满一行，而它筛的是**表里某一列**——
 * 筛选控件离它作用的那一列越远，人越要在两处之间来回对。
 * 放在列头上，「这一列正在被筛」和「筛的是什么值」是同一个位置。
 *
 * 🔴 **列名和选中值共用同一个位置**（用户 08-22 第二次提，原话：
 * 「你现在同时呈现列名和选项是不对的，例如类型/产品反馈，
 *   实际上用户选择产品反馈后列名就只要保留产品反馈就好了」）。
 * 所以这里不再输出 `label`，而是把 label 塞给「不筛」那一个选项 ——
 * 没筛时 select 显示的就是列名，筛了就显示筛的是什么。
 *
 * @param label   列名。同时也是「不筛」那一项的文字
 * @param options `[[值, 文字], ...]`，**不含**「不筛」那一项，本函数补在最前面
 * @param allValue 「不筛」对应的值。多数是 ''，教师页是 'current'、反馈类型是 'all'
 *
 * `on` 那个类不是装饰：一列被筛过之后表里少了几行，
 * 不给标记的话那会被当成数据丢了。
 */
function thFilter(label, key, options, cur, allValue = '', width = 0) {
  // 🔴 **筛中之后不加任何样式**（用户 08-22 第三次提「保持纯文本就好了」）。
  // 那条「正在被筛必须看得出来」的老规则改由两样东西满足，都不靠颜色：
  // ① 这个 select 显示的就是选中的那个值（不筛才显示列名）；
  // ② 每个有筛选的页面都有一个**常驻**的「清除筛选」按钮。见 index.html 那段
  const all = [[allValue, label], ...options];
  // width 是给 .tbl-fixed 用的：那种表**每一列都得写 width**，
  // 漏掉的会去平分余量（两个字的「年级」跟十个字的「园所」一样宽）
  return `<th${width ? ` style="width:${width}px"` : ''}><select class="thf" onchange="setColFilter('${key}',this.value)">
    ${all.map(([v, l]) => `<option value="${esc(String(v))}" ${String(cur ?? '') === String(v) ? 'selected' : ''}
      >${esc(l)}</option>`).join('')}
  </select></th>`;
}

/** 常驻的「清除筛选」（2026-08-22 用户定：不要等用户筛过了才出现）。
    没筛过的时候它是禁用态 —— 位置固定，工具条不会因为筛没筛而抖一下 */
const clearBtn = (fn, active) =>
  `<button class="btn-sm" ${active ? '' : 'disabled'} onclick="${fn}()">清除筛选</button>`;
window.setColFilter = async (key, v) => {
  if (key === 'teacherStatus') S.filter.teacherStatus = v || 'current';
  else S.filter[key] = v;
  // 换了筛选条件回第一页 —— 不回的话「筛出 3 条」而你停在第 2 页，看到的是空表
  Object.values(S_PG).forEach((p) => { p.page = 1; });
  // 这几个是**前端筛**（后端没有对应参数），不用重新请求；
  // 园所（教师页那一列）和状态是后端筛的，得重新拉。
  // ⚠️ 加新的前端筛选列时要记得加进这个名单 —— 漏了的表现是「筛一下整页重新请求
  // 一遍，结果一样」，慢但不报错，很难注意到
  if (['age', 'cls', 'pos', 'kgCity', 'kgArea', 'kgOwn', 'fbHandled'].includes(key)) render();
  else await load();
};

function teachersView() {
  const all = S.data.teachers?.items || [];
  const c = S.data.teachers?.counts || {};
  const kgs = S.data.kindergartens?.items || [];
  const cur = S.filter.teacherStatus || 'current';
  const f = S.filter;

  /* 年级 / 班级 / 岗位三列的筛选（2026-08-22 用户提「筛选功能没有应用到
     年级，班级和岗位上」）。**在前端筛**，选项也从当前这批数据里现取 ——
     后端那三个字段没有筛选参数，而这一页本来就一次性把人全拿回来了。
     从数据里取选项而不是写死一份清单：班级名是导名单时人填的自由文本
     （「小一班」「混龄班」「大二班」都有），写死必然对不上。 */
  const vals = (k) => [...new Set(all.map((t) => t[k]).filter(Boolean))].sort();
  const items0 = all.filter((t) =>
    (!f.age || t.age_group === f.age)
    && (!f.cls || t.class_name === f.cls)
    && (!f.pos || t.position === f.pos));
  const { items, page, pages } = paginate('teachers', items0);
  const filtered = Boolean(f.q || f.kg || f.age || f.cls || f.pos || cur !== 'current');

  // 标题底下那行汇总小字（「共 14 位，其中 0 位已激活」）**2026-08-22 删了**（用户提）。
  // 判据还是那一条：删掉它，她还能不能把事办成 —— 能。
  // 「有几位」表里数得出来、翻页条上有页数；「几位已激活」在「状态」那一列筛一下就是。
  // 这是全后台第七处同类小字，一起删的
  return `<h2>教师</h2>
    <div class="row row--tools">
      <button class="btn" onclick="openRosterImport()">＋ 导入名单</button>
      <input type="text" id="q" placeholder="搜索姓名 / 班级 / 编号" value="${esc(S.filter.q)}"
        onkeydown="if(event.key==='Enter')doSearch()" style="width:200px">
      <button class="btn-sm" onclick="doSearch()">查询</button>
      ${perSelect('teachers')}
      ${clearBtn('clearTeacherFilter', filtered)}
    </div>
    <!-- 列序 2026-08-22 用户定：编号 / 姓名 / 园所 / 年级 / 班级 / 岗位 /
         状态 / 教案额度 / 配图额度 / 详情。
         「年级·班级·岗位」原来挤在一列里用「·」连着 —— 那三样是三个独立的维度
         （年级筛任务、班级认人、岗位定角色），连成一句话就没法按列扫。

         🔴 **每行只剩一个「详情」按钮。** 岗位调整和作废收进详情里了：
         原来一行最多三个按钮、最少一个，右边缘参差不齐，而那两个动作
         都是低频的。未激活的行也点得开详情（那一屏读名单那一行，见 openTeacherRow）。 -->
    ${items.length ? `<table class="tbl-fixed">
      <!-- 列宽写死（.tbl-fixed 加这里的 width）：不固定的话筛掉几行之后
           最长的那个园所名不见了，那一列就窄一截，整张表跟着重排 —— 见 index.html -->
      <tr><th style="width:70px">编号</th><th style="width:110px">姓名</th>
          ${thFilter('园所', 'kg', kgs.map((k) => [k.id, k.name]), S.filter.kg, '', 190)}
          ${thFilter('年级', 'age', vals('age_group').map((v) => [v, v]), f.age, '', 80)}
          ${thFilter('班级', 'cls', vals('class_name').map((v) => [v, v]), f.cls, '', 96)}
          ${thFilter('岗位', 'pos', vals('position').map((v) => [v, v]), f.pos, '', 88)}
          ${thFilter('状态', 'teacherStatus', [
            ['claimed', `已激活${c.claimed != null ? ` (${c.claimed})` : ''}`],
            ['pending', `未激活${c.pending != null ? ` (${c.pending})` : ''}`],
            ['moved', `已调岗${c.moved != null ? ` (${c.moved})` : ''}`],
            ['void', `已作废${c.void != null ? ` (${c.void})` : ''}`],
          ], cur, 'current', 110)}
          <th style="width:92px">教案额度</th><th style="width:92px">配图额度</th>
          <!-- 「详情」那一列原来是 64px，一个 .btn-sm 放不下（用户提「太窄了」） -->
          <th style="width:80px"></th></tr>
      ${items.map((t) => `<tr style="${t.roster_status === 'void' || t.roster_status === 'moved' ? 'opacity:.55' : ''}">
        <!-- 编号 = teacher_ref = 人。她换班也不变，研究追人靠它。
             没有名单行的老账号没有这个数，不编一个 -->
        <td class="mono">${t.teacher_ref ?? '—'}</td>
        <td>${esc(t.real_name || '—')} ${t.status === 'disabled' ? '<span class="pill p-off">已停用</span>' : ''}</td>
        <td>${esc(t.kindergarten || '—')}</td>
        <td>${esc(t.age_group || '—')}</td>
        <td>${esc(t.class_name || '—')}</td>
        <td>${esc(t.position || '—')}</td>
        <!-- 激活列**只回答激活与否**（2026-08-22 用户提）。
             原来这一列混了四种值：已激活 / 未激活 / 已调岗 / 已作废 ——
             后两个说的是**名单那一行的状态**，不是激活状态，混在一列里
             读的时候得先分辨「这个词是在回答哪个问题」。
             调岗和作废降为后面的小字。颜色不是唯一载体：胶囊里有字。 -->
        <td style="white-space:nowrap">${t.activated
            ? '<span class="pill p-ok">已激活</span>'
            : '<span class="pill p-off">未激活</span>'}${
            t.activated && t.claimed_at
              ? `<br><span style="font-size:11.5px;color:var(--ink-3)">${fmtDay(t.claimed_at)}</span>`
              : t.roster_status === 'void'
                ? '<br><span style="font-size:11.5px;color:var(--ink-3)">已作废</span>'
                : t.roster_status === 'moved'
                  ? '<br><span style="font-size:11.5px;color:var(--ink-3)">已调岗</span>' : ''}</td>
        <!-- 没激活时是「—」而不是 0：她还没有账号，「0 次额度」是另一回事 -->
        <td class="num ${t.activated && t.quota.text.left <= 2 ? 'low' : ''}">${
          t.activated ? `${t.quota.text.left} / ${t.quota.text.granted}` : '—'}</td>
        <td class="num ${t.activated && t.quota.image.left <= 2 ? 'low' : ''}">${
          t.activated ? `${t.quota.image.left} / ${t.quota.image.granted}` : '—'}</td>
        <td><button class="btn-sm" onclick="openTeacherRow(${t.id ?? 'null'},${t.roster_id ?? 'null'})"
          >详情</button></td>
      </tr>`).join('')}
    </table>
    ${pagerBar('teachers', page, pages)}`
      : `<div class="empty">${filtered ? '当前条件下无记录' : '暂无教师名单，合作园提供名单后导入'}</div>`}`;
}

/**
 * 一行「详情」点下去要打开哪一屏。
 *
 * 两种行长得一样，但背后的东西完全不同：
 *   · **已激活** → 有账号 → `GET /teachers/:id`，那一屏有额度、教案、反馈
 *   · **未激活** → 只有名单那一行，没有账号 → 库里没有任何可查的用量，
 *     所以不请求后端，直接拿列表里已有的那一行渲染
 *
 * 🔴 原来未激活的行**根本没有详情按钮**（`t.id` 是 null）。
 * 而岗位调整和作废这两个动作恰恰主要发生在未激活的行上 ——
 * 把它们收进详情之后，不给未激活行一个详情入口，等于把这两个动作删了。
 */
window.openTeacherRow = (teacherId, rosterId) => {
  S.teacherPlanPage = 1;      // 换人了要回第一页，否则会停在上一位老师的页码上
  if (teacherId) return openTeacher(teacherId, rosterId);
  return openRosterOnly(rosterId);
};
/** 教案列表翻页。整屏重建（openTeacher 重跑一次），所以页码得存在 S 上 */
window.teacherPlanPage = (id, rid, p) => {
  S.teacherPlanPage = p;
  openTeacher(id, rid);
};

/** 未激活那一行的详情：名单信息 + 两个动作。数据全在 S.data.teachers 里，不用请求 */
window.openRosterOnly = (rosterId) => {
  const r = (S.data.teachers?.items || []).find((x) => x.roster_id === rosterId);
  if (!r) return;
  const who = r.real_name || (r.teacher_ref ? `编号 ${r.teacher_ref}` : '（未填写姓名）');
  const canAct = r.roster_status === 'pending' || r.roster_status === 'claimed';
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>${esc(who)} <span class="pill p-off">未激活</span></h3>
    ${profileBlock([
      ['编号', r.teacher_ref ?? null],
      ['园所', r.kindergarten],
      ['年级', r.age_group],
      ['班级', r.class_name],
      ['岗位', r.position],
    ])}
    <!-- 这句是**边界说明**，不是解释性小字：不说的话，一屏没有额度、
         没有教案、没有反馈的详情会被当成数据没加载出来 -->
    <div class="note" style="margin-top:12px">该教师尚未使用兑换码激活，暂无账号与用量数据。</div>
    <div class="foot">
      ${canAct ? `<button class="btn-sm" onclick="openReassign(${rosterId})">岗位调整</button>` : ''}
      ${r.roster_status === 'pending'
        ? `<button class="btn-sm btn-danger" onclick="voidRoster(${rosterId})">作废</button>` : ''}
      <button class="btn" onclick="closeModal()">关闭</button>
    </div>
  </div></div>`;
  render();
};

/**
 * 「个人信息」那一块。名值成对铺开，**空的那几项照样占一行**（显示「—」）。
 *
 * 为什么不把空项藏起来：藏了之后「这一项她没填」和「这个字段不存在」
 * 长得一模一样 —— 而学历、教龄正是要盯着补齐的东西。
 *
 * 🔴 `null` 一律出「—」，**不许出「未评定」也不许出 0**：
 * 「未评定」是职称那一栏她主动选的一个值，`teaching_years: 0` 是「今年刚入职」，
 * 都跟「没填过」不是一回事（018 迁移的注释里写着这条）。
 */
function profileBlock(pairs) {
  return `<div class="card" style="padding:12px 16px;margin-bottom:0">
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px 16px">
      ${pairs.map(([k, v]) => `<div>
        <div style="font-size:11.5px;color:var(--ink-3)">${esc(k)}</div>
        <div style="font-size:13.5px">${v === null || v === undefined || v === '' ? '—' : esc(String(v))}</div>
      </div>`).join('')}
    </div>
  </div>`;
}
window.doSearch = async () => {
  S.filter.q = document.getElementById('q')?.value || '';
  await load();
};
window.clearTeacherFilter = async () => {
  S.filter.q = ''; S.filter.kg = ''; S.filter.teacherStatus = 'current';
  S.filter.age = ''; S.filter.cls = ''; S.filter.pos = '';
  pg('teachers').page = 1;
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
 * 教师详情 —— **2026-08-22 砍成两块：个人信息 + 教案列表**（用户定）。
 *
 * 原话：「不需要显示跟额度有关的信息，包括使用情况和兑换情况，
 * 也不需要反馈记录，只需要个人信息和教案列表就好」。
 *
 * 撤掉的：三张额度统计卡、额度发放记录表、配图用量胶囊、反馈记录表。
 * 额度那几样在**教师列表**那一行上就有（教案额度 / 配图额度两列），
 * 而反馈有它自己一整页 —— 这一屏原来是把三个页面的东西堆在一个弹窗里。
 *
 * 留下的除了那两块，还有：
 *   · 编号和兑换码 —— 那是「她是谁」。匿名码激活的老师没有手机号，
 *     认她只能靠编号和她兑的那个码（CLAUDE.md）。**这不是「兑换情况」**，
 *     「兑换情况」指的是额度台账
 *   · 底部三个动作（岗位调整 / 重新绑定微信 / 停用）和未使用的换绑码提示
 *
 * 教案列表**默认 10 条 + 翻页**（用户定）：她写了 40 份的话，
 * 一个弹窗里铺 40 行得滚很久，而要看的往往是最近那几份。
 */
window.openTeacher = async (id, rosterId) => {
  // 没传就从列表那一行里找。doRebind / voidRebind 做完会重开这一屏，
  // 它们不带 rosterId —— 不兜底的话「岗位调整」那个按钮会在生成换绑码之后凭空消失
  const rid = rosterId ?? (S.data.teachers?.items || []).find((x) => x.id === id)?.roster_id ?? null;
  try {
    const d = await api('GET', `/teachers/${id}`);
    const t = d.teacher;
    const plans = d.plans || [];
    // 名单里没填姓名的话，认她靠编号和她兑的那个码
    const who = t.real_name || (t.teacher_ref ? `编号 ${t.teacher_ref}` : '（未填写姓名）');

    // 教案列表分页。翻页状态挂在 S 上而不是闭包里 ——
    // 这一屏每次翻页都整块重建（openTeacher 重跑），闭包里的页码活不过那一下
    const PLAN_PER = 10;
    const planPages = Math.max(1, Math.ceil(plans.length / PLAN_PER));
    const planPg = Math.min(Math.max(1, S.teacherPlanPage || 1), planPages);
    const planPage = plans.slice((planPg - 1) * PLAN_PER, planPg * PLAN_PER);

    // 比默认 520 宽：教案表有五列
    S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
      <div class="box" style="width:640px">
      <h3>${esc(who)}
        ${t.status === 'disabled' ? '<span class="pill p-bad">已停用</span>' : ''}
        ${t.status === 'deleted' ? '<span class="pill p-off">已注销</span>' : ''}</h3>

      <!-- 个人信息（2026-08-22 用户定的六项：城市 / 园所 / 班级 / 岗位 / 学历 / 教龄）。
           原来这些揉在标题底下一段用「·」连起来的小字里，六七项连成一句话，
           要找「她教龄几年」得从头读到尾。
           城市取的是**园所所在城市** —— 库里没有老师的住址，也不该有。 -->
      ${profileBlock([
        ['城市', t.city],
        ['园所', t.kindergarten],
        ['班级', t.class_name],
        ['岗位', t.position],
        ['最高学历', t.education],
        // 0 是「今年刚入职」，是个有意义的值，不能被 `|| '—'` 吃掉
        ['教龄', t.teaching_years == null ? null : `${t.teaching_years} 年`],
      ])}
      <div class="sub" style="margin:10px 0 14px">
        编号 <span class="mono">${t.teacher_ref ?? '—'}</span>${t.name_masked ? '（超级管理员可见完整姓名）' : ''}
        　兑换码 <span class="mono">${esc(t.redeem_code || '—')}</span>　年级 ${esc(t.age_group || '—')}<br>
        激活 ${fmtDate(t.activated_at)}　同意协议 ${fmtDate(t.agreed_at)}　最近登录 ${fmtDate(t.last_login_at)}
      </div>

      <!-- 只列**写完的**。答题中的草稿不是「她写过的教案」，是被叫走留下的半截。
           默认 10 条 + 翻页（2026-08-22 用户定）—— 写了 40 份的话，
           一个弹窗里铺 40 行得滚很久，而要看的往往是最近那几份 -->
      <b style="font-size:13px">已完成教案（${plans.length}${d.plans_truncated ? '，只显示最近 50 份' : ''}${
        d.drafts ? `　另有 ${d.drafts} 个草稿未完成` : ''}）</b>
      ${d.can_view_content === false ? `<div class="note" style="margin:8px 0">
        教案标题与内容仅超级管理员可见。
      </div>` : ''}
      ${plans.length ? `<table style="margin:8px 0 4px">
        <tr><th>标题</th><th style="width:64px">年龄班</th><th style="width:72px">修订次数</th>
            <th style="width:120px">时间</th><th style="width:80px"></th></tr>
        ${planPage.map((p) => `<tr>
          <td>${p.title === undefined ? '<span style="color:var(--ink-3)">超级管理员可见</span>' : esc(p.title || '—')}</td>
          <td>${esc(p.age_group || '—')}</td>
          <!-- 修订次数直接给数字（2026-08-22 用户定）。原来写成「修订 2 次」/「未修订」——
               一列里混着数字和一个词，扫不齐也排不了序。0 就是 0。
               「出到 v3、现在停在 v2」= 她改完又退回去了，这本身是关于教案质量的信号，
               所以那一句留着 —— 它是**另一个事实**，不是对修订次数的解释 -->
          <td class="num">${(p.version || 1) - 1}${
            p.current_version && p.current_version !== p.version
              ? `<br><span class="low" style="font-size:11.5px">退回 v${p.current_version}</span>` : ''}</td>
          <td style="white-space:nowrap">${fmtStamp(p.created_at)}</td>
          <!-- 「查看正文」那一屏里有**对话记录**（问答对，含改稿轮次）——
               2026-08-22 用户问的「对话记录在哪」就在那里 -->
          <td>${p.plan_id ? `<button class="btn-sm" onclick="openPlan(${p.plan_id},${id})">查看正文</button>` : ''}</td>
        </tr>`).join('')}
      </table>
      ${planPages > 1 ? `<div class="row" style="margin:0 0 12px;justify-content:center">
        <button class="btn-sm" ${planPg <= 1 ? 'disabled' : ''} onclick="teacherPlanPage(${id},${rid},${planPg - 1})">上一页</button>
        <span style="font-size:13px;color:var(--ink-2)">第 ${planPg} / ${planPages} 页</span>
        <button class="btn-sm" ${planPg >= planPages ? 'disabled' : ''} onclick="teacherPlanPage(${id},${rid},${planPg + 1})">下一页</button>
      </div>` : ''}` : '<div class="empty">暂无已完成教案</div>'}

      <!-- 已经有一把没用的换绑钥匙在外面时**显示它**，而不是让人又生成一把。
           两把钥匙同时能接管同一个账号，而我不知道另一把在谁手上 -->
      ${d.pending_rebind ? `<div class="note" style="margin-top:14px">
        存在未使用的换绑码：<b class="mono">${esc(d.pending_rebind.code)}</b>
        （${fmtDay(d.pending_rebind.expires_at)} 过期）
        <button class="btn-sm" style="margin-left:8px" onclick="copyCode('${esc(d.pending_rebind.code)}')">复制</button>
        <button class="btn-sm btn-danger" onclick="voidRebind(${d.pending_rebind.id},${id})">作废</button>
      </div>` : ''}

      <div class="foot">
        <!-- 岗位调整从列表行里挪进来了（2026-08-22）。
             它要的是 **roster_id（位置）**，不是账号 id —— 两者不能混，
             传错的话调整的是别人那一行。列表把 roster_id 一路带进来正是为此 -->
        ${rid ? `<button class="btn-sm" onclick="openReassign(${rid})">岗位调整</button>` : ''}
        ${t.status === 'active' && d.pending_rebind === null
          ? `<button class="btn-sm" onclick="askRebind(${id})">重新绑定微信</button>` : ''}
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
    toast(d.reused ? '已存在未使用的换绑码，沿用该码' : '已生成');
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
    // **界面上直接看 JSON**（用户定的）：这一屏的用处是拿去做研究分析，
    // 一个能整块选中复制的 JSON 比一张排好的表更有用。
    //
    // 形状 2026-08-22 换成**问答对**（后端 buildTranscript 卷的）。
    // 原来是把 messages 原样铺开：每条 assistant 带着那道题的全部推荐选项，
    // 一份四题的教案能滚出两百多行，而「她答了什么」埋在里面。
    // 用户原话：「呈现了问题但不呈现用户的答案，当前结构太长了」。
    const transcript = d.transcript || {};
    const turns = (transcript.引导?.length || 0)
      + (transcript.改稿 || []).reduce((n, r) => n + 1 + r.追问.length, 0);

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

      <!-- 「模型自检」那一块 **2026-08-22 撤掉了**（用户定）。
           它是 quality_self 那坨 JSON 原样铺开 —— 八个质量维度加年龄班违规列表，
           而这一屏是用来读教案正文和她说了什么的。
           ⚠️ **数据一个字没删**（lesson_plans.quality_self 照旧写入），
           要查年龄班违规走 SQL。撤的是这一屏的入口，不是这份数据。
           （这段注释里不能用反引号 —— 它在一个模板字符串里面。） -->

      <b style="font-size:13px">对话记录（${turns} 条）</b>
      ${turns ? `<textarea readonly rows="14"
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

/** 三档评价的中文。反馈汇总表用它出纯文本，老师详情里那张小表还用胶囊 */
const RATING_CN = { usable: '可用', needs_edit: '需修改', unusable: '不可用' };
const ratingPill = (r) => ({
  usable: '<span class="pill p-ok">可用</span>',
  needs_edit: '<span class="pill p-warn">需修改</span>',
  unusable: '<span class="pill p-bad">不可用</span>',
}[r] || '—');

/* ============ 兑换码 ============ */
function codesView() {
  const all = S.data.codes?.items || [];
  const { items, page, pages } = paginate('codes', all);
  const sel = codeSel();
  // 「全选」只勾**当前这一页** —— 勾一下就选中另外几页看不见的行，
  // 而下一步是不可逆的删除
  const allOn = items.length > 0 && items.every((c) => sel.has(c.id));
  // 这句是**实情提醒**不是解释：旧规则是「码只用于首次激活，之后去老师页加额度」，
  // 而那个按钮已经撤了。不写这一句，下次我会去老师页找一个不存在的按钮
  // 「额度发放的唯一入口。教师完成任务后另发新码，由本人兑换」也删了（2026-08-22）。
  // 它不是汇总，但属于同一类：那句话原本是**写给我自己的备忘**
  // （代码注释里写着「不写这一句，下次我会去老师页找一个不存在的按钮」）——
  // 而那正是 CLAUDE.md 禁的那件事：把设计理由印在屏幕上，
  // 是拿使用者的注意力替我记笔记。它现在只在这条注释里
  return `<h2>兑换码</h2>
    <!-- 「新建兑换码」和「批量建码」**2026-08-22 合成一个入口**（用户定，
         照园所那套做）：两个按钮做的是同一件事，区别只有「要几个」——
         而那正是表单里的第一个字段。人不该先替我们决定这次算「新建」还是算「批量」。
         状态筛选挪到了「状态」那一列的列头上（跟教师页、反馈页同一个规则）。 -->
    <div class="row row--tools">
      <button class="btn" onclick="openNewCode()">＋ 新建兑换码</button>
      <button class="btn-sm" onclick="exportCodes()">导出 CSV</button>
      ${perSelect('codes')}
      ${clearBtn('clearCodeFilter', S.filter.codeStatus !== 'all')}
    </div>
    ${sel.size ? `<div class="note" style="background:var(--amber-soft)">
      选中 <b>${sel.size}</b> 次操作
      <button class="btn-sm btn-danger" style="margin-left:8px" onclick="deleteCodeBatches()">删除选中</button>
      <button class="btn-sm" onclick="clearCodeSel()">取消选择</button>
    </div>` : ''}
    ${items.length ? `<table>
      <!-- 一行 = 一次建码操作（019 迁移）。原来是一个码一行 ——
           而实际动作是「批量建 20 个」，那一次操作会摊成 20 行，
           几批混在一起按时间倒序，分不出哪 20 个是刚才那一批的。 -->
      <tr>
        <th style="width:34px"><input type="checkbox" ${allOn ? 'checked' : ''} onchange="toggleAllCodes(this.checked)"></th>
        <th>操作</th><th>额度说明</th><th>说明</th>
        ${thFilter('状态', 'codeStatus', [
          ['unused', '未使用'], ['used', '已使用'], ['void', '已作废'],
        ], S.filter.codeStatus, 'all')}
        <th></th></tr>
      ${items.map((c) => `<tr>
        <td><input type="checkbox" ${sel.has(c.id) ? 'checked' : ''} onchange="toggleCode(${c.id},this.checked)"></td>
        <td><b>${c.kind === 'single' ? '建 1 个码' : `批量建 ${c.requested} 个`}</b>
          <br><span style="font-size:11.5px;color:var(--ink-3)">${fmtDate(c.created_at)}${
            c.kindergarten ? ` · ${esc(c.kindergarten)}` : ''}</span></td>
        <td class="num">${c.init_text} 教案 / ${c.init_image} 配图</td>
        <td>${esc(c.grant_reason || '—')}</td>
        <!-- 批量显示「已用几张 / 共几张」，单张就是 1/1（用户定的两种写法）。
             这两个数是 COUNT 出来的，不是存的 —— 见后端那段 -->
        <td class="num">${c.used} / ${c.total} 已用${
          c.total !== c.requested
            // 建成的张数跟要建的不一样 = 撞码重试失败。少见，但不该被抹平
            ? `<br><span class="low" style="font-size:11.5px">要 ${c.requested} 个，只建成 ${c.total} 个</span>`
            : ''}${c.voided ? `<br><span style="font-size:11.5px;color:var(--ink-3)">作废 ${c.voided}</span>` : ''}</td>
        <td style="white-space:nowrap">
          <button class="btn-sm" onclick="openCodeBatch(${c.id})">查看兑换码</button></td>
      </tr>`).join('')}
    </table>
    ${pagerBar('codes', page, pages)}`
      : `<div class="empty">${S.filter.codeStatus !== 'all' ? '当前条件下无记录' : '暂无建码记录'}</div>`}`;
}
window.clearCodeFilter = async () => { S.filter.codeStatus = 'all'; pg('codes').page = 1; await load(); };

/* ── 多选删除 ──────────────────────────────────────────────────
   用户要的是「方便批量删除具体操作，让页面更简洁」。
   选中集合放在 S 里而不是读 DOM：这一页每次 render 都会重建整张表，
   读 DOM 的话翻一次筛选就把选中状态丢了。 */
const codeSel = () => (S.codeSel ||= new Set());
window.toggleCode = (id, on) => { on ? codeSel().add(id) : codeSel().delete(id); render(); };
window.toggleAllCodes = (on) => {
  const ids = (S.data.codes?.items || []).map((c) => c.id);
  S.codeSel = new Set(on ? ids : []);
  render();
};
window.clearCodeSel = () => { S.codeSel = new Set(); render(); };

/**
 * 删掉选中的几次操作。
 *
 * 确认框里要把**代价说清楚**：已兑的码不会被删（那是老师额度来源的唯一凭据），
 * 所以删完之后「共几张」跟库里的码数就对不上了。
 * 这是用户明确选的取舍，但按下去之前她得知道。
 */
window.deleteCodeBatches = async () => {
  const ids = [...codeSel()];
  if (!ids.length) return;
  if (!confirm(`删掉这 ${ids.length} 次操作。\n\n还没被兑的码会一起删掉，`
    + '**已经被老师兑掉的码会留着**（那是她额度从哪来的唯一凭据）。\n\n不可撤销，确定？')) return;
  try {
    const d = await api('POST', '/codes/batches/delete', { ids });
    toast(d.kept
      ? `删了 ${d.batches} 次操作、${d.dropped} 个未兑的码；${d.kept} 个已兑的留着`
      : `删了 ${d.batches} 次操作、${d.dropped} 个码`);
    S.codeSel = new Set();
    await load();
  } catch (e) { toast(e.message); }
};

/**
 * 一批里的码。
 *
 * 用处只有一个（用户原话）：「发放对象没收到时重新抄录」。
 * 所以是**纯码单，不标哪一张已被使用** —— 标注反而让人以为
 * 「已用的那些不用抄了」，而没收到的那个人可能正好拿的是已用的那一张。
 */
window.openCodeBatch = async (id) => {
  try {
    const d = await api('GET', `/codes/batches/${id}`);
    const b = d.batch;
    S.batch = { created: d.codes, batch: { ...b, count: d.codes.length } };
    S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
      <div class="box" style="width:560px">
      <h3>${b.kind === 'single' ? '建 1 个码' : `批量建 ${b.requested} 个`}</h3>
      <div class="sub" style="margin-bottom:12px">每个 ${b.init_text} 教案 / ${b.init_image} 配图
        · ${fmtDate(b.created_at)}${b.grant_reason ? ` · ${esc(b.grant_reason)}` : ''}</div>
      ${d.codes.length ? `<textarea id="batchbox" readonly rows="${Math.min(14, d.codes.length + 1)}"
        style="width:100%;font-family:ui-monospace,Consolas,monospace;font-size:13.5px;
               letter-spacing:.04em;line-height:1.9;resize:vertical"
        >${esc(d.codes.join('\n'))}</textarea>`
        : '<div class="empty">该批次的兑换码已全部删除</div>'}
      <div class="foot">
        ${d.codes.length ? `<button class="btn-sm" onclick="copyBatch()">全选复制</button>
          <button class="btn-sm" onclick="downloadBatchCsv()">下载 CSV</button>` : ''}
        <button class="btn" onclick="closeModal()">好</button>
      </div>
    </div></div>`;
    render();
  } catch (e) { toast(e.message); }
};

/**
 * 新建兑换码 —— **一个入口，数量决定是一个还是一批**（2026-08-22 用户定）。
 *
 * 原来是两个按钮两张表单（「新建兑换码」和「批量建码」），做的是同一件事，
 * 区别只有「要几个」—— 而那是表单里的第一个字段。
 * 两个入口逼人先决定「我这次算新建还是算批量」，那个判断对她没有意义
 * （跟园所页「新增 / 批量导入」合成一个入口是同一条）。
 *
 * **不再指定园所**（用户定）。码的基本逻辑是谁持有谁使用；
 * 而且批量码的用途正是「灌进问卷星谁填谁拿」，那一刻根本不知道拿到码的人在哪个园。
 * ⚠️ 后端 `POST /codes` 的 `kindergarten_id` 参数**没删**（回归脚本在测它），
 * 只是这张表单不再传。
 */
window.openNewCode = () => {
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>新建兑换码</h3>
    <div class="grid2">
      <div class="field"><label>数量</label>
        <input type="number" id="c_count" value="1" min="1" max="200" style="width:100%"></div>
      <div class="field"><label>说明（记入台账）</label>
        <input type="text" id="c_reason" value="完成问卷 · 首次" style="width:100%"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>每码教案额度</label><input type="number" id="c_text" value="20" style="width:100%"></div>
      <div class="field"><label>每码配图额度</label><input type="number" id="c_img" value="10" style="width:100%"></div>
    </div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="doCreateCode()">生成</button>
    </div>
  </div></div>`;
  render();
};

/**
 * 生成。**一条路走到底**：不管 1 个还是 20 个都走 `POST /codes/batch`。
 *
 * 为什么不按数量分流到 `POST /codes`：两条路要维护两份「建完之后怎么显示」，
 * 而它们只在数量上不同。后端收到 count=1 时会把这次操作记成 `kind='single'`，
 * 于是列表里显示「建 1 个码」而不是「批量建 1 个」。
 */
window.doCreateCode = async () => {
  const g = (id) => document.getElementById(id).value.trim();
  const count = Math.min(Math.max(Number(g('c_count')) || 1, 1), 200);
  try {
    const d = await api('POST', '/codes/batch', {
      count,
      init_text: Number(g('c_text')), init_image: Number(g('c_img')),
      grant_reason: g('c_reason'),
    });
    S.batch = d;                 // 下载 CSV 时要用到整批的参数
    showBatchResult(d);
    load();
  } catch (e) { toast(e.message); }
};
window.copyCode = (c) => { navigator.clipboard?.writeText(c); toast(`已复制 ${c}`); };
/**
 * 作废单个码。
 *
 * ⚠️ **界面上现在没有入口了**：兑换码那一页 2026-08-21 改成一行一次操作之后，
 * 单个码不再单独占一行，所以「作废这一个」没有地方放。
 * 要清掉发错的码，删掉整次操作（未兑的会一起删）。
 *
 * 函数和后端 `POST /codes/:id/void` 都留着，回归脚本在测它，
 * 而且它是应急通道（某一批里只有一个码发错了人时，从库里作废那一个）。
 * **别看到「没人调」就把它删掉** —— 跟 `PATCH /lesson-plans/:id` 同一条纪律。
 */
window.voidCode = async (id) => {
  if (!confirm('作废后该兑换码将无法使用，是否继续？')) return;
  try { await api('POST', `/codes/${id}/void`); toast('已作废'); await load(); } catch (e) { toast(e.message); }
};

/* ============ 文件上传与模板下载（园所 / 名单批量导入共用）============ */
//
// 两处导入（园所、名单）都是「下载模板 → 在 Excel 里填 → 传回来 → 先预览再确认」。
// 这三个函数是那条路上共用的部分，写在这里而不是各自复制一份。

/**
 * 下载一个模板。
 *
 * 用 fetch 拿 blob 再造一个 <a> 点它，而不是直接 `location.href = 路径` ——
 * 这些接口要带 Authorization 头，浏览器直接跳转不会带上，会拿到 401 的 JSON。
 * （跟 exportCodes 同一个原因。）
 */
async function downloadTemplate(path, fallbackName) {
  try {
    const res = await fetch(API + path, { headers: { Authorization: `Bearer ${S.token}` } });
    if (!res.ok) throw new Error('模板下载失败');
    // 文件名优先用服务端给的（RFC 5987 那一段），拿不到就用兜底名
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? decodeURIComponent(m[1]) : fallbackName;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('模板已下载，填写后上传');
  } catch (e) { toast(e.message); }
}

/**
 * 读一个 <input type=file> 里选的 xlsx，回 base64。
 *
 * 走 base64 塞进 JSON body（后端 express.json 限 256kb）而不是 multipart：
 * 一份 50 人的名单 xlsx 约 20KB，base64 之后 27KB，够用得很 ——
 * 为它引一个 multer 中间件不值得。
 *
 * readAsDataURL 给的是 `data:...;base64,xxx`，那个前缀服务端会剥（sheetToRows 里），
 * 所以这里不用管。
 */
function readFileBase64(input) {
  return new Promise((resolve, reject) => {
    const f = input?.files?.[0];
    if (!f) { reject(new Error('先选一个文件')); return; }
    // 256kb 是后端的 body 上限，base64 会把体积撑到 4/3，所以这里按 180KB 拦。
    // 拦在这里能给一句有用的话；让它撞到后端只会拿到一个 413
    if (f.size > 180 * 1024) {
      reject(new Error('这个文件太大了（超过 180KB）。名单一次导几百人就够，分几批传'));
      return;
    }
    if (!/\.xlsx$/i.test(f.name)) {
      reject(new Error('只认 .xlsx。老版 .xls 和 .csv 都不行，在 Excel 里「另存为」一下'));
      return;
    }
    const r = new FileReader();
    r.onerror = () => reject(new Error('这个文件读不出来，重新选一次'));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(f);
  });
}

/** 选了文件之后把文件名显示出来 —— 不然按了「看看认出几个」不知道传的是哪份 */
window.onPickFile = (input, labelId) => {
  const el = document.getElementById(labelId);
  if (el) el.textContent = input.files?.[0]?.name || '还没选文件';
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
  const all = S.data.kindergartens?.items || [];
  const f = S.filter;
  /* 筛选（2026-08-22 用户提「园所应该有一个筛选功能，类似于教师页面」）。
     城市 / 地区 / 性质三列 —— **正好就是任务定向筛的那三个字段**，
     所以「哪些园收得到某个定向」在这一页直接筛得出来。
     跟教师页那三列同一套：**前端筛**（园所是几十行、一次全拿回来），
     城市的选项从当前数据里现取（省市是人填的自由文本，写死清单必然对不上）。 */
  const cities = [...new Set(all.map((k) => k.city).filter(Boolean))].sort();
  const items = all.filter((k) =>
    (!f.kgCity || k.city === f.kgCity)
    && (!f.kgArea || k.area_type === f.kgArea)
    && (!f.kgOwn || k.ownership === f.kgOwn));
  const filtered = Boolean(f.kgCity || f.kgArea || f.kgOwn);

  // 副标题整条删了（2026-08-21 用户提）。原来是「共 N 个　M 个还没填齐地区和类型，
  // 收不到定向任务」—— 个数在表里数得出来，而「没填齐」表里那几列已经用红字
  // 「未填」标出来了，副标题是把同一件事说第二遍。
  // 「筛出 1 个，共 9 个」那行删了（2026-08-22 用户点名的例子之一）。
  // 它是我上一轮加的 —— 加的时候想的是「让人知道筛掉了多少」，
  // 而**常驻的「清除筛选」按钮已经回答了这件事**，那一行是同一件事说第二遍
  return `<h2>园所</h2>
    <!-- 「新增园所」和「批量导入」2026-08-22 合成一个入口（用户定，照名单那套做）。
         粘一行就是单个新增，所以不再需要单独的新增表单 ——
         两个入口做同一件事，人得先决定「我这次算新增还是算导入」，
         而那个判断对她没有意义。 -->
    <div class="row row--tools">
      <button class="btn" onclick="openKgImport()">＋ 导入园所</button>
      ${clearBtn('clearKgFilter', filtered)}
    </div>
    <!-- 列 2026-08-22 用户定：园所 / 城市 / 地区 / 性质 / 教师数 / 幼儿数 /
         联系人 / 花费 / 起始合作 / 编辑。
           · 原来的「地区」列是「省·市」两个值挤一格，现在只出城市 ——
             省份仍然存着（任务定向按它筛），只是扫这张表时用不上
           · 「城乡」这个词换成**「地区」**（用户定）。⚠️ 库里那一列还叫
             area_type、导入模板的列头还叫「城乡」（别人填过的表不能失效），
             改的只是这里显示的字
           · 花费 = 配图 + 文本，从撤掉的「园所概况」那张表挪过来的
           · 「详情」→「编辑」：那一屏现在只有一件事，就是改这个园的信息 -->
    ${items.length ? `<table class="tbl-fixed">
      <tr><th style="width:200px">园所</th>
          ${thFilter('城市', 'kgCity', cities.map((v) => [v, v]), f.kgCity, '', 100)}
          ${thFilter('地区', 'kgArea', Object.entries(AREA_CN), f.kgArea, '', 90)}
          ${thFilter('性质', 'kgOwn', Object.entries(OWNER_CN), f.kgOwn, '', 90)}
          <th style="width:84px">教师数</th><th style="width:84px">幼儿数</th>
          <th style="width:130px">联系人</th><th style="width:90px">花费</th>
          <th style="width:105px">起始合作</th><th style="width:80px"></th></tr>
      ${items.map((k) => `<tr>
        <td><b>${esc(k.name)}</b></td>
        <td>${k.city ? esc(k.city) : '<span class="low">未填</span>'}</td>
        <td>${k.area_type ? AREA_CN[k.area_type] : '<span class="low">未填</span>'}</td>
        <td>${k.ownership ? OWNER_CN[k.ownership] : '<span class="low">未填</span>'}</td>
        <td class="num">${k.teacher_count ?? '—'}</td>
        <td class="num">${k.child_count ?? '—'}</td>
        <td>${esc(k.contact_name || '—')}${k.contact_phone ? `<br><span class="mono" style="font-size:11.5px;color:var(--ink-3)">${esc(k.contact_phone)}</span>` : ''}</td>
        <td class="num">${k.cost_cents ? yuan(k.cost_cents) : '—'}</td>
        <!-- 没填就是「—」，**不拿建库时间兜底** —— 那是这一行什么时候被导进来的，
             不是合作什么时候开始的（020 迁移里写着为什么） -->
        <td style="white-space:nowrap">${k.cooperation_started_at
            ? esc(String(k.cooperation_started_at).slice(0, 10)) : '—'}</td>
        <td><button class="btn-sm" onclick="openKg(${k.id})">编辑</button></td>
      </tr>`).join('')}
    </table>` : `<div class="empty">${filtered ? '当前条件下无记录' : '暂无园所，请先导入'}</div>`}`;
}
window.clearKgFilter = () => { S.filter.kgCity = ''; S.filter.kgArea = ''; S.filter.kgOwn = ''; render(); };
/* openNewKg / saveNewKg **2026-08-22 删掉了**（用户定）。
   「新增园所」和「批量导入」合成了一个入口 —— 粘一行就是单个新增。
   两个入口做同一件事，人得先决定「我这次算新增还是算导入」，
   而那个判断对她没有意义。完整表单还在，在**详情**弹窗里（openKg）。 */

/**
 * 导入园所 —— 上传 Excel 或粘贴文本，一个入口两条路（2026-08-22）。
 *
 * **先解析预览，确认了才真写** —— 跟名单导入同一条纪律。
 * 一份在 Excel 里被人改过的表里，列会被挪、会多一列序号、
 * 「城乡」会写成「城区」，这些解析器都认得出或报得出来，但人得先看一眼确认认对了。
 *
 * 布局刻意跟名单那个弹窗一样：同一件事在两个地方长得不一样，人得学两遍。
 */
window.openKgImport = () => {
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
    <div class="box" style="width:700px">
    <h3>导入园所</h3>

    <!-- 「下载模板」和「上传文件」**做成一样大的两个按钮**（2026-08-22 用户提）。
         原来右边那个是浏览器原生的 input[type=file]，跟左边的 .btn-sm
         高矮宽窄全不一样，读起来不像同一层的两个动作。
         现在原生 input 藏起来，用一个真按钮去 click() 它。 -->
    <label>上传 Excel</label>
    <div class="row row--tools" style="margin-bottom:6px">
      <button class="btn-sm" onclick="downloadTemplate('/kindergartens/template','园所导入模板.xlsx')">下载模板</button>
      <button class="btn-sm" onclick="document.getElementById('kgi_file').click()">选择文件</button>
      <input type="file" id="kgi_file" accept=".xlsx" onchange="onPickFile(this,'kgi_name')" style="display:none">
      <span id="kgi_name" style="font-size:12.5px;color:var(--ink-3)">未选择文件</span>
    </div>

    <!-- 粘贴框的提示**把列标题写进去**（2026-08-22 用户提），
         底下那段 .note 说明整个删掉 —— 同一件事说两遍，而且说明那段更长。
         列标题直接摆在 placeholder 里，人一眼看到的就是「按这个顺序填」。 -->
    <label>或直接粘贴</label>
    <textarea id="kgi_text" rows="6" style="width:100%;font-size:13px;line-height:1.7;resize:vertical"
      placeholder="园所名称, 省份, 城市, 城乡, 办园性质, 在园教师数, 在园幼儿数, 联系人, 联系电话, 起始合作日期, 备注
示例幼儿园, 广东, 广州, 城市, 公办, 42, 310, 李园长, , 2026-09-01, "></textarea>
    <div id="kgi_preview"></div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="previewKgImport()">解析预览</button>
    </div>
  </div></div>`;
  render();
};

/**
 * 解析预览：只解析、只查重，一行都不写库。
 *
 * 选了文件就走文件，否则走粘贴的文本。**文件优先**：她要是两边都填了，
 * 那个刚选的文件才是她这一下想做的事。跟名单那边同一个规则。
 */
window.previewKgImport = async () => {
  const fileInput = document.getElementById('kgi_file');
  const text = document.getElementById('kgi_text').value;
  let payload;
  if (fileInput?.files?.length) {
    try { payload = { file_base64: await readFileBase64(fileInput) }; }
    catch (e) { toast(e.message); return; }
  } else if (text.trim()) {
    payload = { text };
  } else {
    toast('请上传模板或粘贴园所清单');
    return;
  }
  S.kgDraft = payload;
  try {
    const d = await api('POST', '/kindergartens/import', { ...payload, dry_run: true });
    const s = d.summary;
    document.getElementById('kgi_preview').innerHTML = `
      <div class="note" style="background:${s.ok ? 'var(--mint-soft)' : 'var(--amber-soft)'}">
        识别到 <b>${s.ok}</b> 个园所${s.duplicate ? `，<b>${s.duplicate}</b> 个已存在（跳过，不覆盖）` : ''}${
          s.invalid ? `，<b>${s.invalid}</b> 行无法识别` : ''}
      </div>
      <table style="margin-top:8px">
        <tr><th>行</th><th>园所</th><th>地区 / 性质</th><th>人数</th><th>起始合作</th><th></th></tr>
        ${d.rows.map((r) => `<tr style="${r.ok ? '' : 'opacity:.6'}">
          <td class="num">${r.line}</td>
          <td>${esc(r.name || '—')}</td>
          <td>${esc([[r.province, r.city].filter(Boolean).join('·'),
              r.area_type ? AREA_CN[r.area_type] : '', r.ownership ? OWNER_CN[r.ownership] : '']
              .filter(Boolean).join(' / ') || '—')}</td>
          <td class="num">${r.teacher_count ?? '—'} 师 / ${r.child_count ?? '—'} 幼</td>
          <td style="white-space:nowrap">${r.cooperation_started_at || '—'}</td>
          <td>${r.ok ? '<span class="pill p-ok">待导入</span>'
              : `<span class="low" style="font-size:12.5px">${esc(r.reason || '')}</span>`}</td>
        </tr>`).join('')}
      </table>`;
    // 认出来了才给「真的导入」这个按钮 —— 一个都没认出来时它没有意义
    document.querySelector('.modal .foot').innerHTML = `
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn-sm" onclick="previewKgImport()">重新解析</button>
      ${s.ok ? `<button class="btn" onclick="commitKgImport()">确认导入 ${s.ok} 个</button>` : ''}`;
  } catch (e) { toast(e.message); }
};

window.commitKgImport = async () => {
  if (!S.kgDraft) return;
  try {
    const d = await api('POST', '/kindergartens/import', { ...S.kgDraft, dry_run: false });
    toast(`已导入 ${d.imported} 个园所`);
    S.modal = null; S.kgDraft = null; await load();
  } catch (e) { toast(e.message); }
};

/* `kgTeachers`（点园所跳教师页并预设筛选）**2026-08-22 删了** ——
   它唯一的调用方是园所编辑弹窗底部那个「查看该园教师」，用户把它撤了。
   要看某个园的教师，去教师页点「园所」那一列的筛选。 */

/**
 * 园所编辑 —— **只有一张表单**（2026-08-22 用户定「删除详情功能」）。
 *
 * 那四张用量统计卡撤掉了：教师数、幼儿数、花费已经在列表那一行上，
 * 剩下的（教案数、配图数、额度、未兑码）都是这一页回答不了什么决定的数。
 * 「未兑换码」那张尤其该走：兑换码 2026-08-22 起不再绑园所，
 * 它从此恒为 0 —— 一个永远是 0 的数比没有更糟。
 *
 * 但编辑本身**不能跟着一起删**：城乡和办园性质是任务定向筛的字段，
 * 导入时填歪了就永远改不了，而那个园会静悄悄地收不到任何定向任务。
 */
window.openKg = (id) => {
  const k = (S.data.kindergartens?.items || []).find((x) => x.id === id);
  if (!k) return;
  const sel = (cur, map) => Object.entries(map)
    .map(([v, cn]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${cn}</option>`).join('');

  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
    <div class="box" style="width:620px">
    <h3>${esc(k.name)}</h3>

    <div class="field"><label>园所名称</label>
      <input type="text" id="k_name" value="${esc(k.name)}" style="width:100%"></div>
    <div class="grid2">
      <div class="field"><label>省份</label>
        <input type="text" id="k_prov" value="${esc(k.province || '')}" placeholder="广东" style="width:100%"></div>
      <div class="field"><label>城市</label>
        <input type="text" id="k_city" value="${esc(k.city || '')}" placeholder="广州" style="width:100%"></div>
    </div>
    <div class="grid2">
      <!-- 「城乡」这个词界面上一律叫「地区」（2026-08-22 用户定）。
           库里那一列还是 area_type、导入模板的列头还是「城乡」——
           改列头会让别人手上填好的那份表突然认不出来 -->
      <div class="field"><label>地区</label>
        <select id="k_area" style="width:100%"><option value="">未指定</option>${sel(k.area_type, AREA_CN)}</select></div>
      <div class="field"><label>办园性质</label>
        <select id="k_own" style="width:100%"><option value="">未指定</option>${sel(k.ownership, OWNER_CN)}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>起始合作日期</label>
        <input type="date" id="k_coop" value="${esc(String(k.cooperation_started_at || '').slice(0, 10))}"
          style="width:100%"></div>
      <div class="field"></div>
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
          placeholder="${k.contact_phone_masked ? esc(k.contact_phone || '') + '（超级管理员可见完整号码）' : ''}" style="width:100%"></div>
    </div>
    <div class="field"><label>备注</label>
      <input type="text" id="k_note" value="${esc(k.note || '')}" placeholder="合作起止等备注信息" style="width:100%"></div>

    <!-- 「查看该园教师」2026-08-22 撤了（用户提）。教师页那张表能按园所筛，
         而这一屏现在只做一件事：改这个园的信息。 -->
    <div class="foot">
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
    cooperation_started_at: v('k_coop'),
  };
  // 一般管理员看到的是打过码的号，输入框是空的 —— 她留空只是「没动」，
  // **不能当成「清空」**，否则她一保存就把全号刷掉了
  // （跟 image_models 那把 api_key 留空 = 不改，同一个坑）。
  // 超管看到的是全号，她清空就是真想清空，所以要传。
  const phone = v('k_cp');
  if (phone || !phoneMasked) body.contact_phone = phone;
  try {
    await api('POST', `/kindergartens/${id}/update`, body);
    toast('已保存'); S.modal = null; await load();
  } catch (e) { toast(e.message); }
};

/* ============ 反馈 ============ */
//
// 2026-08-22：**两个 tab 合成一张汇总表 + 列头筛选**（用户提）。
//
// ⚠️ 08-18 拆成两个 tab 是有理由的，而那个理由是真的：
// 教案评价有「评价等级、对应哪一版教案」，产品建议有「分类」，
// 混在一张表里两边都得给对方留一列，于是**每行有一半是「—」**。
//
// 所以这次不是退回去，是把那个理由解决掉：
//   · 新增一列「类型」，先告诉人这一行在说什么
//   · 「评价 / 分类」**合成一列**（`评价等级` 和 `建议分类` 是同一个语义位置：
//     这条反馈的性质），一行只可能有一个，不再出现半列空白
//   · 「对应教案」只有评价行有值 —— 这一列留着，因为它是评价数据唯一的用处
//     （看到「不可用」能立刻翻出那一版原文），而它对建议行是真的没有对应物
//
// 净效果：原来每行 1 个「—」，现在只有建议行在「对应教案」上有 1 个。
// 换来的是不用切 tab 就能看到全部反馈，以及按列筛。

const SUGGEST_CN = { quality: '教案质量', feature: '功能需求', usability: '易用性', other: '其他' };
const FB_KIND_CN = { lesson_rating: '教案评价', suggestion: '产品建议' };

function feedbackView() {
  const all = S.data.feedback?.items || [];
  const f = S.filter;
  // 「类型」由后端筛（它有 kind 参数），处理状态在这里筛。
  // `fbCategory`（评价/分类）那一列 2026-08-22 撤了，筛选也跟着撤 ——
  // 撤一个概念不能只藏界面、留着筛选逻辑在背后生效
  const items = all.filter((x) => {
    if (f.fbHandled === 'yes' && !x.handled) return false;
    if (f.fbHandled === 'no' && x.handled) return false;
    return true;
  });
  const filtered = Boolean(f.fbKind !== 'all' || f.fbHandled);

  // 「共 N 条，M 条未处理」删了（2026-08-22）。「几条未处理」在侧栏那个红点上
  // 一直都有，而且那里更该有 —— 它是个待办数，不该只在打开这一页时才看得到
  return `<h2>反馈</h2>
    <div class="row row--tools">${clearBtn('clearFbFilter', filtered)}</div>
    <!-- 🔴 **这张表一律纯文本**（2026-08-22 用户提：「保持纯文本可视，
         不要增加文字效果，不需要在文字外面套一个外框」）。
         原来一行里有三个胶囊（类型、评价/分类）加一个按钮（对应教案）——
         四个带底色的小方块，而这一列列的是**文字信息**，不是状态标记。
         「已处理」那一列还是按钮：它是个动作，不是信息。 -->
    ${items.length ? `<table class="tbl-fixed">
      <tr>
        ${thFilter('类型', 'fbKind', [
          ['lesson_rating', '教案评价'], ['suggestion', '产品建议'],
        ], f.fbKind, 'all', 100)}
        <!-- 来源 240：「演示·育苗幼儿园 / 演示孙雅琴」量出来要 230，原来给 190 被截 -->
        <th style="width:240px">来源</th>
        <!-- 「评价 / 分类」这一列 **2026-08-22 删了**（用户定，问过一次确认不补）。
             ⚠️ 代价说清楚：**逐条**的「哪位老师把哪份教案评成不可用」从此没地方看了
             （教师详情里的反馈记录同一轮也撤了）。概览上还有三档的**汇总**数。
             这是他明确选的取舍，不是漏改 —— 要恢复的话把 thFilter 那一列加回来即可。 -->
        <!-- 内容给 380：这一列才是这张表的主体，余量该落在它身上 -->
        <th style="width:380px">内容</th><th style="width:200px">对应教案</th><th style="width:76px">时间</th>
        ${thFilter('处理状态', 'fbHandled', [['no', '未处理'], ['yes', '已处理']], f.fbHandled, '', 116)}
      </tr>
      ${items.map((x) => `<tr style="${x.handled ? 'opacity:.55' : ''}">
        <td style="white-space:nowrap">${FB_KIND_CN[x.kind] || '—'}</td>
        <!-- 一行「园所 / 教师」（2026-08-21 用户提）：来源只需要认得出是谁，不占两行 -->
        <td style="white-space:nowrap">${esc([x.kindergarten, x.real_name].filter(Boolean).join(' / ') || '—')}</td>
        <td>${esc(x.text || '—')}</td>
        <!-- **只给教案本身，不换行**（2026-08-22 用户提：「对应教案同时涵盖了
             年级和教案本身，你只要提供教案本身就好了」）。年级那行小字删掉 ——
             同一屏上「年龄班」在别处已经有了，而它把这一列撑成了两行 -->
        <td style="white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis">${
            x.kind === 'lesson_rating' && x.lesson_plan_id
            // 看到「不可用」能立刻翻出那一版的原文 —— 这是评价数据唯一的用处
            ? (x.plan_title === undefined
                ? '<span style="color:var(--ink-3)">超级管理员可见</span>'
                : `<button class="tlnk" onclick="openPlan(${x.lesson_plan_id},null,${x.plan_version || 'null'})"
                     >${esc(x.plan_title || '该教案')} v${x.plan_version || '?'}</button>`)
            : '—'}</td>
        <td style="white-space:nowrap">${fmtDay(x.created_at)}</td>
        <td><button class="btn-sm" onclick="markHandled(${x.id},${!x.handled})">
          ${x.handled ? '标为未处理' : '标为已处理'}</button></td>
      </tr>`).join('')}
    </table>` : `<div class="empty">${filtered ? '当前条件下无记录' : '暂无反馈'}</div>`}`;
}
window.clearFbFilter = async () => {
  S.filter.fbKind = 'all'; S.filter.fbHandled = '';
  await load();
};
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
    };
    // 老师页现在是**合并列表**：名单（岗位）+ 已激活账号一张表。
    // 「名单」那个顶级页 2026-08-21 撤掉了，导入名单的入口挪到这一页
    if (S.page === 'teachers') {
      const qs = new URLSearchParams();
      if (S.filter.q) qs.set('q', S.filter.q);
      if (S.filter.kg) qs.set('kindergarten_id', S.filter.kg);
      if (S.filter.teacherStatus && S.filter.teacherStatus !== 'current') {
        qs.set('status', S.filter.teacherStatus);
      }
      jobs.teachers = api('GET', `/teachers?${qs}`);
    }
    if (S.page === 'tasks') jobs.tasks = api('GET', '/tasks');
    if (S.page === 'codes') jobs.codes = api('GET', `/codes?status=${S.filter.codeStatus}`);
    if (S.page === 'feedback') {
      // 「类型」在后端筛（它有 kind 参数），另两个在前端筛 ——
      // 反馈总量是几十条量级，为两个筛选条件加两个查询参数不值得。
      // ⚠️ 数据一多就要挪到后端，判据是这一页开始变慢
      jobs.feedback = api('GET', `/feedback?kind=${S.filter.fbKind}`);
    }
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
    kindergartens: kgView, feedback: feedbackView, tasks: tasksView,
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
  // 2026-08-21：原来这里有一句副标题 + 一整段 note。两处都写着「手机号全号」——
  // 而 016 迁移把**老师的手机号删掉了**，库里根本没有。屏幕上的假话。
  //
  // note 那一整段（「老师同意的协议里写着…每多一个人能读，这句承诺就少一分是真的」）
  // 是**设计理由**，按 CLAUDE.md 那条属于代码注释和 operations.md，不属于界面。删了。
  // 那句承诺本身没有变，它记在这里和 operations.md 第 6 节。
  //
  // 副标题留一行，而且改成实情：留它是因为它是**边界说明** ——
  // 不说这句，一般管理员看到打过码的电话会以为是数据坏了。
  return `<h2>管理员账号</h2>
    <div class="sub">一般管理员不可查看教师撰写的内容，园所联系电话仅显示打码号码</div>
    <div class="row"><button class="btn" onclick="openNewAdmin()">＋ 新建管理员</button></div>
    <!-- 「显示名称」那一列 **2026-08-22 撤掉了**（用户定：新建管理员不要显示名称，
         按用户名认人）。库里 admins.display_name 那一列没删 ——
         历史操作记录里还带着旧的显示名，删列会让那些记录的「来源」变空。 -->
    <table>
      <tr><th>用户名</th><th>角色</th><th>状态</th><th>创建者</th><th>最近登录</th><th></th></tr>
      ${items.map((a) => `<tr>
        <td class="mono"><b>${esc(a.username)}</b>${a.id === meId ? ' <span class="pill p-off">我</span>' : ''}</td>
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
    <!-- 「显示名称」删了（2026-08-22 用户定）：认人一律按用户名。
         两个名字并存的下场是操作记录里一半写「张三」一半写「zhangsan」，
         而它们是同一个人。 -->
    <div class="grid2">
      <div class="field"><label>用户名（小写字母、数字、下划线）</label>
        <input type="text" id="a_user" placeholder="如 zhangsan" style="width:100%"></div>
      <div class="field"><label>初始密码（至少 6 位）</label>
        <input type="text" id="a_pwd" style="width:100%"></div>
    </div>
    <!-- 两个 option 原来各拖着一句权限说明（「—— 发额度、建码、看反馈；看不到…」），
         底下还有一段 note。两处都删掉（2026-08-21 用户提，这类要求第五次了）。
         下拉选项里塞一句解释，选项本身就读不快了；
         而「该不该给这个人开超管」是判断，写在屏幕上也替不了那个判断。 -->
    <div class="field"><label>角色</label>
      <select id="a_role" style="width:100%">
        <option value="admin">一般管理员</option>
        <option value="super">超级管理员</option>
      </select></div>
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
      username: g('a_user'), password: g('a_pwd'), role: g('a_role'),
      // display_name 不再传（界面上那个框撤了）。后端那个参数留着，
      // 库里那一列也留着 —— 历史记录靠它显示旧的显示名
    });
    toast('已创建，请将用户名与初始密码告知对方');
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
    toast('已保存'); S.modal = null; await load();
  } catch (e) { toast(e.message); }
};
window.toggleAdmin = async (id, status) => {
  try { await api('POST', `/admins/${id}/status`, { status }); toast(status === 'disabled' ? '已停用' : '已恢复'); await load(); }
  catch (e) { toast(e.message); }
};

/* 改自己的密码 —— 一般管理员也能用。入口在左下角个人中心里 */
window.openChangePwd = () => {
  S.mePanel = false;
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>修改密码</h3>
    <div class="field"><label>当前密码</label><input type="password" id="p_old" style="width:100%"></div>
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
    toast('已修改，下次请使用新密码登录'); S.modal = null; render();
  } catch (e) { toast(e.message); }
};

/* ============ 操作记录 ============ */
const ACTIONS = {
  grant_quota: '发放额度', create_code: '新建兑换码', create_codes_batch: '批量新建兑换码',
  void_code: '作废兑换码', export_codes: '导出兑换码', delete_code_batches: '删除建码记录',
  teacher_status: '停用/启用教师',
  create_kindergarten: '新建园所', update_kindergarten: '修改园所',
  import_kindergartens: '批量导入园所',
  add_topup: '记录充值',
  import_roster: '导入名单', void_roster: '作废名单记录', reassign_roster: '岗位调整',
  update_own_profile: '修改本人信息',
  create_task: '新建任务', update_task: '修改任务', publish_task: '发布任务', close_task: '停止任务',
  create_rebind_code: '生成换绑码', void_rebind_code: '作废换绑码',
  create_admin: '新建管理员',
  admin_status: '停用/恢复管理员', reset_password: '重置密码',
  change_own_password: '修改本人密码',
  create_image_model: '新增配图模型', update_image_model: '修改配图模型',
  delete_image_model: '删除配图模型', test_image_model: '模型测试',
  set_default_image_model: '设为默认配图模型',
};
//
// 2026-08-18 加了筛选和翻页。原来是一张倒序裸表 LIMIT 200 ——
// 攒到几百条之后它自己就废了：翻不动，而且第 201 条起根本看不到，
// 也就是说「查得到」这件事在数据变多之后悄悄失效了。
//
// 筛选下拉只列**真正出现过的**人和动作（后端回 admins / actions）：
// 列一堆从来没发生过的动作，筛选框自己就变成噪音。
/** 时间范围三档（2026-08-22 用户定）。手选起止日期那两个框撤了 */
const LOG_RANGES = [['24h', '过去 24 小时'], ['7d', '过去一周'], ['30d', '过去 30 天']];

function logsView() {
  const d = S.data.logs || {};
  const items = d.items || [];
  const f = S.filter.log;
  // `total` 跟标题底下那行汇总小字一起删了（2026-08-22）。
  // 后端照旧回它 —— 别只因为界面不显示就把响应字段也删掉，那是两回事
  const page = d.page || 1;
  const pages = d.pages || 1;
  const filtered = Boolean(f.admin_id || f.group || f.range);

  // 「共 N 条，第 X / Y 页」删了（2026-08-22）。页码在底部翻页条上原样有一份
  return `<h2>操作记录</h2>
    <!-- 操作类型从二十多个动作收成 **5 组**（2026-08-22 用户定「保持在 5 类之内」）。
         人翻记录时想的从来不是「我要找 set_default_image_model」，
         是「谁动了后台设置」。分组在后端（ACTION_GROUPS），
         **前端不再自己维护一份动作清单** —— 两份迟早对不上。
         🔴 后端那个 system 组是**兜底**（不属于其他四组的全归它），
         所以以后新加动作不会从筛选里静默消失。

         时间从「起止两个日期框」换成三档预设：查操作记录的实际问题永远是
         「刚才/这两天/这个月谁动过什么」，手敲两个日期是替系统做算术。 -->
    <div class="row row--tools">
      <select onchange="setLogFilter('admin_id',this.value)">
        <option value="">全部管理员</option>
        ${(d.admins || []).map((a) => `<option value="${a.admin_id}" ${f.admin_id == a.admin_id ? 'selected' : ''}
          >${esc(a.username || `#${a.admin_id}`)}</option>`).join('')}
      </select>
      <select onchange="setLogFilter('group',this.value)">
        <option value="">全部操作</option>
        ${(d.groups || []).map((g) => `<option value="${esc(g.key)}" ${f.group === g.key ? 'selected' : ''}
          >${esc(g.cn)}（${g.n}）</option>`).join('')}
      </select>
      <select onchange="setLogFilter('range',this.value)">
        <option value="">全部时间</option>
        ${LOG_RANGES.map(([k, l]) => `<option value="${k}" ${f.range === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <!-- 每页条数（2026-08-22）。这一页是**后端分页**（记录能攒到上万条），
           所以它走 setLogFilter 重新请求，不是前端切片 -->
      <select onchange="setLogFilter('per',this.value)">
        ${[20, 50, 100].map((n) => `<option value="${n}" ${(f.per || 20) === n ? 'selected' : ''}
          >每页 ${n} 条</option>`).join('')}
      </select>
      ${clearBtn('clearLogFilter', filtered)}
    </div>
    ${items.length ? `<table class="tbl-fixed">
      <!-- 对象 200：「image_model:minimax」量出来要 187，原来给 150 被截。
           详情（那坨 JSON）400，余量落在它身上 -->
      <tr><th style="width:115px">时间</th><th style="width:100px">来源</th>
          <th style="width:155px">操作类型</th><th style="width:200px">对象</th>
          <th style="width:400px">详情</th></tr>
      ${items.map((l) => `<tr>
        <td style="white-space:nowrap">${fmtDate(l.created_at)}</td>
        <!-- 来源按**用户名**（2026-08-22）：显示名称整个撤掉了。
             「|| display_name」这个兜底留着 —— 老记录里可能只有显示名 -->
        <td>${esc(l.username || l.display_name || '—')}</td>
        <!-- 这一列仍然是**具体那个动作**，不是它所在的组。
             收成 5 类的是筛选；记录本身要是也只写「后台管理」，
             那这张表就答不出「他到底动了什么」——而那正是审计存在的理由 -->
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
    : `<div class="empty">${filtered ? '当前条件下无记录' : '暂无操作记录'}</div>`}`;
}
window.setLogFilter = async (k, v) => {
  S.filter.log[k] = k === 'per' ? Number(v) || 20 : v;
  S.filter.log.page = 1;   // 换了条件回第一页，否则会停在一个不存在的页码上
  await load();
};
window.clearLogFilter = async () => {
  // 清筛选**不清每页条数** —— 那是一个显示偏好，不是筛选条件
  S.filter.log = { admin_id: '', group: '', range: '', page: 1, per: S.filter.log.per || 20 };
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

/* `openBatchCodes` / `saveBatchCodes` **2026-08-22 删了** —— 「批量建码」那个按钮
   跟「新建兑换码」合成了一个入口（由数量决定），它们就没有调用方了。
   新的入口是 openNewCode + doCreateCode，两者都走 `POST /codes/batch`。 */

/**
 * 建完之后，**当场就要能拿走**（2026-08-18 用户提）。
 *
 * 原来只 toast 一句「建了 20 个」，然后得回列表页从几十个未使用的码里
 * 认出刚才那 20 个 —— 而列表是按创建时间倒序混在一起的，分不出哪批是哪批。
 * 现在一行一个铺出来，两个按钮：全选复制（贴进微信）、下载 CSV（发给园所或灌问卷星）。
 *
 * 只建了一个的时候用大字号那张卡（`.codebox`）：一个码是要被**念给人听**
 * 或者手抄的，而 textarea 里孤零零一行小字读起来费劲。
 * 复制按钮两种情况都在 —— 那是最常做的下一步。
 */
function showBatchResult(d) {
  const b = d.batch || {};
  const one = d.created.length === 1;
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
    <div class="box" style="width:560px">
    <h3>建好了 ${d.created.length} 个</h3>
    <div class="sub" style="margin-bottom:12px">每个 ${b.init_text} 教案 / ${b.init_image} 配图</div>
    ${one
      ? `<div class="codebox"><div class="c">${esc(d.created[0])}</div>
           <div class="t">将此码发给教师，在小程序内输入即可激活</div></div>`
      : `<textarea id="batchbox" readonly rows="10"
          style="width:100%;font-family:ui-monospace,Consolas,monospace;font-size:13.5px;
                 letter-spacing:.04em;line-height:1.9;resize:vertical"
          >${esc(d.created.join('\n'))}</textarea>`}
    <div class="foot">
      ${one
        ? `<button class="btn-sm" onclick="copyCode('${esc(d.created[0])}')">复制</button>`
        : '<button class="btn-sm" onclick="copyBatch()">全选复制</button>'}
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
    .catch(() => toast('浏览器阻止了复制，内容已选中，请按 Ctrl+C'));
};

/** 就地生成 CSV：整批的参数都在手上，不用再跑一趟后端 */
window.downloadBatchCsv = () => {
  const d = S.batch;
  if (!d) return;
  const b = d.batch || {};
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  // 没有「幼儿园」这一列了：批量码不绑园所（2026-08-21），那一列会永远是空的，
  // 而一个恒空的列比没有这列更糟 —— 拿到 CSV 的人会以为是数据丢了
  const rows = [['兑换码', '教案额度', '配图额度', '说明'].map(cell).join(',')]
    .concat(d.created.map((c) =>
      [c, b.init_text, b.init_image, b.grant_reason || ''].map(cell).join(',')));
  // BOM：没有它 Excel 打开中文列头是乱码
  const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `兑换码-${d.created.length}个.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已下载');
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
      toast('已导出');
    })
    .catch((e) => toast(e.message));
};
