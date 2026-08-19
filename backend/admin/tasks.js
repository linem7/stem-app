/* 任务页。拆成单独一个文件 —— app.js 已经 1100 行了。
   跟 roster.js / image-models.js 一样是普通脚本、共用全局作用域。

   任务**不自动发额度**：它只承诺「填完给 20 次教案」，
   到账靠我事后核对答卷、建码发给她，她自己兑。
   系统不去猜「她是不是真填了」—— 答卷在问卷星，我们库里没有。 */

const TASK_STATUS_PILL = {
  draft: '<span class="pill p-off">草稿</span>',
  open: '<span class="pill p-ok">发布中</span>',
  closed: '<span class="pill p-off">已收</span>',
};

const AREA_OPTS = [['city', '城市'], ['county', '县镇'], ['rural', '农村']];
const OWNER_OPTS = [['public', '公办'], ['private', '民办']];
const AGE_OPTS = [['小班', '小班'], ['中班', '中班'], ['大班', '大班']];

/** 把定向说成一句人话。全空就是「所有人」—— 这一点必须显眼 */
function targetText(t, unrestricted) {
  if (unrestricted) return '<b class="low">所有人</b>';
  const kgs = S.data.kindergartens?.items || [];
  const parts = [
    t.provinces?.length ? t.provinces.join('/') : '',
    t.cities?.length ? t.cities.join('/') : '',
    t.area_types?.length ? t.area_types.map((x) => AREA_OPTS.find((o) => o[0] === x)?.[1] || x).join('/') : '',
    t.ownerships?.length ? t.ownerships.map((x) => OWNER_OPTS.find((o) => o[0] === x)?.[1] || x).join('/') : '',
    t.kindergarten_ids?.length
      ? t.kindergarten_ids.map((id) => kgs.find((k) => k.id === id)?.name || `#${id}`).join('/') : '',
    t.age_groups?.length ? `带${t.age_groups.join('/')}的老师` : '',
  ].filter(Boolean);
  return esc(parts.join(' · '));
}

function tasksView() {
  const items = S.data.tasks?.items || [];
  const open = items.filter((x) => x.status === 'open').length;
  return `<h2>任务</h2>
    <div class="sub">${items.length ? `发布中 ${open} 个，共 ${items.length} 个。奖励不会自动到账 —— 她填完问卷我核对后建码发给她` : ''}</div>
    <div class="row"><button class="btn" onclick="openTaskForm()">＋ 发起一个任务</button></div>
    ${items.length ? `<table>
      <tr><th>标题</th><th>奖励</th><th>发给谁</th><th>覆盖</th><th>看过的</th>
          <th>截止</th><th>状态</th><th></th></tr>
      ${items.map((t) => `<tr style="${t.status === 'closed' ? 'opacity:.55' : ''}">
        <td><b>${esc(t.title)}</b>${t.survey_url
            ? `<br><a href="${esc(t.survey_url)}" target="_blank" rel="noopener"
                 style="font-size:11.5px;color:var(--sky-deep)">问卷链接</a>` : ''}</td>
        <td class="num">${t.reward_text} 教案 / ${t.reward_image} 配图</td>
        <td style="max-width:220px">${targetText(t.target, t.unrestricted)}</td>
        <td class="num">${t.covers} 位</td>
        <!-- 看过的 / 覆盖的：这一对数字是「这条通知到底有没有人看见」的唯一答案 -->
        <td class="num">${t.reads}</td>
        <td>${t.deadline ? fmtDay(t.deadline) : '不限'}</td>
        <td>${TASK_STATUS_PILL[t.status] || esc(t.status)}</td>
        <td style="white-space:nowrap">
          ${t.status === 'draft'
            ? `<button class="btn-sm" onclick="openTaskForm(${t.id})">改</button>
               <button class="btn-sm" onclick="publishTask(${t.id},${t.covers},${t.unrestricted})">发布</button>`
            : t.status === 'open'
              ? `<button class="btn-sm" onclick="openTaskForm(${t.id})">改</button>
                 <button class="btn-sm btn-danger" onclick="closeTask(${t.id})">收了</button>`
              : ''}</td>
      </tr>`).join('')}
    </table>` : `<div class="empty">还没有任务。老师不会自己知道有活动可以换额度 —— 以前只能在微信群里喊一声</div>`}`;
}

/**
 * 发起 / 修改一个任务。
 *
 * 定向六个维度都在这一屏，底下一个**试算**按钮 ——
 * 条件叠到六层之后不试算没法确认筛对了，而发错是发给真人的。
 */
window.openTaskForm = (id) => {
  const t = id ? (S.data.tasks?.items || []).find((x) => x.id === id) : null;
  const g = t?.target || {};
  const kgs = S.data.kindergartens?.items || [];
  // 省市从园所表里现有的值来 —— 手打省市容易出现「广东」和「广东省」两个
  const provinces = [...new Set(kgs.map((k) => k.province).filter(Boolean))];
  const cities = [...new Set(kgs.map((k) => k.city).filter(Boolean))];
  const boxes = (name, opts, cur) => opts.map(([v, cn]) =>
    `<label style="margin-right:14px;font-size:13.5px;color:var(--ink)">
       <input type="checkbox" name="${name}" value="${esc(v)}" ${(cur || []).includes(v) ? 'checked' : ''}> ${esc(cn)}
     </label>`).join('');

  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()">
    <div class="box" style="width:660px">
    <h3>${t ? '改这个任务' : '发起一个任务'}</h3>

    <div class="field"><label>标题</label>
      <input type="text" id="tk_title" value="${esc(t?.title || '')}" placeholder="9 月教研问卷" style="width:100%"></div>
    <div class="field"><label>说什么</label>
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

    <div class="sub" style="margin:16px 0 8px"><b>发给谁</b>　每一项不选就是不限；选了的之间是「都要满足」</div>
    <div class="field"><label>城乡</label><div>${boxes('tk_area', AREA_OPTS, g.area_types)}</div></div>
    <div class="field"><label>办园性质</label><div>${boxes('tk_own', OWNER_OPTS, g.ownerships)}</div></div>
    <div class="field"><label>老师带的年龄班</label><div>${boxes('tk_age', AGE_OPTS, g.age_groups)}</div></div>
    <div class="grid2">
      <div class="field"><label>省份</label>
        <div>${boxes('tk_prov', provinces.map((p) => [p, p]), g.provinces) || '<span class="sub">园所还没填省份</span>'}</div></div>
      <div class="field"><label>城市</label>
        <div>${boxes('tk_city', cities.map((c) => [c, c]), g.cities) || '<span class="sub">园所还没填城市</span>'}</div></div>
    </div>
    <div class="field"><label>具体园所</label>
      <div>${boxes('tk_kg', kgs.map((k) => [String(k.id), k.name]), (g.kindergarten_ids || []).map(String))}</div></div>

    <div id="tk_preview"></div>
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn-sm" onclick="previewTask()">试算一下发给几个人</button>
      <button class="btn" onclick="saveTask(${id || 'null'})">${t ? '保存' : '存成草稿'}</button>
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

window.previewTask = async () => {
  try {
    const d = await api('POST', '/tasks/preview', { target: readTarget() });
    document.getElementById('tk_preview').innerHTML = `
      <div class="note" style="background:${d.unrestricted ? 'var(--amber-soft)' : 'var(--mint-soft)'};margin-top:14px">
        会发给 <b>${d.teachers}</b> 位老师${d.unrestricted ? ' —— <b class="low">这个定向什么都没限制，等于发给所有人</b>' : ''}
        ${d.sample.length
          ? `<br>${d.sample.map((s) => esc(`${s.surname}@${s.kindergarten || '未填园所'} ${s.class_name || ''}`)).join('　')}` : ''}
      </div>`;
  } catch (e) { toast(e.message); }
};

window.saveTask = async (id) => {
  const v = (x) => document.getElementById(x).value.trim();
  const body = {
    title: v('tk_title'), body: v('tk_body'), survey_url: v('tk_url'),
    reward_text: Number(v('tk_rt')) || 0, reward_image: Number(v('tk_ri')) || 0,
    deadline: v('tk_dl'), target: readTarget(),
  };
  if (!body.title) { toast('给任务起个标题'); return; }
  try {
    await api('POST', id ? `/tasks/${id}/update` : '/tasks', body);
    toast(id ? '改好了' : '存成草稿了 —— 试算确认之后再发布');
    S.modal = null; await load();
  } catch (e) { toast(e.message); }
};

/**
 * 发布。**要确认一次**，因为这一下老师那边就看得到了。
 * 定向什么都没限制时把「所有人」说出来 —— 那往往是漏勾了条件。
 */
window.publishTask = async (id, covers, unrestricted) => {
  const who = unrestricted ? `**所有** ${covers} 位老师` : `${covers} 位老师`;
  if (!confirm(`发布之后 ${who} 就能在小程序里看到它。\n\n${unrestricted ? '这个定向什么都没限制 —— 确认是要发给所有人吗？\n\n' : ''}确定发布？`)) return;
  try {
    const d = await api('POST', `/tasks/${id}/publish`);
    toast(`发布了，${d.covers} 位老师能看到`);
    await load();
  } catch (e) { toast(e.message); }
};

window.closeTask = async (id) => {
  if (!confirm('收了之后老师那边就不显示了，确定？')) return;
  try { await api('POST', `/tasks/${id}/close`); toast('收了'); await load(); }
  catch (e) { toast(e.message); }
};
