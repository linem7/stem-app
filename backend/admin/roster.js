/* 名单页。拆成单独一个文件 —— app.js 已经 1200 行了。
   跟 image-models.js 一样是普通脚本、共用全局作用域（esc / api / toast / S / render 都从那边来）。

   这一页是**激活的第二把钥匙**：码证明「你是这批人里的」（问卷星发），
   手机号证明「你是哪一个」（跟这份名单核对）。
   两把钥匙相互独立 —— 码不绑在名单某一行上，否则问卷星发的随机码就对不上她的号。 */

const ROSTER_STATUS_PILL = {
  pending: '<span class="pill p-warn">等她来认领</span>',
  claimed: '<span class="pill p-ok">已激活</span>',
  void: '<span class="pill p-off">已作废</span>',
  // 她换班了，这一行是历史。**不删** —— 研究要用它区分
  // 「她在小一班那半年」和「她在中二班这半年」
  moved: '<span class="pill p-off">换班了（历史）</span>',
};

function rosterView() {
  const d = S.data.roster || {};
  const items = d.items || [];
  const c = d.counts || {};
  const f = S.filter.roster;

  return `<h2>名单</h2>
    <div class="sub">${(c.pending || 0) + (c.claimed || 0) + (c.void || 0) + (c.moved || 0)
      ? `等她来认领 ${c.pending || 0} · 已激活 ${c.claimed || 0}${
        c.void ? ` · 已作废 ${c.void}` : ''}${c.moved ? ` · 换过班 ${c.moved}` : ''}` : ''}</div>
    <div class="row">
      <button class="btn" onclick="openRosterImport()">＋ 粘一份名单进来</button>
      <input type="text" id="rq" placeholder="搜姓名 / 班级 / 编号" value="${esc(f.q)}"
        onkeydown="if(event.key==='Enter')doRosterSearch()" style="width:180px">
      <select onchange="setRosterFilter('status',this.value)">
        ${[['all', '全部'], ['pending', '等她来认领'], ['claimed', '已激活'],
          ['moved', '换过班'], ['void', '已作废']].map(([k, l]) =>
          `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${items.length ? `<table>
      <tr><th>编号</th><th>姓名</th><th>园所</th><th>年级 / 班级 / 岗位</th>
          <th>状态</th><th>什么时候认领的</th><th></th></tr>
      ${items.map((r) => `<tr style="${r.status === 'void' || r.status === 'moved' ? 'opacity:.55' : ''}">
        <!-- 编号 = teacher_ref = **人**。她换班时新开一行、这个数不变，
             所以同一个编号可能出现在好几行上 —— 那正是她的经历 -->
        <td class="mono">${r.teacher_ref}</td>
        <td>${esc(r.real_name || '—')}</td>
        <td>${esc(r.kindergarten || '—')}</td>
        <td>${esc(r.age_group || '—')} · ${esc(r.class_name || '—')} · ${esc(r.position || '—')}${
          r.note_public ? `<br><span style="font-size:11.5px;color:var(--ink-3)">${esc(r.note_public)}</span>` : ''}</td>
        <td>${ROSTER_STATUS_PILL[r.status] || esc(r.status)}</td>
        <td>${r.claimed_at ? fmtDate(r.claimed_at) : '—'}
          ${r.claimed_openid
            // 「谁认领了这个位置」要查得到 —— 只有超管拿得到这个字段
            ? `<br><span class="mono" style="font-size:11px;color:var(--ink-3)">${esc(r.claimed_openid)}</span>` : ''}</td>
        <td style="white-space:nowrap">${r.status === 'claimed'
            ? `<button class="btn-sm" onclick="openTeacher(${r.claimed_teacher_id})">看这位老师</button>
               <button class="btn-sm" onclick="openReassign(${r.id})">她换班了</button>`
            : r.status === 'pending'
              ? `<button class="btn-sm" onclick="openReassign(${r.id})">改班级岗位</button>
                 <button class="btn-sm btn-danger" onclick="voidRoster(${r.id})">作废</button>` : ''}</td>
      </tr>`).join('')}
    </table>` : `<div class="empty">${f.q || f.status !== 'all'
        ? '这个条件下没有记录' : '还没有名单。合作园给了名单之后粘进来'}</div>`}`;
}

/**
 * 她换班了 —— 新开一行、沿用同一个编号，旧那一行留着标「换班了」。
 *
 * 为什么不是直接改那一行：**旧那一行是历史**。研究要用它区分
 * 「她在小一班那半年」和「她在中二班这半年」，改掉就没了。
 * 她自己什么都不用做，下次打开小程序就是新班级。
 */
window.openReassign = (id) => {
  const r = (S.data.roster?.items || []).find((x) => x.id === id);
  if (!r) return;
  const kgs = S.data.kindergartens?.items || [];
  const sel = (cur, list) => list.map((v) =>
    `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(v)}</option>`).join('');

  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>${esc(r.real_name || '这一位')}　<span class="mono" style="font-size:14px;font-weight:400;color:var(--ink-2)">编号 ${r.teacher_ref}</span></h3>
    <div class="sub" style="margin-bottom:12px">
      现在：${esc(r.kindergarten || '未指定园所')} · ${esc(r.age_group || '—')} · ${esc(r.class_name || '—')} · ${esc(r.position || '—')}
    </div>
    <div class="grid2">
      <div class="field"><label>园所</label>
        <select id="ra_kg" style="width:100%">
          ${kgs.map((k) => `<option value="${k.id}" ${r.kindergarten_id === k.id ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select></div>
      <div class="field"><label>年级</label>
        <select id="ra_age" style="width:100%"><option value="">未填</option>
          ${sel(r.age_group, ['小班', '中班', '大班'])}</select></div>
    </div>
    <div class="grid2">
      <div class="field"><label>班级</label>
        <input type="text" id="ra_cls" value="${esc(r.class_name || '')}" placeholder="如 中二班" style="width:100%"></div>
      <div class="field"><label>岗位</label>
        <select id="ra_pos" style="width:100%"><option value="">未填</option>
          ${sel(r.position, ['主班', '配班', '保育员', '园长', '其他'])}</select></div>
    </div>
    <div class="note">编号 ${r.teacher_ref} 不变 —— 追这位老师靠它。
      旧那一行会留着标「换班了」，研究要用它区分两个学期。</div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveReassign(${id})">挪过去</button>
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
    toast('挪好了'); S.modal = null; await load();
  } catch (e) { toast(e.message); }
};

window.doRosterSearch = async () => {
  S.filter.roster.q = document.getElementById('rq')?.value || '';
  await load();
};
window.setRosterFilter = async (k, v) => { S.filter.roster[k] = v; await load(); };
window.voidRoster = async (id) => {
  if (!confirm('作废之后这一行就不能被激活了，确定？')) return;
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
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
    <div class="box" style="width:680px">
    <h3>粘一份名单进来</h3>
    <div class="note">一行一个人：姓名、班级、岗位、年级。只有姓名是必需的。
      逗号、制表符都认，全角也认，顺序也不用管。从微信或 Excel 直接复制过来就行。</div>
    <div class="field"><label>这一批是哪个园的</label>
      <select id="r_kg" style="width:100%"><option value="">不指定</option>
        ${kgs.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</select></div>
    <textarea id="r_text" rows="10" placeholder="王小美, 小一班, 主班, 小班"
      style="width:100%;font-size:13.5px;line-height:1.7;resize:vertical"></textarea>
    <div id="r_preview"></div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="previewRoster()">看看认出几个</button>
    </div>
  </div></div>`;
  render();
};

/** 干跑：只解析、只查重，一行都不写库 */
window.previewRoster = async () => {
  const text = document.getElementById('r_text').value;
  if (!text.trim()) { toast('先粘一份名单进来'); return; }
  S.rosterDraft = { text, kg: document.getElementById('r_kg').value || null };
  try {
    const d = await api('POST', '/roster/import', {
      text, kindergarten_id: S.rosterDraft.kg, dry_run: true,
    });
    const s = d.summary;
    const box = document.getElementById('r_preview');
    box.innerHTML = `
      <div class="note" style="background:${s.ok ? 'var(--mint-soft)' : 'var(--amber-soft)'};margin-top:12px">
        认出 <b>${s.ok}</b> 个人${s.duplicate ? `，<b>${s.duplicate}</b> 个名单里已经有了（跳过，不覆盖）` : ''}${
          s.invalid ? `，<b>${s.invalid}</b> 行没认出来` : ''}
      </div>
      <table style="margin-top:8px">
        <tr><th>行</th><th>姓名</th><th>班级 / 岗位 / 年级</th><th></th></tr>
        ${d.rows.map((r) => `<tr style="${r.ok ? '' : 'opacity:.6'}">
          <td class="num">${r.line}</td>
          <td>${esc(r.real_name || '—')}</td>
          <td>${r.ok ? `${esc(r.class_name || '—')} · ${esc(r.position || '—')} · ${esc(r.age_group || '—')}`
              : `<span class="mono" style="font-size:12px">${esc(String(r.raw || '').slice(0, 40))}</span>`}</td>
          <td>${r.ok ? '<span class="pill p-ok">要导入</span>'
              : `<span class="low" style="font-size:12.5px">${esc(r.reason)}</span>`}</td>
        </tr>`).join('')}
      </table>`;
    // 认出来了才给「真的导入」这个按钮 —— 一个都没认出来时它没有意义
    document.querySelector('.modal .foot').innerHTML = `
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn-sm" onclick="previewRoster()">重新看一遍</button>
      ${s.ok ? `<button class="btn" onclick="commitRoster()">确认导入这 ${s.ok} 个</button>` : ''}`;
  } catch (e) { toast(e.message); }
};

window.commitRoster = async () => {
  const draft = S.rosterDraft;
  if (!draft) return;
  try {
    const d = await api('POST', '/roster/import', {
      text: draft.text, kindergarten_id: draft.kg, dry_run: false,
    });
    toast(`导入了 ${d.imported} 个`);
    S.modal = null; S.rosterDraft = null;
    await load();
  } catch (e) { toast(e.message); }
};
