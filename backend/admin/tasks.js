/* 任务页。拆成单独一个文件 —— app.js 已经 1100 行了。
   跟 roster.js / models.js 一样是普通脚本、共用全局作用域。

   任务**不自动发额度**：它只承诺「填完给 20 次教案」，
   到账靠我事后核对答卷、建码发给她，她自己兑。
   系统不去猜「她是不是真填了」—— 答卷在问卷星，我们库里没有。 */

const TASK_STATUS_PILL = {
  draft: '<span class="pill p-off">草稿</span>',
  open: '<span class="pill p-ok">进行中</span>',
  closed: '<span class="pill p-off">已停止</span>',
};

const AREA_OPTS = [['city', '城市'], ['county', '县镇'], ['rural', '农村']];
const OWNER_OPTS = [['public', '公办'], ['private', '民办']];
const AGE_OPTS = [['小班', '小班'], ['中班', '中班'], ['大班', '大班']];

/* `targetText`（把六维定向说成一句人话）跟 `openTaskDetail` 一起删了 ——
   任务详情那一屏 2026-08-22 撤掉之后它就没有调用方了。
   列表里每一维各占一列，用下面那个 targetCol。 */

/** 一个定向维度在列表里怎么显示。没勾就是「不限」—— 那件事必须看得见 */
const targetCol = (vals, label = (x) => x) => (vals?.length
  ? esc(vals.map(label).join('、'))
  : '<span style="color:var(--ink-3)">不限</span>');

/** 「这个任务没有定向这一维」＝ 发给所有人。它跟「定向了广州」是两个问题，得能分开筛 */
const TARGET_NONE = '__none__';

/**
 * 一个任务在某一维上是否命中筛选值。
 *
 * 🔴 **定向维度是多选的**（一个任务可以发给「广州、宁波」），所以这里是
 * `includes` 而不是 `===` —— 其他几页的前端筛都是等值比较（一行一值），
 * 照抄过来对数组恒为 false，表现是「筛完一条都不剩」。
 */
const targetHit = (vals, want) => (want === TARGET_NONE
  ? !(vals || []).length
  : (vals || []).includes(want));

function tasksView() {
  const all = S.data.tasks?.items || [];
  const f = S.filter;
  // 城市选项**从当前这批任务里现取**：城市是人填的自由文本，写死一份清单必然对不上。
  // ⚠️ 用 flatMap 而不是 map —— 一个任务的城市是一个数组，
  // 照教师页那样 map 出来的是数组本身，去重之后每一项都是 "广州,宁波" 这种鬼东西
  const cityOpts = [...new Set(all.flatMap((t) => t.target?.cities || []))].sort();
  const items0 = all.filter((t) => (!f.taskCity || targetHit(t.target?.cities, f.taskCity))
    && (!f.taskOwner || targetHit(t.target?.ownerships, f.taskOwner)));
  const filtered = Boolean(f.taskCity || f.taskOwner);
  // 🔴 **在前端分页，不请求后端。** 任务是几十条量级、`GET /tasks` 一次全给，
  // 为翻页多加一组查询参数不值得。判据跟反馈页那条一样：这一页开始变慢就挪到后端。
  // 先筛后分页（跟教师页同一个顺序）—— 反过来的话第 2 页筛出来是空的
  const { items, page, pages } = paginate('tasks', items0);

  // 「共 N 个，进行中 M 个。奖励需人工核对答卷后建码发放」删了（2026-08-22 用户提）。
  // 前半截是汇总（状态那一列看得出来），后半截是**给我自己的备忘**——
  // 「把设计理由印在屏幕上，是拿使用者的注意力替我记笔记」，它属于代码注释：
  // 任务只承诺额度，到账靠事后核对答卷、建码发给她（见本文件头）
  return `<h2>任务</h2>
    <div class="row row--tools">
      <button class="btn" onclick="openTaskForm()">＋ 新建任务</button>
      ${perSelect('tasks')}
      ${clearBtn('clearTaskFilter', filtered)}
    </div>
    <!-- 列 2026-08-22 用户定：标题 / 问卷链接 / 奖励 / 城市 / 办园性质 / 截止 / 状态 / 操作。
           · **「覆盖」那一列删了** —— 它要为每个任务跑一次定向试算
             （一个任务两条查询），而这一页有几十行。那个数没有消失：
             **发送前的确认框里必然跑一次**，见底下 sendTask
           · **「详情」也删了**（第二轮，用户：「编辑跟详情是一样的东西」）。
             ⚠️ 代价：覆盖人数 / 已读 / 群体特征分布三样跟着没了，问过一次他确认不要
           · **草稿行上的「发布」按钮**跟着撤了（他列的操作只有 编辑 / 停止）。
             发布这条路没断：**编辑 → 发送**（存 + 强制试算 + 发布），
             而且比原来那个按钮稳 —— 那个是拿页面加载时算的 covers 直接发的
           · 问卷链接原来挤在标题底下当一行小字，一列信息藏在另一列里，
             而它是这一页最常要点开的东西 -->
    ${items.length ? `<table class="tbl-fixed">
      <!-- 列宽 2026-08-22 第二轮重排（用户提「任务页面的标题又太长了」）。
           原来只有标题没写 width，于是它独吞全部余量涨到 484px，
           而「操作」那一列两个按钮被挤在 110px 里换行。
           现在每列都写死，余量按比例分，城市那一列稍宽（它可能是「广州、宁波」）。 -->
      <tr><th style="width:250px">标题</th><th style="width:100px">问卷链接</th><th style="width:150px">奖励</th>
          <!-- 城市和办园性质这两列可以筛（2026-08-23 用户提）。
               ⚠️ 这两维是**多选**的，所以筛的语义是「这个任务的定向里包含它」，
               外加一个「不限定向」项 —— 那批任务发给所有人，
               把它们混进「广州」的结果里会让人以为定向写错了 -->
          ${thFilter('城市', 'taskCity',
            [...cityOpts.map((c) => [c, c]), [TARGET_NONE, '不限定向']], f.taskCity, '', 130)}
          ${thFilter('办园性质', 'taskOwner',
            [...OWNER_OPTS, [TARGET_NONE, '不限定向']], f.taskOwner, '', 108)}
          <th style="width:76px">截止</th><th style="width:80px">状态</th><th style="width:140px"></th></tr>
      ${items.map((t) => `<tr style="${t.status === 'closed' ? 'opacity:.55' : ''}">
        <td><b>${esc(t.title)}</b></td>
        <td>${t.survey_url
            ? `<a href="${esc(t.survey_url)}" target="_blank" rel="noopener"
                 style="color:var(--sky-deep)">打开问卷</a>` : '—'}</td>
        <td class="num">${t.reward_text} 教案 / ${t.reward_image} 配图</td>
        <td>${targetCol(t.target?.cities)}</td>
        <td>${targetCol(t.target?.ownerships, OWNER_LABEL)}</td>
        <td style="white-space:nowrap">${t.deadline ? fmtDay(t.deadline) : '不限'}</td>
        <td>${TASK_STATUS_PILL[t.status] || esc(t.status)}</td>
        <td style="white-space:nowrap">
          ${t.status !== 'closed' ? `<button class="btn-sm" onclick="openTaskForm(${t.id})">编辑</button>` : ''}
          ${t.status === 'open'
            ? `<button class="btn-sm btn-danger" onclick="closeTask(${t.id})">停止</button>` : ''}</td>
      </tr>`).join('')}
    </table>
    ${pagerBar('tasks', page, pages)}`
      : `<div class="empty">${filtered ? '当前条件下无记录' : '暂无任务'}</div>`}`;
}

window.clearTaskFilter = () => {
  S.filter.taskCity = '';
  S.filter.taskOwner = '';
  pg('tasks').page = 1;
  render();
};

/* 任务详情 openTaskDetail **2026-08-22 整块删了**（用户定：
   「删除详情功能，编辑跟详情是一样的东西」）。

   ⚠️ **跟着没了三样东西**：覆盖多少人 / 已读多少 / 按园所·城乡·办园性质·年龄班
   四组铺开的群体特征分布。那是他 08-21 自己提的（「希望在详情里能看到每个任务
   到底有多少人收到、群体的基本特征是什么」），这一轮问过一次，他确认不要了。
   AREA_LABEL 也跟着删了（只有那个分布图在用），OWNER_LABEL 留着 —— 列表那一列在用。
   targetText 同理，删了。

   试算没有全丢：**发送前的确认框里还会跑一次**（sendTask 里那个
   POST /tasks/preview），所以「发给几个人」在按下发送之前仍然看得到。
   后端 GET /tasks/:id 和 taskAudience 都**留着**，回归脚本在测它们 ——
   别看到「没人调」就删（跟 PATCH /lesson-plans/:id 同一条纪律）。 */
const OWNER_LABEL = (v) => OWNER_OPTS.find((o) => o[0] === v)?.[1] || v;

/**
 * 折叠式多选（2026-08-22）。收起时显示已选项，点开是一列复选框。
 *
 * 为什么不是原生 `<select multiple>`：那东西在桌面浏览器上要按住 Ctrl 才能多选，
 * 而没人知道这件事；它还会一次撑开好几行，跟「让页面短一点」正好相反。
 *
 * 🔴 三条实现纪律，改之前先读（对应的坑都是**不报错**的那种）：
 *   1. **复选框永远在 DOM 里**。收起 = 父元素 display:none。
 *      如果收起时不渲染那些 input，readTarget() 的 querySelectorAll 就读不到 ——
 *      「勾了城市、收起来、点发送」会发给所有人。
 *   2. **开合只切 class，绝不调 render()**。render() 按 HTML 字符串重建整个弹窗，
 *      勾过但还没保存的选项会全部丢掉，而弹窗看起来只是「闪了一下」。
 *   3. **摘要文字从 DOM 现算**，不从状态算 —— 状态在提交前根本没更新过。
 *
 * @param name  复选框的 name。readTarget() 按它取值，两处必须一致
 * @param empty 一个选项都没有时显示的话（比如「园所未填省份」）
 */
function msBox(name, opts, cur, empty = '暂无可选项') {
  const sel = new Set((cur || []).map(String));
  const summary = opts.filter(([v]) => sel.has(String(v))).map(([, cn]) => cn).join('、');
  return `<div class="ms" id="ms_${name}">
    <button type="button" class="ms-btn" onclick="msToggle('${name}')">
      <span class="v ${summary ? '' : 'none'}">${summary ? esc(summary) : '不限'}</span>
      <span class="car">▾</span>
    </button>
    <div class="ms-body">
      ${opts.length
        ? opts.map(([v, cn]) => `<label>
            <input type="checkbox" name="${name}" value="${esc(String(v))}"
              ${sel.has(String(v)) ? 'checked' : ''} onchange="msSync('${name}')"> ${esc(cn)}
          </label>`).join('')
        : `<div class="ms-empty">${esc(empty)}</div>`}
    </div>
  </div>`;
}
window.msToggle = (name) => { document.getElementById(`ms_${name}`)?.classList.toggle('open'); };
window.msSync = (name) => {
  const box = document.getElementById(`ms_${name}`);
  if (!box) return;
  // 文字取自 label 本身，不再维护一份「值 → 中文」的映射 ——
  // 维护两份的下场是加一个年龄班时摘要里显示的还是旧的三个
  const picked = [...box.querySelectorAll('input:checked')].map((x) => x.parentNode.textContent.trim());
  const v = box.querySelector('.ms-btn .v');
  v.textContent = picked.length ? picked.join('、') : '不限';
  v.classList.toggle('none', !picked.length);
};

/**
 * 发起 / 修改一个任务。
 *
 * 定向六个维度都在这一屏。**试算不再是一个按钮**（2026-08-21）——
 * 它挪进了「发送」的确认框，见底下 sendTask。
 * 条件叠到六层之后不试算没法确认筛对了，而发错是发给真人的，
 * 所以它从「可以不点的按钮」变成了「必然跑一次」。
 */
window.openTaskForm = (id) => {
  const t = id ? (S.data.tasks?.items || []).find((x) => x.id === id) : null;
  const g = t?.target || {};
  const kgs = S.data.kindergartens?.items || [];
  // 省市从园所表里现有的值来 —— 手打省市容易出现「广东」和「广东省」两个
  const provinces = [...new Set(kgs.map((k) => k.province).filter(Boolean))];
  const cities = [...new Set(kgs.map((k) => k.city).filter(Boolean))];

  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
    <div class="box" style="width:660px">
    <h3>${t ? '编辑任务' : '新建任务'}</h3>

    <div class="field"><label>标题</label>
      <input type="text" id="tk_title" value="${esc(t?.title || '')}" placeholder="9 月教研问卷" style="width:100%"></div>
    <div class="field"><label>通知内容</label>
      <textarea id="tk_body" rows="3" style="width:100%;font-size:13.5px;line-height:1.7"
        placeholder="填完这份问卷，我会给你发一个兑换码。">${esc(t?.body || '')}</textarea></div>
    <div class="field"><label>问卷链接</label>
      <input type="text" id="tk_url" value="${esc(t?.survey_url || '')}"
        placeholder="https://www.wjx.cn/vm/xxxx.aspx" style="width:100%"></div>
    <div class="grid2">
      <div class="field"><label>奖励教案次数</label>
        <input type="number" id="tk_rt" value="${t?.reward_text ?? 20}" style="width:100%"></div>
      <div class="field"><label>奖励配图张数</label>
        <input type="number" id="tk_ri" value="${t?.reward_image ?? 10}" style="width:100%"></div>
    </div>
    <div class="field"><label>截止日期（不填 = 不限时）</label>
      <input type="date" id="tk_dl" value="${t?.deadline ? String(t.deadline).slice(0, 10) : ''}" style="width:100%"></div>

    <!-- 六个定向维度 2026-08-22 从「一排排摊开的复选框」改成**折叠式多选**
         （用户提：「目标群体的选项应该是下拉框而不是直接呈现选项内容，
          当前使得整个新建页面太长了」）。
         指定园所那一项原来会把库里每个园铺一个复选框 —— 二十个园就是二十行。

         🔴 **保持多选**（用户明确要的）：一个任务要能同时发给城市和县镇。
         原生 select 是单选，所以这是个自己搭的控件，实现要点见 index.html 的 .ms 那段：
         复选框始终在 DOM 里、开合只切 class 不走 render()。
         readTarget() 一个字没改，它照旧按 name 读 :checked。 -->
    <div class="sub" style="margin:16px 0 8px"><b>投放范围</b>　每一项不选即不限；已选项之间为「同时满足」</div>
    <div class="grid2">
      <div class="field"><label>地区</label>${msBox('tk_area', AREA_OPTS, g.area_types)}</div>
      <div class="field"><label>办园性质</label>${msBox('tk_own', OWNER_OPTS, g.ownerships)}</div>
    </div>
    <div class="grid2">
      <div class="field"><label>教师带班年龄</label>${msBox('tk_age', AGE_OPTS, g.age_groups)}</div>
      <div class="field"><label>省份</label>
        ${msBox('tk_prov', provinces.map((p) => [p, p]), g.provinces, '园所未填省份')}</div>
    </div>
    <div class="grid2">
      <div class="field"><label>城市</label>
        ${msBox('tk_city', cities.map((c) => [c, c]), g.cities, '园所未填城市')}</div>
      <div class="field"><label>指定园所</label>
        ${msBox('tk_kg', kgs.map((k) => [String(k.id), k.name]), (g.kindergarten_ids || []).map(String), '还没有园所')}</div>
    </div>

    <!-- 底部三项：取消 / 保存草稿 / 发送（2026-08-21 用户定）。
         「发送」＝ 存 + 发布一步到位，原来要先「存成草稿」再回列表点「发布」。

         🔴 **「试算一下发给几个人」这个按钮撤了，但试算本身没撤。**
         点发送时自动跑一次 /tasks/preview，把「会发给 N 位老师」和
         「什么都没限制＝发给所有人」放进确认框里。
         定向叠到六层之后不试算是没法确认筛对了的，而**发错是发给真人的** ——
         所以这一步不能因为少一个按钮就没了。
         挪进确认框其实更好：原来试算是**可以不点的**，现在它必然发生一次。 -->
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn-sm" onclick="saveTask(${id || 'null'})">保存草稿</button>
      <button class="btn" onclick="sendTask(${id || 'null'})">发送</button>
    </div>
  </div></div>`;
  render();
};

/** 从表单里读出定向。checkbox 的 name 和 target 的键名在这里对上，只此一处 */
function readTarget() {
  const picked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((x) => x.value);
  return {
    provinces: picked('tk_prov'),
    cities: picked('tk_city'),
    area_types: picked('tk_area'),
    ownerships: picked('tk_own'),
    kindergarten_ids: picked('tk_kg').map(Number),
    age_groups: picked('tk_age'),
  };
}

// `previewTask` 这个函数 2026-08-21 删了 —— 它的按钮撤掉之后就没有调用方了。
// 试算没有消失：它挪进了 sendTask 的确认框（那里是**必然**跑一次，
// 而这个按钮是可以不点的）。后端 `POST /tasks/preview` 照旧，管理端在用。

/** 表单读成请求体。saveTask 和 sendTask 共用，只此一处 */
function readTaskForm() {
  const v = (x) => document.getElementById(x).value.trim();
  return {
    title: v('tk_title'), body: v('tk_body'), survey_url: v('tk_url'),
    reward_text: Number(v('tk_rt')) || 0, reward_image: Number(v('tk_ri')) || 0,
    deadline: v('tk_dl'), target: readTarget(),
  };
}

window.saveTask = async (id) => {
  const body = readTaskForm();
  if (!body.title) { toast('请填写任务标题'); return; }
  try {
    await api('POST', id ? `/tasks/${id}/update` : '/tasks', body);
    toast('已保存为草稿');
    S.modal = null; await load();
  } catch (e) { toast(e.message); }
};

/**
 * 发送 ＝ 存一次 + 发布一次。
 *
 * 中间夹一次**强制试算**：定向六个维度叠起来之后，光看勾选框认不出实际会发给谁，
 * 而这一下老师那边就看得到了。原来试算是一个可以不点的按钮，现在它必然发生。
 *
 * 顺序是「先存再算再发」而不是「先算再存」：要算的是**存下来的那份定向**，
 * 先算后存的话中间那一步表单再被改一下，确认框上的数字就跟真正发出去的对不上了。
 */
window.sendTask = async (id) => {
  const body = readTaskForm();
  if (!body.title) { toast('请填写任务标题'); return; }
  try {
    const saved = await api('POST', id ? `/tasks/${id}/update` : '/tasks', body);
    const taskId = id || saved?.id;
    if (!taskId) { toast('已保存，但未获取到任务编号，请在列表中手动发布'); S.modal = null; await load(); return; }

    // 改一个**已经发布**的任务再点发送：不用（也不能）再发布一次，
    // 存下去就已经生效了。不挡这一下的话后端会回「这个任务已经发布了」，
    // 而她刚做的事其实是成功的 —— 报错会让她以为改动没保存上
    if (saved?.status === 'open') {
      toast('已保存，该任务处于进行中，教师端立即生效');
      S.modal = null; await load(); return;
    }

    const p = await api('POST', '/tasks/preview', { target: body.target });
    const who = p.unrestricted ? `全部 ${p.teachers} 位老师` : `${p.teachers} 位老师`;
    if (p.teachers === 0) {
      // 发给零个人不是「发出去了」，是定向筛空了。已经存成草稿，改完再发
      toast('此定向未筛选到教师，已保存为草稿，请调整条件');
      S.modal = null; await load(); return;
    }
    if (!confirm(`发送之后 ${who} 就能在小程序里看到它。\n\n${
      p.unrestricted ? '这个定向什么都没限制 —— 确认是要发给所有人吗？\n\n' : ''}确定发送？`)) {
      // 取消的是「发」，不是「存」—— 那份草稿留着，她不用重填一遍
      toast('未发送，已保存为草稿');
      S.modal = null; await load(); return;
    }

    const d = await api('POST', `/tasks/${taskId}/publish`);
    toast(`已发送，${d.covers} 位教师可见`);
    S.modal = null; await load();
  } catch (e) { toast(e.message); }
};

/* `publishTask` **2026-08-22 删了** —— 列表上那个「发布」按钮撤掉之后就没有调用方了
   （用户列的三项操作是 详情 / 编辑 / 停止）。
   发布这条路没断：草稿走**编辑 → 发送**，那条路会强制试算一次再确认。
   删掉它其实更稳：这个函数是拿列表那一行上的 covers 去问「确定发给这 N 个人吗」，
   而那个数是页面加载时算的 —— 中间新激活了几位老师，确认框上的数字就是旧的。
   后端 `POST /tasks/:id/publish` 照旧，sendTask 在用。 */

window.closeTask = async (id) => {
  if (!confirm('停止后教师端将不再显示该任务，是否继续？')) return;
  try { await api('POST', `/tasks/${id}/close`); toast('已停止'); await load(); }
  catch (e) { toast(e.message); }
};
