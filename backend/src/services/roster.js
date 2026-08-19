/**
 * 名单：激活的第二把钥匙（013 迁移，operations.md 第 1 节）
 *
 * 老师不登录 —— 微信静默给一个 openid，那是一串随机字符，
 * 微信不告诉我们它属于哪个自然人。所以「她是谁」必须由别的东西建立：
 *
 *   · **兑换码**  证明「你是这批人里的」（问卷星在她提交答卷后当场发）
 *   · **手机号**  证明「你是这批人里的哪一个」（她自己打，跟这张名单核对）
 *
 * 为什么不能只用手机号：它在一个园里不是秘密（微信群、报名表、通知单上都有）。
 * 只用它当凭据等于没有门槛。
 *
 * 🔴 真实手机号进库的前提：伦理审查 + 协议里单独写清楚。开发用假号（138xxxx）。
 */
import { query, queryOne } from '../db/pool.js';

/** 名单一行的合法状态 */
export const ROSTER_STATUS = { PENDING: 'pending', CLAIMED: 'claimed', VOID: 'void' };

const POSITIONS = ['主班', '配班', '保育员', '园长', '其他'];
const AGE_GROUPS = ['小班', '中班', '大班'];

/**
 * 手机号清洗。
 *
 * 从微信或 Excel 复制过来的号常常带空格（`138 0000 1234`）、
 * 横线、甚至前面一个 `+86`。**认不出来是我们的问题，不是使用者的**，
 * 所以这里尽量宽容，只在真的不是 11 位手机号时才拒绝。
 */
export function normalizePhone(raw) {
  let s = String(raw ?? '').replace(/\D/g, '');
  // +86 / 0086 前缀
  if (s.length === 13 && s.startsWith('86')) s = s.slice(2);
  if (s.length === 14 && s.startsWith('0086')) s = s.slice(4);
  return /^1\d{10}$/.test(s) ? s : null;
}

/**
 * 解析粘贴进来的一段名单文本。
 *
 * 一行一人：`姓名, 手机号, 班级, 岗位, 年龄班`（后三项可缺）。
 *
 * 分隔符认**逗号（含全角）、制表符、两个以上空格**：从 Excel 复制过来是制表符，
 * 从微信复制过来是各种逗号，手打的常常是全角。全都认。
 * 单个空格不当分隔符 —— 「王 老师」是一个名字，不是两列。
 *
 * 姓名和手机号哪一列在前**不假设**：两列里哪个能解析成手机号就是手机号。
 * 园长发过来的名单顺序不由我们决定。
 *
 * 返回每一行的结果（带行号），**不写库** —— 写库由调用方决定，
 * 因为要先给人看一眼预览。
 */
export function parseRoster(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const rows = [];
  const seen = new Set();   // 这一段文本自己内部的重号

  lines.forEach((line, i) => {
    const raw = line.trim();
    if (!raw) return;                       // 空行直接跳过，不报错
    // 表头那行（「姓名」「手机号」这种）也跳过 —— 复制的时候常常带上
    if (/^(姓名|老师|名字)\s*[,，\t]/.test(raw) && !/\d{6}/.test(raw)) return;

    const cells = raw.split(/[,，、\t]|\s{2,}/).map((c) => c.trim()).filter((c) => c !== '');
    const lineNo = i + 1;

    // 哪一列是手机号？能解析出来的那一列。不假设顺序
    let phone = null;
    let phoneIdx = -1;
    for (let k = 0; k < cells.length; k += 1) {
      const p = normalizePhone(cells[k]);
      if (p) { phone = p; phoneIdx = k; break; }
    }

    if (!phone) {
      rows.push({ line: lineNo, ok: false, reason: '这一行找不到 11 位手机号', raw });
      return;
    }
    if (seen.has(phone)) {
      rows.push({ line: lineNo, ok: false, reason: '这一段文本里重复了', phone, raw });
      return;
    }
    seen.add(phone);

    // 剩下的列按「姓名在手机号之前，其余在之后」的常见排法认。
    // 认错了不要紧 —— 预览会显示解析结果，人能看出来
    const rest = cells.filter((_, k) => k !== phoneIdx);
    const realName = phoneIdx > 0 ? cells[0] : (rest[0] || null);
    const tail = phoneIdx > 0 ? rest.slice(1) : rest.slice(1);

    rows.push({
      line: lineNo,
      ok: true,
      phone,
      real_name: realName ? String(realName).slice(0, 32) : null,
      // 岗位和年龄班是枚举，从剩下的列里**按内容认**而不是按位置认：
      // 名单里这几列的顺序每个园都不一样
      position: tail.find((c) => POSITIONS.includes(c)) || null,
      age_group: tail.find((c) => AGE_GROUPS.includes(c)) || null,
      class_name: tail.find((c) => !POSITIONS.includes(c) && !AGE_GROUPS.includes(c))?.slice(0, 32) || null,
      raw,
    });
  });

  return rows;
}

/**
 * 导入。`dryRun` 时只查库标注哪些已经存在，一行都不写。
 *
 * 整批一个事务由调用方用 withTransaction 包 —— 要么全写进去，要么一行都不写：
 * 半截导入之后没人知道该从哪一行接着来。
 */
export async function annotateExisting(rows) {
  const phones = rows.filter((r) => r.ok).map((r) => r.phone);
  if (!phones.length) return rows;
  const exist = new Set((await query(
    `SELECT phone FROM teacher_roster WHERE phone = ANY($1::text[])`, [phones]
  )).rows.map((r) => r.phone));

  return rows.map((r) => (r.ok && exist.has(r.phone)
    // **跳过而不是覆盖**：覆盖会悄悄改掉一个人的身份，
    // 而名单是激活的依据 —— 改错了她激活出来就是别人
    ? { ...r, ok: false, reason: '名单里已经有这个号了（跳过，没有覆盖）' }
    : r));
}

export function summarize(rows) {
  return {
    total: rows.length,
    ok: rows.filter((r) => r.ok).length,
    duplicate: rows.filter((r) => !r.ok && /已经有|重复/.test(r.reason || '')).length,
    invalid: rows.filter((r) => !r.ok && !/已经有|重复/.test(r.reason || '')).length,
  };
}

/** 按手机号找名单那一行。激活时用，所以要顺手把园所名字带出来 */
export async function findByPhone(phone, client = null) {
  const run = client ? (sql, p) => client.query(sql, p).then((r) => r.rows[0]) : queryOne;
  return run(
    `SELECT r.*, k.name AS kindergarten FROM teacher_roster r
       LEFT JOIN kindergartens k ON k.id = r.kindergarten_id
      WHERE r.phone = $1`,
    [phone]
  );
}
