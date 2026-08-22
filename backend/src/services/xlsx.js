/**
 * xlsx 的两件事：**生成模板**和**读回一张表**。
 *
 * 为什么要 Excel 而不是继续只支持粘贴：园长给过来的名单本来就是 .xlsx，
 * 中间那一步「打开、全选、复制、粘进浏览器」是我们让人做的，不是必需的。
 *
 * 为什么依赖是 exceljs 而不是 xlsx（SheetJS）：npm 上的 `xlsx` 停在 0.18.5 ——
 * SheetJS 把新版挪去自家 CDN 了，装 npm 那个等于永久停在一个不再更新的版本上。
 * exceljs 在 npm 上还在发（4.4.0）。
 *
 * ⚠️ `npm audit` 会报两条 moderate，来自 exceljs 的传递依赖 `uuid`
 * （GHSA-w5hq-g745-h8pq：v3/v5/v6 在**调用方传入过小的 buf** 时缺边界检查）。
 * exceljs 不拿用户输入当 buf，这条路走不到；`audit fix --force` 会把 exceljs
 * 降到 3.4.0，代价比风险大。**别为了让 audit 变绿去降版本。**
 *
 * ─────────────────────────────────────────────────────────────────
 * 🔴 这个文件只做「文件 ↔ 二维数组」的搬运，**一个字段规则都不认**。
 *
 * 认字段是 `services/roster.js` 的 parseRoster 和 admin 路由里那几个映射的事。
 * 理由：名单已经支持粘贴文本导入，那套「按内容认而不按列位认」的规则
 * （姓名/班级/岗位/年级顺序随便、全角逗号也认）是踩出来的。
 * 为 xlsx 再写一份认字段的逻辑，两份迟早分叉 ——
 * 而分叉的表现是「粘贴能导进去、上传同一份数据少认出三个人」，不报错。
 * ─────────────────────────────────────────────────────────────────
 */
import ExcelJS from 'exceljs';
// badRequest ＝ VALIDATION_FAILED + 一句能直接给人看的中文。
// 「这个文件不对」不是服务器出错，是使用者要看到并能自己修的一句话
import { badRequest } from '../utils/errors.js';

/** 上限：一次导入不该有几千行。超了大概是传错文件（比如一份导出的教案表） */
const MAX_ROWS = 2000;

/**
 * 生成一份模板。
 *
 * @param {object} o
 * @param {string}   o.sheetName
 * @param {string[]} o.columns   列头
 * @param {Array<Array>} [o.samples]  示例行。**给两行，不要给空模板**
 * @param {number[]} [o.widths]
 * @returns {Promise<Buffer>}
 */
export async function buildTemplate({ sheetName, columns, samples = [], widths }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);

  ws.addRow(columns);
  samples.forEach((r) => ws.addRow(r));

  // 列头加粗 + 底色。不是装饰：一份看起来就像表格的模板，
  // 人不会把它当成「第一行也是数据」而在上面插一行
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBF7EC' } };
  ws.columns.forEach((c, i) => {
    // 中文列头按字符数给宽度会太窄（一个汉字约两个字符宽），×2.2 目测合适
    c.width = widths?.[i] ?? Math.max(10, String(columns[i] || '').length * 2.2 + 4);
  });
  // 冻结首行：名单几十行往下滚的时候还看得见自己在填哪一列
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * 读回第一个工作表，返回二维数组（每格都是去过空白的字符串）。
 *
 * **只读第一个表**：模板就一个表。多表的情况我们说清楚，而不是去猜哪个才是数据。
 *
 * @param {string} base64
 * @returns {Promise<{rows: string[][], sheetName: string, sheetCount: number}>}
 */
export async function sheetToRows(base64) {
  const raw = String(base64 || '');
  if (!raw.trim()) throw badRequest('没收到文件内容');

  // data URL 前缀（`data:application/...;base64,`）：前端要是用 FileReader
  // 的 readAsDataURL 就会带上它。这里顺手剥掉，比要求前端记得剥更省事
  const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    throw badRequest('这个文件读不出来，重新选一次');
  }
  if (!buf.length) throw badRequest('这个文件是空的');
  // .xlsx 本质是个 zip，头四字节是 PK\x03\x04。
  // 判一下能给出一句有用的话 —— 最常见的错是把 .xls（老格式）或 .csv 当 xlsx 传上来，
  // 而 exceljs 对这两种会抛一条看不懂的内部错误
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    throw badRequest('这不是 .xlsx 文件。老版 .xls 和 .csv 都不行，在 Excel 里「另存为」成 .xlsx 再传');
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch {
    throw badRequest('这个 Excel 文件打不开，可能是损坏了或者加了密码');
  }

  const ws = wb.worksheets[0];
  if (!ws) throw badRequest('这个文件里一个工作表都没有');

  const rows = [];
  // eachRow 默认跳过完全空的行，但**中间的空行会让行号跟人看到的对不上**，
  // 所以用 includeEmpty 自己走，行号 = Excel 里的行号
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (rowNumber > MAX_ROWS) return;
    const cells = [];
    // row.eachCell 会跳过空格子（于是「姓名, , 主班」错位成「姓名, 主班」）。
    // 按 cellCount 逐列取才能保住列的位置
    for (let i = 1; i <= row.cellCount; i += 1) {
      cells.push(cellText(row.getCell(i)));
    }
    rows[rowNumber - 1] = cells;
  });

  // rows 是稀疏数组（空行没赋值），补成空数组，让调用方能安心 .map
  for (let i = 0; i < rows.length; i += 1) if (!rows[i]) rows[i] = [];

  return { rows, sheetName: ws.name, sheetCount: wb.worksheets.length };
}

/**
 * 一个格子的文字。
 *
 * exceljs 的 `cell.value` 有七八种形态，直接 String() 会得到 `[object Object]`：
 *   · 公式格 → `{ formula, result }`，要的是算出来的 result
 *   · 富文本 → `{ richText: [{text}, ...] }`
 *   · 超链接 → `{ text, hyperlink }`（园长常把问卷链接贴成超链接）
 *   · 日期   → Date 对象
 *   · 数字   → number（「在园幼儿数 310」）
 */
function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    // Date 放最前面：它是最常见的那种非普通对象，而且底下几个 in 判断
    // 对它都是 false，排后面能过但读的人得先确认一遍
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('').trim();
    if ('result' in v) return v.result === null || v.result === undefined ? '' : String(v.result).trim();
    if ('text' in v) return String(v.text).trim();
    return '';
  }
  return String(v).trim();
}

/**
 * 把一张表拼成「粘贴导入」认的那种文本：单元格用制表符连，行用换行连。
 *
 * 这是**复用 parseRoster 的桥**（见文件头那段）。制表符正是从 Excel
 * 复制粘贴时的分隔符，所以 parseRoster 本来就认。
 */
export function rowsToText(rows) {
  return rows.map((cells) => cells.join('\t')).join('\n');
}
