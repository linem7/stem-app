/*
 * 模型管理（只有超管进得来）—— 文本模型和配图模型两个 section（2026-08-23）。
 *
 * 为什么在后台而不是小程序的设置页：加一个模型要填接口地址和 API key，
 * 而「API key 只在服务端、任何情况不下发到小程序」是这个项目的铁律（CLAUDE.md）。
 * 让老师在手机上敲 key，等于把钥匙串挂在门上；而且任何一个老师都能改所有人用的模型。
 * 而且 2026-08-18 起**老师根本不选模型**：用哪家是技术选型，她没有判断依据。
 * 所以分工是：这里负责增删改和「设为默认」，老师那边一个开关都没有。
 *
 * 文本模型多两个开关：「思考模式」「联网」。它们是**真实生效的调用参数**
 * （落到请求体上），不是标签 —— 该接口格式不支持的开关置灰，服务端也拒。
 *
 * 单独一个文件而不是塞进 app.js：那边已经 1900 多行了，
 * 而这一块是可以整块拿掉的功能。全局函数，index.html 里在 app.js 之前引。
 */

/* eslint-disable no-undef */ // S / api / esc / toast / load / render / closeModal 都来自 app.js

const KIND_CN = { text: '文本模型', image: '配图模型' };

function modelsView() {
  const d = S.data.models || {};
  const items = d.items || [];
  return `<h2>模型管理</h2>
    ${sectionHtml('text', items.filter((m) => m.kind === 'text'), d)}
    ${sectionHtml('image', items.filter((m) => m.kind === 'image'), d)}`;
}

/**
 * 两个 section 用**同一个函数**（2026-08-23 用户定：「配图模型和文字模型应该统一」）。
 * 唯一的差别是文本多「思考 / 联网」两列 —— 配图没有这两个概念，
 * 给它留两列永远是「—」的格子，是另一种不统一。
 */
function sectionHtml(kind, items, d) {
  const def = (d.defaults || {})[kind];
  const isText = kind === 'text';
  const rows = items
    .map(
      (m) => `<tr>
        <td class="mono">${esc(m.model || m.key)}${
          m.key === def ? ' <span class="pill p-warn">默认</span>' : ''
        }${m.enabled ? '' : ' <span class="pill p-off">停用</span>'}</td>
        <!-- 「认成了哪家」必须看得见：格式是从地址推断的（表单里没有那个下拉了），
             推断错了只有这一列说得出来 —— 而它的表现是「开关是灰的」或者
             「参数发出去对方不认」，都不报错 -->
        <td style="font-size:12.5px">${esc(m.format_cn || m.format || '—')}</td>
        <td class="mono" style="font-size:12px">${esc(m.base_url || '—')}</td>
        <td class="mono" style="font-size:12px">${esc(m.api_key_masked || '—')}</td>
        ${isText ? `<td>${m.options?.thinking ? '开' : '—'}</td><td>${m.options?.search ? '开' : '—'}</td>` : ''}
        <td style="white-space:nowrap">
          ${
            m.key === def || !m.enabled
              ? ''
              : `<button class="btn-sm" onclick="setDefaultModel('${esc(m.key)}')">设为默认</button>`
          }
          <button class="btn-sm" onclick="editModel('${esc(m.key)}')">编辑</button>
        </td>
      </tr>`
    )
    .join('');

  return `<h3 style="margin-top:${isText ? '12px' : '28px'}">${KIND_CN[kind]}</h3>
    <div class="row"><button class="btn" onclick="openNewModel('${kind}')">＋ 新增${KIND_CN[kind]}</button></div>
    <table class="tbl-fixed">
      <tr><th style="width:200px">模型 id</th><th style="width:130px">识别为</th>
          <th>接口地址</th><th style="width:150px">密钥</th>
          ${isText ? '<th style="width:60px">思考</th><th style="width:60px">联网</th>' : ''}
          <th style="width:${isText ? 170 : 170}px"></th></tr>
      ${rows}
    </table>
    ${items.length ? '' : `<div class="empty">尚无${KIND_CN[kind]}</div>`}`;
}

/**
 * 新增和编辑共用一张表单，**两类也共用同一张**（2026-08-23 用户定，见 sectionHtml）。
 *
 * 🔴 只有三样要填：**接口地址 / API key / 模型 id**（原话：「新增部分只需要提供
 * 接口地址，api，模型id 就好……接口模式应该也是不需要的」）。撤掉的是：
 *   · 代号 —— 从模型 id 派生（它是内部标识，让人取名只是多一个字段要想）
 *   · 名称、备注 —— 列表里显示模型 id 就够了，再起个中文名是同一件事写两遍
 *   · 接口格式 —— 从地址推断（`guessFormat`）：地址里已经写着是哪家了
 *   · 额外参数 JSON、排序、启用 —— 走默认值。要停用就删掉再加回来，代号是自动的
 *
 * 单价留着（用户明确要）：文本按百万 token 两档，配图**按次 + 按百万 token 两种** ——
 * 中转商多数按张报价，原厂多数按 token。填哪个都行，按次优先。
 * 「思考模式 / 联网」只在**编辑已有模型**时出现（用户原话：「对于已经配置好的，
 * 只需要再增加联网和思考模式两个按键就好了」）—— 新增时那一家支不支持还不知道，
 * 地址一填、存下来，格式认出来了，开关才有意义。
 */
function modelForm(kind, m) {
  const v = m || {};
  const isText = kind === 'text';
  const o = v.options || {};
  const caps = v.caps || { thinking: false, search: false };

  return `<div class="field"><label>接口地址</label>
      <input type="text" id="m_base" value="${esc(v.base_url || '')}"
        placeholder="${isText ? '如 https://api.deepseek.com' : '如 https://cdn.12ai.org/v1'}" style="width:100%"></div>
    <div class="field"><label>API key${m ? '（留空不改）' : ''}</label>
      <input type="text" id="m_apikey" value="" placeholder="${m ? esc(v.api_key_masked || '') : 'sk-…'}" style="width:100%"></div>
    <div class="field"><label>模型 id</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="m_model" value="${esc(v.model || '')}"
          placeholder="${isText ? '如 deepseek-v4-pro' : '如 gemini-3.1-flash-image-preview'}" style="flex:1">
        <button class="btn-sm" onclick="fetchRemoteModels('${kind}')" style="white-space:nowrap">获取列表</button>
      </div>
      <!-- 取回来的清单用**真下拉**，不用 datalist（2026-08-23 用户提「获取列表看不到 v4-pro」）。
           datalist 是输入框的联想提示：要点进输入框才展开，而且多数浏览器只显示
           匹配已输入字符的项 —— 点完「获取列表」看起来像没反应，
           输入了 deepseek-v4-f 就只剩 flash 两个，v4-pro 被过滤掉了。
           下拉默认藏着，取到清单才出现（没取过的时候摆一个空下拉是噪音）。 -->
      <select id="m_model_pick" onchange="pickRemoteModel()"
        style="width:100%;margin-top:8px;display:none"></select></div>
    ${m && isText ? `
    <div class="grid2">
      <div class="field"><label>
        <input type="checkbox" id="m_thinking" ${o.thinking ? 'checked' : ''} ${caps.thinking ? '' : 'disabled'}>
        思考模式${caps.thinking ? '' : '（这一家的接口不支持）'}
      </label></div>
      <div class="field"><label>
        <input type="checkbox" id="m_search" ${o.search ? 'checked' : ''} ${caps.search ? '' : 'disabled'}>
        联网${caps.search ? '' : '（这一家的接口不支持）'}
      </label></div>
    </div>` : ''}
    ${isText ? `
    <div class="grid2">
      <div class="field"><label>输入单价（分/百万token）</label>
        <input type="number" id="m_price_in" value="${o.price_in_cents_per_mtok ?? ''}" min="0" style="width:100%"></div>
      <div class="field"><label>输出单价（分/百万token）</label>
        <input type="number" id="m_price_out" value="${o.price_out_cents_per_mtok ?? ''}" min="0" style="width:100%"></div>
    </div>` : `
    <div class="grid2">
      <div class="field"><label>按次单价（分/张）</label>
        <input type="number" id="m_price_call" value="${o.price_per_call_cents ?? ''}" min="0" style="width:100%"></div>
      <div class="field"><label>输出单价（分/百万token）</label>
        <input type="number" id="m_price_out" value="${o.price_out_cents_per_mtok ?? ''}" min="0" style="width:100%"></div>
    </div>`}`;
}

/**
 * 向服务商要模型清单（如 DeepSeek 的 pro / flash），填进模型 id 输入框的下拉里。
 * 编辑已有模型时表单里 api_key 是空的（留空 = 不改），带上 editingModelKey
 * 让后端用库里那把。gemini / minimax 没有标准清单接口，后端会报错让人手填。
 */
window.fetchRemoteModels = async function fetchRemoteModels(kind) {
  try {
    const d = await api('POST', '/models/remote-list', {
      key: editingModelKey,
      kind,
      base_url: document.getElementById('m_base').value.trim(),
      api_key: document.getElementById('m_apikey').value.trim(),
    });
    const cur = document.getElementById('m_model').value.trim();
    const sel = document.getElementById('m_model_pick');
    // 第一项是提示，选它不动输入框 —— 下拉一出现就默认选中第一个模型的话，
    // 等于替人做了选择
    sel.innerHTML = [`<option value="">从 ${d.models.length} 个里选一个…</option>`]
      .concat(d.models.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`))
      .join('');
    sel.style.display = '';
    toast(`取到 ${d.models.length} 个模型，在下面的列表里选`);
  } catch (e) {
    toast(e.message);
  }
};

/** 从下拉选一个 → 填进模型 id 输入框（那个框才是真正提交的值，仍可手改） */
window.pickRemoteModel = function pickRemoteModel() {
  const v = document.getElementById('m_model_pick').value;
  if (v) document.getElementById('m_model').value = v;
};

/* 「获取列表」要知道现在编辑的是哪个模型（编辑时表单里 api_key 恒为空，
   后端得用库里那把 key）。新增时是 null */
let editingModelKey = null;

window.openNewModel = function openNewModel(kind) {
  editingModelKey = null;
  // 弹窗宽度跟「导入名单」那个一致（680px）—— 后台的表单弹窗统一这一档，
  // 默认那档 520px 塞两列 grid 会显得挤（2026-08-23 用户提）
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box" style="width:680px">
    <h3>新增${KIND_CN[kind]}</h3>
    ${modelForm(kind, null)}
    <div class="foot">
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveNewModel('${kind}')">保存</button>
    </div>
  </div></div>`;
  render();
};

// 按 key 从已加载的数据里找，不把整个对象塞进 onclick —— 那样要把 JSON 塞进 HTML 属性，
// 名字里一个引号就能把整块 HTML 撕开
window.editModel = function editModel(key) {
  const m = (S.data.models?.items || []).find((x) => x.key === key);
  if (!m) return;
  editingModelKey = key;
  S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box" style="width:680px">
    <h3>编辑「${esc(m.model || m.key)}」</h3>
    ${modelForm(m.kind, m)}
    <div class="foot">
      <!-- **每个模型都能删**（2026-08-22 用户定：「不要写死在 .env 中，
           应该是可以删除或者编辑的」）。.env 里的在启动时已经播种进
           ai_models 表，而播种只发生一次 —— 所以删掉不会在重启后自己回来。
           最后一个启用的文本模型是例外（删光了服务起不来），后端会拦。
           见 services/modelRegistry.js 文件头。 -->
      <button class="btn-sm btn-danger" onclick="delModel('${esc(m.key)}')">删除</button>
      <button class="btn-sm" onclick="testModel('${esc(m.key)}')">模型测试</button>
      <span style="flex:1"></span>
      <button class="btn-sm" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveEditModel('${esc(m.key)}','${m.kind}')">保存</button>
    </div>
  </div></div>`;
  render();
};

/**
 * 读表单。
 *
 * ⚠️ **已有的 options 要原样带回去**（`base` 那一份）：表单里只有单价和两个开关，
 * 而库里那一行还存着 `timeout_ms` / `max_retries` / `imageSize` 这类没有输入框的旋钮 ——
 * 不带回去的话，保存一次就把它们悄悄清空了（超时从 60 秒变成默认值，不报错）。
 * 「额外参数（JSON）」那一格 2026-08-23 撤了，所以这些键现在只能这样保住。
 */
function readModelForm(kind, base) {
  const options = { ...(base || {}) };
  const el = (id) => document.getElementById(id);
  // 两个开关只在编辑已有模型时出现（新增时那一家支不支持还不知道）
  if (el('m_thinking')) options.thinking = el('m_thinking').checked;
  if (el('m_search')) options.search = el('m_search').checked;
  const priceFields = kind === 'text'
    ? [['m_price_in', 'price_in_cents_per_mtok'], ['m_price_out', 'price_out_cents_per_mtok']]
    : [['m_price_call', 'price_per_call_cents'], ['m_price_out', 'price_out_cents_per_mtok']];
  for (const [id, k] of priceFields) {
    if (!el(id)) continue;
    const val = el(id).value.trim();
    if (val === '') delete options[k];
    else options[k] = Number(val);
  }
  return {
    kind,
    base_url: el('m_base').value.trim(),
    model: el('m_model').value.trim(),
    api_key: el('m_apikey').value.trim(),
    options,
  };
}

window.saveNewModel = async function saveNewModel(kind) {
  const body = readModelForm(kind);
  if (!body) return;
  try {
    const d = await api('POST', '/models', body);
    closeModal();
    // 把「认成了哪家」说出来：格式是从地址推断的，认错了只有这一句和列表那一列看得出来
    toast(`已新增（识别为 ${d.format}），可用「模型测试」验证`);
    load();
  } catch (e) {
    toast(e.message);
  }
};

window.saveEditModel = async function saveEditModel(key, kind) {
  // 把库里那一行的 options 当底：表单只有单价和开关，其余旋钮靠它保住（见 readModelForm）
  const cur = (S.data.models?.items || []).find((x) => x.key === key);
  const body = readModelForm(kind, cur?.options);
  if (!body) return;
  try {
    await api('POST', '/models/' + key + '/update', body);
    closeModal();
    toast('已保存');
    load();
  } catch (e) {
    toast(e.message);
  }
};

window.delModel = async function delModel(key) {
  if (!confirm('删除「' + key + '」？已生成的内容不受影响，仅表示此后不再使用该模型。')) return;
  try {
    await api('POST', '/models/' + key + '/delete');
    toast('已删除');
    closeModal();
    load();
  } catch (e) {
    toast(e.message);
  }
};

/**
 * 测试。加完一个模型最想知道的就是「它到底通不通」，
 * 不该跑回小程序开一份教案、等一分钟，才发现地址填错了。
 * 配图试画一张给缩略图；文本发一条极小消息，看耗时和回复。
 */
window.testModel = async function testModel(key) {
  const m = (S.data.models?.items || []).find((x) => x.key === key);
  toast('正在测试，请稍候');
  try {
    const r = await api('POST', '/models/' + key + '/test', {});
    if (m?.kind === 'text') {
      S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
        <h3>「${esc(key)}」连接正常</h3>
        <div class="sub">耗时 ${(r.ms / 1000).toFixed(1)} 秒 · token ${r.token_in ?? '—'} 入 / ${r.token_out ?? '—'} 出</div>
        <div style="margin-top:12px;padding:12px;border:1px solid var(--rule-2);border-radius:12px">${esc(r.reply || '')}</div>
        <div class="foot"><button class="btn" onclick="closeModal()">关闭</button></div>
      </div></div>`;
    } else {
      S.modal = `<div class="modal" onclick="if(event.target===this)closeModal()"><div class="box">
        <h3>「${esc(key)}」出图正常</h3>
        <div class="sub">${r.width}×${r.height} · ${(r.bytes / 1024).toFixed(0)} KB · 耗时 ${(r.ms / 1000).toFixed(1)} 秒</div>
        <img src="${esc(r.url)}" style="width:100%;border:1px solid var(--rule-2);border-radius:12px;margin-top:12px">
        <div class="foot"><button class="btn" onclick="closeModal()">关闭</button></div>
      </div></div>`;
    }
    render();
  } catch (e) {
    toast(e.message);
  }
};

/**
 * 设为默认。按这一行是文本还是配图写各自的默认键 —— 老师那边没有选择器。
 * 存在数据库里（不是 .env），所以点完立刻生效，不用重启后端。
 */
window.setDefaultModel = async function setDefaultModel(key) {
  try {
    await api('POST', '/models/' + key + '/default');
    toast('已设为默认「' + key + '」');
    load();
  } catch (e) {
    toast(e.message);
  }
};
