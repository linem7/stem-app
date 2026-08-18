/*
 * 配图模型管理（只有超管进得来）。
 *
 * 为什么在后台而不是小程序的设置页：加一个模型要填接口地址和 API key，
 * 而「API key 只在服务端、任何情况不下发到小程序」是这个项目的铁律（CLAUDE.md）。
 * 让老师在手机上敲 key，等于把钥匙串挂在门上；而且任何一个老师都能改所有人用的模型。
 * 而且 2026-08-18 起**老师根本不选模型**：用哪家是技术选型，她没有判断依据。
 * 所以分工是：这里负责增删改和「设为默认」，老师那边一个开关都没有。
 *
 * 单独一个文件而不是塞进 app.js：那边已经 560 行了，
 * 而这一块是可以整块拿掉的功能。全局函数，index.html 里在 app.js 之前引。
 */

/* eslint-disable no-undef */ // S / api / esc / toast / load / render / closeModal 都来自 app.js

function imageModelsView() {
  const d = S.data.imagemodels || {};
  const items = d.items || [];
  const formats = d.formats || [];

  const rows = items
    .map(
      (m) => `<tr>
        <td class="mono"><b>${esc(m.key)}</b>${
          m.key === d.default_provider ? ' <span class="pill p-warn">默认</span>' : ''
        }${m.enabled ? '' : ' <span class="pill p-off">停用</span>'}</td>
        <td>${esc(m.name_cn)}</td>
        <td class="mono" style="font-size:12px">${esc(m.model || '—')}</td>
        <td class="mono" style="font-size:12px">${esc(m.api_key_masked || '—')}</td>
        <td>
          ${
            m.key === d.default_provider || !m.enabled
              ? ''
              : `<button class="btn-sm" onclick="setDefaultModel('${esc(m.key)}')">设为默认</button>`
          }
          ${m.builtin ? '' : `<button class="btn-sm" onclick="editModel('${esc(m.key)}')">…</button>`}
        </td>
      </tr>`
    )
    .join('');

  return `<h2>配图模型</h2>
    <div class="sub">老师配图用的是<b>默认</b>那个。老师自己不选模型</div>
    <div class="row"><button class="btn" onclick="openNewModel()">＋ 加一个模型</button></div>
    <table>
      <tr><th>代号</th><th>名字</th><th>模型</th><th>密钥</th><th></th></tr>
      ${rows}
    </table>
    ${items.length ? '' : '<div class="empty">还没有模型 —— 在 .env 里配 IMG_API_KEY，或者在这里加一个</div>'}`;
}

/** 新建和编辑共用一张表单。编辑时代号和格式锁死——它们决定了数据怎么存、请求怎么拼 */
function modelForm(m) {
  const v = m || {};
  const formats = (S.data.imagemodels && S.data.imagemodels.formats) || [];
  const opts = formats
    .map(
      (f) =>
        `<option value="${esc(f.key)}" ${v.format === f.key ? 'selected' : ''}>${esc(f.cn)} —— ${esc(f.hint)}</option>`
    )
    .join('');

  return `<div class="field">
      <label>代号</label>
      <input type="text" id="m_key" value="${esc(v.key || '')}" ${m ? 'disabled' : ''} placeholder="如 nanobanana" style="width:100%">
    </div>
    <div class="grid2">
      <div class="field"><label>名字</label>
        <input type="text" id="m_name" value="${esc(v.name_cn || '')}" placeholder="如 香蕉出图" style="width:100%"></div>
      <div class="field"><label>备注</label>
        <input type="text" id="m_hint" value="${esc(v.hint || '')}" style="width:100%"></div>
    </div>
    <div class="field"><label>接口格式</label>
      <select id="m_format" style="width:100%" ${m ? 'disabled' : ''}>${opts}</select></div>
    <div class="field"><label>接口地址</label>
      <input type="text" id="m_base" value="${esc(v.base_url || '')}" placeholder="如 https://cdn.12ai.org" style="width:100%"></div>
    <div class="field"><label>模型名</label>
      <input type="text" id="m_model" value="${esc(v.model || '')}" placeholder="如 gemini-3.1-flash-image-preview" style="width:100%"></div>
    <div class="field"><label>API key${m ? '（留空不改）' : ''}</label>
      <input type="text" id="m_apikey" value="" placeholder="${m ? esc(v.api_key_masked || '') : 'sk-…'}" style="width:100%"></div>
    <div class="grid2">
      <div class="field"><label>额外参数（JSON）</label>
        <input type="text" id="m_options" value="${esc(JSON.stringify(v.options || {}))}" placeholder='{"imageSize":"2K"}' style="width:100%"></div>
      <div class="field"><label>排序</label>
        <input type="number" id="m_sort" value="${v.sort_order || 100}" style="width:100%"></div>
    </div>
    <div class="field"><label>
      <input type="checkbox" id="m_enabled" ${v.enabled === false ? '' : 'checked'}> 启用
    </label></div>`;
}

window.openNewModel = function openNewModel() {
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>加一个配图模型</h3>
    ${modelForm(null)}
    <div class="foot">
      <button class="btn btn-plain" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveNewModel()">保存</button>
    </div>
  </div></div>`;
  render();
};

// 按 key 从已加载的数据里找，不把整个对象塞进 onclick —— 那样要把 JSON 塞进 HTML 属性，
// 名字里一个引号就能把整块 HTML 撕开
window.editModel = function editModel(key) {
  const m = (S.data.imagemodels?.items || []).find((x) => x.key === key);
  if (!m) return;
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
    <h3>改「${esc(m.name_cn)}」</h3>
    ${modelForm(m)}
    <div class="foot">
      <button class="btn-sm btn-danger" onclick="delModel('${esc(m.key)}')">删掉</button>
      <button class="btn-sm" onclick="testModel('${esc(m.key)}')">试一张</button>
      <span style="flex:1"></span>
      <button class="btn btn-plain" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveEditModel('${esc(m.key)}')">保存</button>
    </div>
  </div></div>`;
  render();
};

function readModelForm() {
  let options = {};
  const raw = document.getElementById('m_options').value.trim();
  if (raw) {
    try {
      options = JSON.parse(raw);
    } catch (e) {
      toast('额外参数不是合法的 JSON');
      return null;
    }
  }
  return {
    key: document.getElementById('m_key').value.trim(),
    name_cn: document.getElementById('m_name').value.trim(),
    hint: document.getElementById('m_hint').value.trim(),
    format: document.getElementById('m_format').value,
    base_url: document.getElementById('m_base').value.trim(),
    model: document.getElementById('m_model').value.trim(),
    api_key: document.getElementById('m_apikey').value.trim(),
    options,
    sort_order: Number(document.getElementById('m_sort').value) || 100,
    enabled: document.getElementById('m_enabled').checked,
  };
}

window.saveNewModel = async function saveNewModel() {
  const body = readModelForm();
  if (!body) return;
  try {
    await api('POST', '/image-models', body);
    closeModal();
    toast('加好了，点「试一张」看看能不能出图');
    load();
  } catch (e) {
    toast(e.message);
  }
};

window.saveEditModel = async function saveEditModel(key) {
  const body = readModelForm();
  if (!body) return;
  try {
    await api('POST', '/image-models/' + key + '/update', body);
    closeModal();
    toast('改好了');
    load();
  } catch (e) {
    toast(e.message);
  }
};

window.delModel = async function delModel(key) {
  if (!confirm('删掉「' + key + '」？已经用它画出来的图不受影响，只是以后不能再选它。')) return;
  try {
    await api('POST', '/image-models/' + key + '/delete');
    toast('删了');
    load();
  } catch (e) {
    toast(e.message);
  }
};

/**
 * 试一张。
 * 加完一个模型最想知道的就是「它到底能不能出图」，
 * 不该跑回小程序开一份教案、选材料、等一分钟，才发现地址填错了。
 */
window.testModel = async function testModel(key) {
  toast('画一张试试，稍等…');
  try {
    const r = await api('POST', '/image-models/' + key + '/test', {});
    S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
      <h3>「${esc(key)}」能出图</h3>
      <div class="sub">${r.width}×${r.height} · ${(r.bytes / 1024).toFixed(0)} KB · 用了 ${(r.ms / 1000).toFixed(1)} 秒</div>
      <img src="${esc(r.url)}" style="width:100%;border:1px solid var(--rule-2);border-radius:12px;margin-top:12px">
      <div class="foot"><button class="btn" onclick="closeModal()">知道了</button></div>
    </div></div>`;
    render();
  } catch (e) {
    toast(e.message);
  }
};

/**
 * 设为默认。老师配图用的就是这一个 —— 她那边没有选择器。
 * 存在数据库里（不是 .env），所以点完立刻生效，不用重启后端。
 */
window.setDefaultModel = async function setDefaultModel(key) {
  try {
    await api('POST', '/image-models/' + key + '/default');
    toast('以后配图都用「' + key + '」了');
    load();
  } catch (e) {
    toast(e.message);
  }
};
