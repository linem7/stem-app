/* 名单相关的动作。拆成单独一个文件 —— app.js 已经 1200 行了。
   跟 image-models.js 一样是普通脚本、共用全局作用域（esc / api / toast / S / render 都从那边来）。

   名单是**激活的第二把钥匙**：码证明「你是这批人里的」（问卷星发），
   从名单里选自己是哪一位证明「你是哪一个」。
   两把钥匙相互独立 —— 码不绑在名单某一行上，否则问卷星发的随机码就对不上人。

   🔴 **「名单」那个顶级页 2026-08-21 撤掉了**（用户判断它跟「园所」「老师」重复）。
   名单并进了老师页：一行 = 一个岗位，激活了的多带账号和额度。
   所以这个文件里只剩**动作**（导入 / 换班 / 作废），列表那个 rosterView 删了 ——
   数据现在在 `S.data.teachers.items` 里，每行带 `roster_id`。
   **别把 rosterView 加回来**，加回来就又是两份会分叉的列表。 */

/**
 * 从老师页那张合并表里找出某一行名单。
 *
 * 原来是 `S.data.roster.items.find(x => x.id === id)` —— 那份数据没有了。
 * 现在合并表的每行带 `roster_id`（位置），而 `id` 是**账号 id**，两者不能混。
 */
function findRosterRow(rosterId) {
  return (S.data.teachers?.items || []).find((x) => x.roster_id === rosterId);
}

/**
 * 她换班了 —— 新开一行、沿用同一个编号，旧那一行留着标「换班了」。
 *
 * 为什么不是直接改那一行：**旧那一行是历史**。研究要用它区分
 * 「她在小一班那半年」和「她在中二班这半年」，改掉就没了。
 * 她自己什么都不用做，下次打开小程序就是新班级。
 */
window.openReassign = (id) => {
  const r = findRosterRow(id);
  if (!r) return;
  const kgs = S.data.kindergartens?.items || [];
  const sel = (cur, list) => list.map((v) =>
    `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(v)}</option>`).join('');

  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>${esc(r.real_name || '该教师')}　<span class="mono" style="font-size:14px;font-weight:400;color:var(--ink-2)">编号 ${r.teacher_ref}</span></h3>
    <div class="sub" style="margin-bottom:12px">
      当前：${esc(r.kindergarten || '未指定园所')} · ${esc(r.age_group || '—')} · ${esc(r.class_name || '—')} · ${esc(r.position || '—')}
    </div>
    <div class="grid2">
      <div class="field"><label>园所</label>
        <select id="ra_kg" style="width:100%">
          ${kgs.map((k) => `<option value="${k.id}" ${r.kindergarten_id === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></div>
      <div class="field"><label>年级</label>
        <select id="ra_age" style="width:100%"><option value="">未指定</option>
          ${sel(r.age_group, ['小班', '中班', '大班'])}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>班级</label>
        <input type="text" id="ra_cls" value="${esc(r.class_name || '')}" placeholder="如 中二班" style="width:100%"></div>
      <div class="field"><label>岗位</label>
        <select id="ra_pos" style="width:100%"><option value="">未指定</option>
          ${sel(r.position, ['主班', '配班', '保育员', '园长', '其他'])}</select></div>
    </div>
    <div class="note">编号 ${r.teacher_ref} 保持不变。原记录保留并标记为「已调岗」，用于区分不同学期。</div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveReassign(${id})">确认调整</button>
    </div>
  </div></div>`;
  render();
};
window.saveReassign = async (id) => {
  const v = (x) => document.getElementById(x).value.trim();
  try {
    await api('POST', `/roster/${id}/reassign`, {
      kindergarten_id: v('ra_kg') || null,
      class_name: v('ra_cls'),
      age_group: v('ra_age'),
      position: v('ra_pos'),
    });
    toast('已调整'); S.modal = null; await load();
  } catch (e) { toast(e.message); }
};

// doRosterSearch / setRosterFilter 跟 rosterView 一起删了（2026-08-21）：
// 名单页没了，搜索和筛选是老师页那两个（doSearch / setTeacherStatus）。
// 它们读的 `S.filter.roster` 也一并从 S 里去掉了 —— 留着的话哪天被调到会直接抛。
window.voidRoster = async (id) => {
  if (!confirm('作废后该记录将无法用于激活，是否继续？')) return;
  try { await api('POST', `/roster/${id}/void`); toast('已作废'); await load(); } catch (e) { toast(e.message); }
};

/**
 * 粘贴导入。
 *
 * **先干跑看预览，确认了才真写。** 不给预览就是让人闭眼提交一份从微信里
 * 复制来的名单 —— 里面必然有全角逗号、多余空格、少一列的行，
 * 甚至连表头一起复制进来。解析器认得出这些，但人得先看一眼确认认对了。
 */
window.openRosterImport = () => {
  const kgs = S.data.kindergartens?.items || [];
  // 两条入口：传 Excel（园长发来的本来就是 xlsx）和粘文本（从微信里复制）。
  // 后端**共用同一个解析器**（xlsx 就地拼成制表符分隔的文本），
  // 所以两条路认出来的东西必然一样 —— 那是有回归脚本盯着的
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
    <div class="box" style="width:680px">
    <h3>导入名单</h3>
    <div class="field"><label>所属园所</label>
      <select id="r_kg" style="width:100%"><option value="">不指定</option>
        ${kgs.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select></div>

    <label>上传 Excel</label>
    <div class="row row--tools" style="margin-bottom:6px">
      <button class="btn-sm" onclick="downloadTemplate('/roster/template','教师名单模板.xlsx')">下载模板</button>
      <input type="file" id="r_file" accept=".xlsx" onchange="onPickFile(this,'r_fname')"
        style="border:none;background:none;padding:0">
    </div>
    <div id="r_fname" style="font-size:12.5px;color:var(--ink-3);margin-bottom:14px">未选择文件</div>

    <label>或直接粘贴</label>
    <textarea id="r_text" rows="7" placeholder="王小美, 小一班, 主班, 小班"
      style="width:100%;font-size:13.5px;line-height:1.7;resize:vertical"></textarea>
    <!-- 这一段是**格式说明**不是设计理由：不说她不知道该按什么顺序填、
         也不知道哪几项可以不填。属于 CLAUDE.md 里「不说会做错事」那一类 -->
    <div class="note" style="margin-top:10px">一行一位教师：姓名、班级、岗位、年级。仅姓名必填。
      逗号、制表符均可，全角亦可，顺序不限。</div>
    <div id="r_preview"></div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="previewRoster()">解析预览</button>
    </div>
  </div></div>`;
  render();
};

/**
 * 干跑：只解析、只查重，一行都不写库。
 *
 * 选了文件就走文件，否则走粘贴的文本。**文件优先**：她要是两边都填了，
 * 那个刚选的文件才是她这一下想做的事。
 */
window.previewRoster = async () => {
  const fileInput = document.getElementById('r_file');
  const text = document.getElementById('r_text').value;
  const kg = document.getElementById('r_kg').value || null;

  let payload;
  if (fileInput?.files?.length) {
    try { payload = { file_base64: await readFileBase64(fileInput) }; }
    catch (e) { toast(e.message); return; }
  } else if (text.trim()) {
    payload = { text };
  } else {
    toast('请上传 Excel 或粘贴名单');
    return;
  }
  S.rosterDraft = { ...payload, kg };
  try {
    const d = await api('POST', '/roster/import', {
      ...payload, kindergarten_id: kg, dry_run: true,
    });
    const s = d.summary;
    const box = document.getElementById('r_preview');
    box.innerHTML = `
      <div class="note" style="background:${s.ok ? 'var(--mint-soft)' : 'var(--amber-soft)'};margin-top:12px">
        识别到 <b>${s.ok}</b> 位${s.duplicate ? `，<b>${s.duplicate}</b> 位名单中已存在（跳过，不覆盖）` : ''}${
          s.invalid ? `，<b>${s.invalid}</b> 行无法识别` : ''}
      </div>
      <table style="margin-top:8px">
        <tr><th>行</th><th>姓名</th><th>班级 / 岗位 / 年级</th><th></th></tr>
        ${d.rows.map((r) => `<tr style="${r.ok ? '' : 'opacity:.6'}">
          <td class="num">${r.line}</td>
          <td>${esc(r.real_name || '—')}</td>
          <td>${r.ok ? `${esc(r.class_name || '—')} · ${esc(r.position || '—')} · ${esc(r.age_group || '—')}`
              : `<span class="mono" style="font-size:12px">${esc(String(r.raw || '').slice(0, 40))}</span>`}</td>
          <td>${r.ok ? '<span class="pill p-ok">待导入</span>'
              : `<span class="low" style="font-size:12.5px">${esc(r.reason)}</span>`}</td>
        </tr>`).join('')}
      </table>`;
    // 认出来了才给「真的导入」这个按钮 —— 一个都没认出来时它没有意义
    document.querySelector('.modal .foot').innerHTML = `
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn-sm" onclick="previewRoster()">重新解析</button>
      ${s.ok ? `<button class="btn" onclick="commitRoster()">确认导入 ${s.ok} 位</button>` : ''}`;
  } catch (e) { toast(e.message); }
};

window.commitRoster = async () => {
  const draft = S.rosterDraft;
  if (!draft) return;
  const { kg, ...payload } = draft;
  try {
    // payload 原样带过去（可能是 text，也可能是 file_base64）——
    // **不能写死 `text: draft.text`**：走文件那条路时它是 undefined，
    // 于是「预览认出 30 个人、点确认说一行都没解析出来」。第一版就是这么错的
    const d = await api('POST', '/roster/import', { ...payload, kindergarten_id: kg, dry_run: false });
    toast(`已导入 ${d.imported} 位`);
    S.modal = null; S.rosterDraft = null;
    await load();
  } catch (e) { toast(e.message); }
};
