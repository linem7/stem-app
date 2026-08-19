/**
 * 名单：**一份岗位清单**（013 建表 / 016 去掉手机号，operations.md 第 1 节）
 *
 * 老师不登录 —— 微信静默给一个 openid，那是一串随机字符，
 * 微信不告诉我们它属于哪个自然人。所以「她是谁」必须由别的东西建立：
 *
 *   · **兑换码**      证明「你是这批人里的」（问卷星在她提交答卷后当场发）
 *   · **从名单里选**  证明「你是哪一个」（园所 → 班级 → 岗位·姓氏）
 *
 * 为什么不是让她填手机号（013 曾经是那样）：11 位手打，打错一位是常事，
 * 而她分不清是「码坏了」还是「我打错了」。从列表里认自己，出错概率低一个数量级。
 * 而且她要证明的事情本来就只是「我是阳光幼儿园小一班的主班」——
 * 那句话里没有手机号，库里少一样可识别到人的东西就少一整套合规义务。
 *
 * 【三层身份】
 *   teacher_ref   人。永不变，跨班跨园跟着她
 *   roster.id     位置（class_teacher_id）：人 × 园 × 班 × 岗位
 *   teachers.id   账号。换微信靠换绑码保住
 */
import { query, queryOne } from '../db/pool.js';

export const ROSTER_STATUS = {
  PENDING: 'pending', CLAIMED: 'claimed', VOID: 'void', MOVED: 'moved',
};

export const POSITIONS = ['主班', '配班', '保育员', '园长', '其他'];
export const AGE_GROUPS = ['小班', '中班', '大班'];

/** 姓氏。她认自己够了，把同事全名摊给任何拿到码的人是没必要的暴露 */
export function surnameOf(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  // 复姓不管了 —— 这一项只是帮她认自己，不是身份证明。认错了还有班级和岗位兜着
  return s.slice(0, 1);
}

/**
 * 解析粘贴进来的一段名单文本。
 *
 * 一行一人：`姓名, 班级, 岗位, 年龄班`（后三项可缺）。
 *
 * 分隔符认**逗号（含全角）、顿号、制表符、两个以上空格**：
 * 从 Excel 复制过来是制表符，从微信复制过来是各种逗号，手打的常常是全角。
 * 单个空格**不当**分隔符 —— 「王 小美」是一个名字，不是两列。
 *
 * **岗位和年龄班按内容认，不按位置认**：名单里这几列的顺序每个园都不一样，
 * 而这三样的取值是封闭的，认内容比认位置可靠得多。
 * 剩下那些既不是岗位也不是年龄班的列里，**第一列当姓名，第二列当班级** ——
 * 因为「姓名在最前面」这一条几乎所有名单都成立。
 *
 * 013 那一版靠「哪一列能解析成 11 位手机号」来定位，现在没有手机号了，
 * 所以定位规则整个换了。
 *
 * 返回每一行的结果（带行号），**不写库** —— 写库由调用方决定，
 * 因为要先给人看一眼预览。
 */
export function parseRoster(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const rows = [];
  const seen = new Set();   // 这一段文本自己内部的重复

  lines.forEach((line, i) => {
    const raw = line.trim();
    if (!raw) return;                        // 空行直接跳过，不报错
    const lineNo = i + 1;

    const cells = raw.split(/[,，、\t]|\s{2,}/).map((c) => c.trim()).filter((c) => c !== '');
    if (!cells.length) return;

    // 表头那行也跳过 —— 复制的时候常常带上。
    // 判据：整行都是列名，没有一个能当姓名的词
    if (cells.every((c) => /^(姓名|名字|老师|教师|班级|班|岗位|职位|年龄班|年级|序号|编号)$/.test(c))) return;

    const position = cells.find((c) => POSITIONS.includes(c)) || null;
    const ageGroup = cells.find((c) => AGE_GROUPS.includes(c)) || null;
    // 剩下的：既不是岗位也不是年龄班，也不是纯数字（序号列）
    const rest = cells.filter((c) => !POSITIONS.includes(c) && !AGE_GROUPS.includes(c) && !/^\d+$/.test(c));

    const realName = rest[0] || null;
    if (!realName) {
      rows.push({ line: lineNo, ok: false, reason: '这一行看不出姓名', raw });
      return;
    }
    // 姓名那一列不该是「小一班」这种 —— 顺序反了的话至少要说一声
    if (/班$/.test(realName) && rest.length > 1) {
      rows.push({
        line: lineNo, ok: false, raw,
        reason: `「${realName}」看着像班级不像姓名，把姓名放到最前面再试`,
      });
      return;
    }

    const className = rest[1] || null;
    const key = `${realName}|${className || ''}|${position || ''}`;
    if (seen.has(key)) {
      rows.push({ line: lineNo, ok: false, reason: '这一段文本里重复了', raw });
      return;
    }
    seen.add(key);

    rows.push({
      line: lineNo,
      ok: true,
      real_name: realName.slice(0, 32),
      class_name: className ? className.slice(0, 32) : null,
      position,
      age_group: ageGroup,
      raw,
    });
  });

  return rows;
}

/**
 * 标出哪些行名单里已经有了。
 *
 * 重复判定是（园所 + 班级 + 岗位 + 姓名）四项全同。
 * 没有手机号之后这是唯一能用的判据 —— 光看姓名会把两个园的同名老师当成一个人。
 *
 * **跳过而不是覆盖**：覆盖会悄悄改掉一个人的身份，而名单是激活的依据 ——
 * 改错了她激活出来就是别人。
 */
export async function annotateExisting(rows, kindergartenId = null) {
  const good = rows.filter((r) => r.ok);
  if (!good.length) return rows;

  const exist = new Set((await query(
    `SELECT real_name, COALESCE(class_name,'') AS c, COALESCE(position,'') AS p
       FROM teacher_roster
      WHERE status <> 'void'
        AND kindergarten_id IS NOT DISTINCT FROM $1
        AND real_name = ANY($2::text[])`,
    [kindergartenId, good.map((r) => r.real_name)]
  )).rows.map((r) => `${r.real_name}|${r.c}|${r.p}`));

  return rows.map((r) => (r.ok
      && exist.has(`${r.real_name}|${r.class_name || ''}|${r.position || ''}`)
    ? { ...r, ok: false, reason: '名单里已经有这一位了（跳过，没有覆盖）' }
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

/**
 * 激活那一屏的选择器数据。
 *
 * **只回 `pending` 的位置**：已经被认领的不出现 ——
 * 她看到一个选不了的选项只会困惑。
 *
 * **姓名只给姓氏**。调用方（路由）负责先校验码有效，
 * 不设那道门任何人打开小程序就能看到一整个园的老师名单。
 */
export async function listOpenKindergartens() {
  return (await query(`
    SELECT k.id, k.name, COUNT(r.id)::int AS open
      FROM teacher_roster r JOIN kindergartens k ON k.id = r.kindergarten_id
     WHERE r.status = 'pending'
     GROUP BY k.id, k.name
     ORDER BY k.name`)).rows;
}

export async function listOpenEntries(kindergartenId) {
  const rows = (await query(`
    SELECT id, real_name, class_name, position, age_group, note_public
      FROM teacher_roster
     WHERE status = 'pending' AND kindergarten_id = $1
     ORDER BY age_group NULLS LAST, class_name NULLS LAST, position NULLS LAST, id`,
  [kindergartenId])).rows;

  return rows.map((r) => ({
    id: r.id,
    class_name: r.class_name,
    position: r.position,
    age_group: r.age_group,
    // 只给姓氏。两个同姓配班时靠 note_public 区分（「配班（靠窗）」这种）
    surname: surnameOf(r.real_name),
    note: r.note_public,
  }));
}

/** 名单那一行 + 园所名字。激活时用 */
export async function findEntry(id, client = null) {
  const sql = `SELECT r.*, k.name AS kindergarten FROM teacher_roster r
                 LEFT JOIN kindergartens k ON k.id = r.kindergarten_id
                WHERE r.id = $1`;
  if (client) return (await client.query(`${sql} FOR UPDATE OF r`, [id])).rows[0];
  return queryOne(sql, [id]);
}
