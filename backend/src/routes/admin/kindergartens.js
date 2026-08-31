import { Router } from 'express';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../../utils/errors.js';
import { logAction } from '../../services/admins.js';
import { buildTemplate, sheetToRows } from '../../services/xlsx.js';
import { maskPhone, sendXlsx } from './_shared.js';

export const kindergartensRouter = Router();

// ---------------------------------------------------------------
// 园所
// ---------------------------------------------------------------
/**
 * 园所列表 —— 带用量汇总。
 *
 * 原来只有名字、备注、老师数，回答不了唯一真正要问的问题：
 * **这个园到底在不在用**。发出去 20 个码、兑了 1 个、那一个人写了 2 份就停了 ——
 * 这三个数摆在一行才看得出来，分散在三个页面就永远看不出来。
 *
 * 全部是聚合数，**不含任何老师个人信息**，所以一般管理员也能看全部。
 *
 * 写法上用标量子查询而不是多个 LEFT JOIN + GROUP BY：join 一多就会互相放大
 * （老师 × 教案 × 配图 的笛卡尔积让 COUNT 全部虚高），这是这类统计最常见的错。
 * 园所是几十行的表，多几个子查询无所谓。
 */
kindergartensRouter.get('/kindergartens', asyncRoute(async (req, res) => {
  const rows = (await query(`
    SELECT k.id, k.name, k.note, k.created_at,
      -- 特征（010 迁移）。这不只是档案：**任务定向就筛这几个字段**
      k.province, k.city, k.area_type, k.ownership,
      k.teacher_count, k.child_count, k.contact_name, k.contact_phone,
      -- 起始合作日期（020 迁移）。**不要拿 created_at 兜底** ——
      -- 那是这一行被导进库的时刻，不是合作开始的那一天，见迁移里的说明
      k.cooperation_started_at,
      (SELECT COUNT(*)::int FROM teachers t
        WHERE t.kindergarten_id = k.id AND t.activated_at IS NOT NULL
          AND t.status <> 'deleted')                                        AS teachers,
      (SELECT COUNT(*)::int FROM teachers t
        WHERE t.kindergarten_id = k.id
          AND t.last_login_at > now() - interval '7 days')                  AS active_7d,
      (SELECT MAX(t.last_login_at) FROM teachers t
        WHERE t.kindergarten_id = k.id)                                     AS last_active_at,
      -- 码是挂在园所上发的，兑没兑得看这个：发了一批没人兑 = 这次合作没落地
      (SELECT COUNT(*)::int FROM redemption_codes c
        WHERE c.kindergarten_id = k.id AND c.status = 'unused')             AS codes_unused,
      (SELECT COUNT(*)::int FROM lesson_plans p JOIN teachers t ON t.id = p.teacher_id
        WHERE t.kindergarten_id = k.id)                                     AS plans,
      -- 额度跟老师页同一套算法：台账 Σ发放 −（教案数 + 超过 3 版的改稿次数）。
      -- 那个 3 是 quota.js 的 FREE_VERSION_CEILING（初稿 + 2 次免费改稿），
      -- 本文件的老师列表也硬写着同一个数 —— 改免费次数时三处一起改

      (SELECT COALESCE(SUM(g.delta_text),0)::int FROM quota_grants g
         JOIN teachers t ON t.id = g.teacher_id
        WHERE t.kindergarten_id = k.id)                                     AS granted_text,
      (SELECT COALESCE(SUM(1 + GREATEST(0, p.version - 3)),0)::int
         FROM lesson_plans p JOIN teachers t ON t.id = p.teacher_id
        WHERE t.kindergarten_id = k.id)                                     AS used_text,
      (SELECT COUNT(*)::int FROM lesson_images i
         JOIN lesson_plans p ON p.id = i.lesson_plan_id
         JOIN teachers t ON t.id = p.teacher_id
        WHERE t.kindergarten_id = k.id AND i.status = 'ready')              AS images,
      -- 🔴 花费 = **配图 + 文本**（2026-08-22 起这一列摆在园所列表上）。
      -- 原来它只算配图，而名字叫 cost_cents —— 那时它只喂详情弹窗里
      -- 一张写着「花 ￥x」的小卡，少算的那截没人对得出来。
      -- 现在它是「这个园花了我多少钱」的唯一显示处，漏掉文本成本
      -- 就是每份教案漏掉一次 DeepSeek 调用，而那才是大头。
      -- 文本成本靠 model_calls.teacher_id 归到园上（跟撤掉的那张概览表同一套算法）。
      -- 021 之后 cost_cents 是 NUMERIC 小数分（逐行整数分会把 0.1 分全 round 成 0），
      -- 这里 ::int 对 SUM 的结果四舍五入，正好是「最后一步才取整」
      (SELECT COALESCE(SUM(i.cost_cents),0)::int FROM lesson_images i
         JOIN lesson_plans p ON p.id = i.lesson_plan_id
         JOIN teachers t ON t.id = p.teacher_id
        WHERE t.kindergarten_id = k.id AND i.status = 'ready')              AS image_cost_cents,
      (SELECT COALESCE(SUM(m.cost_cents),0)::int FROM model_calls m
         JOIN teachers t ON t.id = m.teacher_id
        WHERE t.kindergarten_id = k.id)                                     AS text_cost_cents
      FROM kindergartens k ORDER BY k.name`)).rows;
  // 园长的号跟老师手机号同一条纪律：一般管理员只看打码。
  // 它不是老师的号，但「每多一个人能看到一个真实号码」的道理一样
  return ok(res, {
    items: rows.map((r) => ({
      ...r,
      cost_cents: (r.image_cost_cents || 0) + (r.text_cost_cents || 0),
      contact_phone: req.isSuper ? r.contact_phone : maskPhone(r.contact_phone),
      contact_phone_masked: !req.isSuper,
    })),
  });
}));

/** 城乡与办园性质的合法值。定向要按它们筛，写歪一个字那个园就永远筛不到 */
const AREA_TYPES = ['city', 'county', 'rural'];
const OWNERSHIPS = ['public', 'private'];

/**
 * 把人写的日期洗成 `YYYY-MM-DD`，认不出来回 `undefined`（**不是 null**）。
 *
 * 这两者要分开：`null` 是「明确清空」，`undefined` 是「这一格我没看懂」——
 * 导入时后者要整行报错，不能静默存成空，否则「起始合作」那一列
 * 会莫名其妙地缺一半，而当事人以为自己填了。
 *
 * 认四种写法：Excel 给的 Date 对象、2026-09-01、2026/9/1、2026年9月1日。
 * ⚠️ **不用 `new Date(字符串)` 兜底**：那玩意儿能把「广州」之外的一堆东西
 * 解析成 Invalid Date，也能把 `9/1/2026` 按美式月日序读成 1 月 9 日 ——
 * 认错比认不出来糟得多。
 */
function toDateOnly(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // 用本地日期而不是 toISOString()：后者按 UTC 切，东八区的 9 月 1 日 00:00
    // 会变成 8 月 31 日
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const n = (x) => Number(x);
  if (n(mo) < 1 || n(mo) > 12 || n(d) < 1 || n(d) > 31) return undefined;
  return `${y}-${String(n(mo)).padStart(2, '0')}-${String(n(d)).padStart(2, '0')}`;
}

/**
 * 从请求体里挑出园所特征字段。
 *
 * 语义是**只传哪项改哪项**：`undefined` = 不动，空字符串 = 清空。
 * 这两者必须分开——园所常常是先建一行，过几天才补齐省市和联系人，
 * 中间那些请求不该把没提到的字段刷成 null。
 */
function pickKgProfile(b, cur = {}) {
  const str = (k, max) => (b[k] === undefined
    ? cur[k] ?? null
    : String(b[k]).trim().slice(0, max) || null);
  const num = (k) => {
    if (b[k] === undefined) return cur[k] ?? null;
    const n = Number(b[k]);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };
  const enumOf = (k, allowed) => {
    if (b[k] === undefined) return cur[k] ?? null;
    const v = String(b[k]).trim();
    if (!v) return null;
    if (!allowed.includes(v)) throw badRequest(`${k} 只能是 ${allowed.join(' / ')}`);
    return v;
  };
  const date = (k) => {
    if (b[k] === undefined) return cur[k] ?? null;
    const d = toDateOnly(b[k]);
    if (d === undefined) throw badRequest('起始合作日期认不出来，写成 2026-09-01 这样');
    return d;
  };
  return {
    province: str('province', 16),
    city: str('city', 32),
    area_type: enumOf('area_type', AREA_TYPES),
    ownership: enumOf('ownership', OWNERSHIPS),
    teacher_count: num('teacher_count'),
    child_count: num('child_count'),
    contact_name: str('contact_name', 32),
    contact_phone: str('contact_phone', 20),
    cooperation_started_at: date('cooperation_started_at'),
  };
}

const KG_PROFILE_COLS = [
  'province', 'city', 'area_type', 'ownership',
  'teacher_count', 'child_count', 'contact_name', 'contact_phone',
  'cooperation_started_at',
];
/** `$3,$4,…` —— 占位符跟着 KG_PROFILE_COLS 长度走。
    2026-08-22 加第 9 项时才发现原来是手写死的 `$1..$10`，加一列必须记得改两处 SQL */
const KG_PROFILE_PLACEHOLDERS = KG_PROFILE_COLS.map((_, i) => `$${i + 3}`).join(',');

kindergartensRouter.post('/kindergartens', asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw badRequest('填个园所名字');
  const dup = await queryOne(`SELECT id FROM kindergartens WHERE name = $1`, [name]);
  if (dup) throw badRequest('这个园所已经有了');

  const p = pickKgProfile(req.body || {});
  const row = await queryOne(
    `INSERT INTO kindergartens (name, note, ${KG_PROFILE_COLS.join(', ')})
     VALUES ($1,$2,${KG_PROFILE_PLACEHOLDERS}) RETURNING *`,
    [name, String(req.body?.note || '').trim() || null, ...KG_PROFILE_COLS.map((c) => p[c])]);
  await logAction({ adminId: req.adminId, action: 'create_kindergarten', target: `kg:${row.id}`,
    detail: { name: row.name } });
  return ok(res, row);
}));

/**
 * 改园所。
 *
 * 一开始只能改名字和备注（备注写的是「合作起止、联系人」这类会变的东西，
 * 原来建完就永远改不了 —— 联系人换了只能建第二个园，
 * 而「同一个园不能有两行」正是这张表存在的全部理由）。
 *
 * 现在把**全部特征字段**也放进来：园所往往是先建一行占位，
 * 过几天才从园长那儿问齐省市、城乡、办园性质、人数。
 * 而这几个字段是**任务定向的依据** —— 填不上就意味着这个园收不到任何定向任务。
 */
kindergartensRouter.post('/kindergartens/:id/update', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await queryOne(`SELECT * FROM kindergartens WHERE id = $1`, [id]);
  if (!cur) throw notFound('没有这个园所');

  const b = req.body || {};
  const name = b.name === undefined ? cur.name : String(b.name).trim();
  if (!name) throw badRequest('园所名字不能空');
  if (name !== cur.name) {
    const dup = await queryOne(`SELECT id FROM kindergartens WHERE name = $1 AND id <> $2`, [name, id]);
    if (dup) throw badRequest('这个名字已经有别的园在用了');
  }
  const note = b.note === undefined ? cur.note : (String(b.note).trim() || null);
  const p = pickKgProfile(b, cur);

  const sets = KG_PROFILE_COLS.map((c, i) => `${c} = $${i + 4}`).join(', ');
  const row = await queryOne(
    `UPDATE kindergartens SET name = $2, note = $3, ${sets} WHERE id = $1 RETURNING *`,
    [id, name, note, ...KG_PROFILE_COLS.map((c) => p[c])]);
  await logAction({ adminId: req.adminId, action: 'update_kindergarten', target: `kg:${id}`,
    detail: { renamed: name !== cur.name } });
  return ok(res, row);
}));

/* ---------------- 园所批量导入（2026-08-21）---------------- */
//
// 一个个建的时候，实际流程是「园长发来一份 xlsx → 照着一行行敲」。
// 十个园就要开十次弹窗，而那份 xlsx 就在手边。
//
// 🔴 **表里填中文，库里存英文码。** 城乡和办园性质是任务定向筛的字段
// （见 pickKgProfile 上面那段），让人在 Excel 里填 `city` 是拿我们的
// 数据库口味去要求使用者。填了但认不出来的那一格**必须报错**，不能静默丢掉 ——
// 静默丢掉的下场是这个园收不到任何定向任务，而这件事只在园所页看得出来。

const KG_TEMPLATE_COLUMNS = [
  '园所名称', '省份', '城市', '城乡', '办园性质',
  '在园教师数', '在园幼儿数', '联系人', '联系电话', '起始合作日期', '备注',
];
/**
 * 列头 → 字段。**按列头认，不按列位认。**
 *
 * 理由：模板下发之后是在 Excel 里被人编辑的 —— 挪列、删掉不想填的列、
 * 在前面插一列序号，都很正常。按位置认的话这些操作全都变成静默错位
 * （「广东」被当成园所名字导进去）。
 *
 * 一个字段配几个别名，因为园长自己那份表的列头不会正好跟我们一样。
 */
const KG_HEADER_ALIASES = {
  园所名称: 'name', 园所: 'name', 幼儿园: 'name', 幼儿园名称: 'name', 名称: 'name', 园名: 'name',
  省份: 'province', 省: 'province',
  城市: 'city', 市: 'city', 地市: 'city',
  城乡: 'area_type', 城乡性质: 'area_type', 城乡类型: 'area_type', 地区类型: 'area_type',
  办园性质: 'ownership', 性质: 'ownership', 办园类型: 'ownership',
  在园教师数: 'teacher_count', 在园教师人数: 'teacher_count', 教师人数: 'teacher_count', 教师数: 'teacher_count',
  在园幼儿数: 'child_count', 在园幼儿人数: 'child_count', 幼儿人数: 'child_count', 幼儿数: 'child_count',
  联系人: 'contact_name', 园长: 'contact_name', 负责人: 'contact_name',
  联系电话: 'contact_phone', 电话: 'contact_phone', 手机号: 'contact_phone', 联系方式: 'contact_phone',
  起始合作日期: 'cooperation_started_at', 起始合作: 'cooperation_started_at',
  合作起始日期: 'cooperation_started_at', 合作开始日期: 'cooperation_started_at',
  合作日期: 'cooperation_started_at', 起始日期: 'cooperation_started_at',
  备注: 'note', 说明: 'note',
};
/** 中文 → 库里的码。也收英文码本身，方便把导出的数据再导回来 */
const AREA_CN_TO_CODE = {
  城市: 'city', 城区: 'city', 市区: 'city',
  县镇: 'county', 县城: 'county', 乡镇: 'county', 镇: 'county',
  农村: 'rural', 乡村: 'rural', 村: 'rural',
  city: 'city', county: 'county', rural: 'rural',
};
const OWNER_CN_TO_CODE = {
  公办: 'public', 公立: 'public', 公: 'public',
  民办: 'private', 私立: 'private', 民: 'private',
  public: 'public', private: 'private',
};

/** 列头去掉空格、括号里的补充说明和末尾的星号 */
const normHeader = (s) => String(s || '').replace(/[\s　]/g, '').replace(/[（(].*?[)）]/g, '').replace(/\*$/, '');

/**
 * 把一张表解析成园所行。响应形状跟名单导入对齐（rows + summary），
 * 好让前端那个预览区两处共用。
 */
/**
 * 模板的列序。**粘贴文本没有列头时按这个顺序认。**
 *
 * 为什么园所可以按列序认、而名单不行：名单那几列（姓名/班级/岗位/年级）
 * 的**内容**认得出来（「主班」只可能是岗位），所以 parseRoster 按内容认、
 * 顺序随便。园所这边「广东」「广州」「李园长」都是自由文本，
 * 按内容分不开 —— 只能靠位置或列头。
 */
const KG_COL_ORDER = ['name', 'province', 'city', 'area_type', 'ownership',
  'teacher_count', 'child_count', 'contact_name', 'contact_phone',
  'cooperation_started_at', 'note'];

/**
 * 这一行看起来是列头吗？
 *
 * 🔴 **判据必须包含「有一格是园所名称那一列的列头」**（2026-08-22 修）。
 *
 * 原来只要求「至少两格能在别名表里查到」—— 而一行**完全正常的数据**
 * 就能凑到两格：城乡那格填「城市」（同时也是 city 那一列的列头别名），
 * 备注那格填「备注」（note 的列头）。于是
 *
 *     核实用园_A, 广东, 广州, 城市, 公办, 10, 60, 陈园长, , 2026-09-01, 备注
 *
 * 整行被当成列头吃掉，接着因为找不到 name 列直接报
 * 「认不出园所名称这一列」—— 而人只是粘了一行普通数据。
 * 用户报的「解析粘贴结果预览的功能没做」就是这个。
 *
 * ⚠️ **光加「必须有一格是 name 列头」不够**，那样会把另一个 bug 换回来：
 * `['省份','城市'] / ['广东','广州']` 这种**缺了园所名称列的表头**
 * 会被判成数据行，于是按列序认 → 建出两个叫「省份」和「广东」的园，
 * 不报错。回归里本来就有一条盯着这个（它救了我一次）。
 *
 * 所以判据是两条，命中任一条就算表头：
 *   ① 有一格明确是「园所名称」那一列的列头 —— 那是铁证
 *   ② **大部分格子都是列头名**（≥60%）—— 一行真数据最多凑出两三格
 *      （城乡填「城市」、备注填「备注」），凑不到大多数
 *
 * 于是：真表头（含缺了 name 列的残表头）走 ①或②，报得出「认不出园所名称」；
 * 一行普通数据两条都不中，按列序正常解析。
 */
function looksLikeKgHeader(cells) {
  const nonEmpty = cells.filter((c) => String(c ?? '').trim()).length;
  const keys = cells.map((c) => KG_HEADER_ALIASES[normHeader(c)]).filter(Boolean);
  if (!nonEmpty || keys.length < 2) return false;
  if (keys.includes('name')) return true;
  return keys.length >= Math.ceil(nonEmpty * 0.6);
}

function parseKgSheet(rows, existingNames) {
  const first = rows[0] || [];
  const hasHeader = looksLikeKgHeader(first);
  const idx = {};
  if (hasHeader) {
    first.forEach((h, i) => {
      const key = KG_HEADER_ALIASES[normHeader(h)];
      if (key && idx[key] === undefined) idx[key] = i;
    });
  } else {
    // 没有列头 —— 按模板列序认。粘贴一行「阳光幼儿园, 广东, 广州, 城市, 公办」
    // 就是「单个新增」，这也是「新增」和「批量导入」能合成一个入口的原因
    KG_COL_ORDER.forEach((k, i) => { idx[k] = i; });
  }
  if (idx.name === undefined) {
    throw badRequest('认不出「园所名称」这一列。用「下载模板」拿到的那个文件填，或者把第一行改成列头');
  }

  const out = [];
  const seen = new Set();     // 这一批自己内部的重复
  // 有列头才从第 2 行开始；没有列头（粘贴的裸数据）第 1 行就是数据
  for (let r = hasHeader ? 1 : 0; r < rows.length; r += 1) {
    const cells = rows[r] || [];
    const at = (key) => (idx[key] === undefined ? '' : String(cells[idx[key]] ?? '').trim());
    // Excel 里的行号：人看到的就是这个数，报错要能对上
    const line = r + 1;
    if (cells.every((c) => !String(c ?? '').trim())) continue;   // 空行跳过，不报错

    const name = at('name');
    if (!name) { out.push({ line, ok: false, reason: '这一行没有园所名称', raw: cells.join(' ') }); continue; }

    // 枚举认不出来就整行拒绝。**不要静默留空** —— 见上面那段
    const areaRaw = at('area_type');
    const ownRaw = at('ownership');
    const area_type = areaRaw ? AREA_CN_TO_CODE[areaRaw] : null;
    const ownership = ownRaw ? OWNER_CN_TO_CODE[ownRaw] : null;
    if (areaRaw && !area_type) {
      out.push({ line, ok: false, name, reason: `城乡填的是「${areaRaw}」，只认 城市 / 县镇 / 农村` }); continue;
    }
    if (ownRaw && !ownership) {
      out.push({ line, ok: false, name, reason: `办园性质填的是「${ownRaw}」，只认 公办 / 民办` }); continue;
    }

    // 日期跟上面两个枚举同一条纪律：**认不出来整行拒绝，不静默留空**。
    // 「9/1」「去年九月」这种写法解析不了，而静默留空的下场是
    // 这个园的起始合作日期永远是空的，导入的人却以为自己填了
    const coopRaw = at('cooperation_started_at');
    const cooperation_started_at = coopRaw ? toDateOnly(coopRaw) : null;
    if (coopRaw && cooperation_started_at === undefined) {
      out.push({ line, ok: false, name, reason: `起始合作日期填的是「${coopRaw}」，写成 2026-09-01 这样` }); continue;
    }

    const int = (v) => {
      const n = Number(String(v).replace(/[,，\s人个名]/g, ''));
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    };

    const row = {
      line, name,
      province: at('province').slice(0, 16) || null,
      city: at('city').slice(0, 32) || null,
      area_type, ownership,
      teacher_count: at('teacher_count') ? int(at('teacher_count')) : null,
      child_count: at('child_count') ? int(at('child_count')) : null,
      contact_name: at('contact_name').slice(0, 32) || null,
      contact_phone: at('contact_phone').slice(0, 20) || null,
      cooperation_started_at,
      note: at('note').slice(0, 200) || null,
      ok: true, reason: null,
    };

    // 重名**跳过不覆盖**：覆盖会悄悄改掉一个在用的园，
    // 而园所是老师身份的一部分（名单挂在它上面）
    if (existingNames.has(name)) { row.ok = false; row.reason = '库里已经有这个园了（跳过，不覆盖）'; row.duplicate = true; }
    else if (seen.has(name)) { row.ok = false; row.reason = '这份文件里重复了'; row.duplicate = true; }
    else seen.add(name);

    out.push(row);
  }
  return out;
}

const kgSummary = (rows) => ({
  total: rows.length,
  ok: rows.filter((r) => r.ok).length,
  duplicate: rows.filter((r) => r.duplicate).length,
  invalid: rows.filter((r) => !r.ok && !r.duplicate).length,
});

/**
 * 模板。**带两行示例数据，不给空模板。**
 *
 * 一份只有列头的空表，人填出来的「城乡」会是「城区」「县」「乡下」这种 ——
 * 给两行样例等于把可选值说清楚，而且不用在界面上写一段说明小字
 * （CLAUDE.md：界面上不要写解释性小字）。
 */
kindergartensRouter.get('/kindergartens/template', asyncRoute(async (req, res) => {
  const buf = await buildTemplate({
    sheetName: '园所',
    columns: KG_TEMPLATE_COLUMNS,
    // 🔴 示例的**园所名字必须是一眼假的**。
    // 第一版用了「阳光幼儿园」「童心幼儿园」—— 那俩正是库里真实存在的园，
    // 于是原样导回来两行全被判成「已经有了」。这次是撞对了，但它靠的是巧合：
    // 换个环境那两行就会真建出两个园，而名字看起来完全正常，没人会发现。
    // 需要举例的本来只有「城乡」「办园性质」这两列，园所名字不需要教。
    samples: [
      ['示例幼儿园一', '广东', '广州', '城市', '公办', 42, 310, '李园长', '', '2026-09-01', '这两行是示例，填之前删掉'],
      ['示例幼儿园二', '广东', '佛山', '县镇', '民办', 28, 180, '', '', '', '这两行是示例，填之前删掉'],
    ],
    widths: [22, 10, 10, 10, 12, 12, 12, 12, 16, 16, 24],
  });
  return sendXlsx(res, buf, '园所导入模板.xlsx');
}));

/**
 * 导入园所 —— **上传 xlsx 或粘贴文本，一个接口两条路**（2026-08-22）。
 *
 * 「新增园所」和「批量导入」合成了一个入口（用户定，照名单那套做）。
 * 粘一行就是单个新增，所以不再需要单独的新增表单。
 *
 * 🔴 **两条路共用 `parseKgSheet`**，跟名单导入同一条纪律：
 * 文本在这里先切成二维数组再走同一个解析器。写两份的表现是
 * 「上传能导进去、粘同一份数据少认出三个园」，而且不报错。
 *
 * 分隔符认**制表符和逗号（含全角）**：从 Excel 复制过来是制表符，
 * 从微信或文档里复制过来是各种逗号。
 */
kindergartensRouter.post('/kindergartens/import', asyncRoute(async (req, res) => {
  const b = req.body || {};
  let sheet;
  let sheetCount = 1;
  if (b.file_base64 !== undefined) {
    const parsed = await sheetToRows(b.file_base64);
    sheet = parsed.rows;
    sheetCount = parsed.sheetCount;
  } else {
    const text = String(b.text || '');
    if (!text.trim()) throw badRequest('粘一份园所清单进来，或者上传填好的模板');
    // 一行一个园，格子按制表符 / 逗号切。**不 filter 掉空格子** ——
    // 「阳光幼儿园,,,城市」里那两个空格子是位置信息，滤掉就整行错位了
    sheet = text.split(/\r?\n/).map((line) => line.split(/[\t,，]/).map((c) => c.trim()));
  }
  const existing = new Set((await query(`SELECT name FROM kindergartens`)).rows.map((r) => r.name));
  const rows = parseKgSheet(sheet, existing);
  const summary = kgSummary(rows);
  const dryRun = b.dry_run !== false;

  if (dryRun) return ok(res, { rows, summary, imported: 0, dry_run: true, sheet_count: sheetCount });
  if (!summary.ok) throw badRequest('一个园都没认出来，检查一下表格');

  const good = rows.filter((r) => r.ok);
  // 整批一个事务：半截导入之后没人知道该从哪一行接着来
  const created = await withTransaction(async (client) => {
    const out = [];
    for (const r of good) {
      const row = (await client.query(
        `INSERT INTO kindergartens (name, note, ${KG_PROFILE_COLS.join(', ')})
         VALUES ($1,$2,${KG_PROFILE_PLACEHOLDERS}) RETURNING id, name`,
        [r.name, r.note, ...KG_PROFILE_COLS.map((c) => r[c] ?? null)]
      )).rows[0];
      out.push(row);
    }
    return out;
  });

  await logAction({ adminId: req.adminId, action: 'import_kindergartens',
    target: `kgs:${created.length}`, detail: { imported: created.length, skipped: summary.total - created.length } });
  return ok(res, { rows, summary, imported: created.length, created, dry_run: false });
}));
