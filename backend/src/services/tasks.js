/**
 * 发任务：告诉老师现在有什么活动可以换额度（012 迁移，operations.md 第 6.5 节）
 *
 * 额度只走兑换码之后缺了一环：**她怎么知道现在有个问卷填了能拿 20 次教案**。
 * 以前只能在微信群里喊一声，谁看到谁没看到我这边一无所知。
 *
 * 任务**不自动发额度**。它只说三件事：做什么（问卷链接）、给多少、什么时候截止。
 * 她填完，我在问卷星那边核对，然后建码发给她。
 * **系统不去猜「她是不是真填了」** —— 答卷在问卷星，我们库里没有。
 *
 * ═══════════════════════════════════════════════════════════
 * 【这个文件存在的唯一理由：匹配逻辑只写一次】
 *
 * 管理端的「试算覆盖人数」和老师端的「我能看到哪些任务」用的是**同一个谓词**。
 * 写两份迟早分叉，而分叉的表现是
 * **「后台说发给 12 个人，实际只有 8 个人看到」** —— 而且不会有任何报错。
 * 所以下面那个 buildMatchSql 是唯一的真相来源，两边都调它。
 * ═══════════════════════════════════════════════════════════
 */
import { query, queryOne } from '../db/pool.js';

export const TASK_STATUS = { DRAFT: 'draft', OPEN: 'open', CLOSED: 'closed' };

/** 定向的六个维度。空数组 = 这一维不限 */
export const TARGET_DIMS = [
  'provinces', 'cities', 'area_types', 'ownerships', 'kindergarten_ids', 'age_groups',
];

const AREA_TYPES = ['city', 'county', 'rural'];
const OWNERSHIPS = ['public', 'private'];
const AGE_GROUPS = ['小班', '中班', '大班'];

/**
 * 把请求体里的 target 洗成规范形状。
 *
 * 不认识的键一律丢掉，不认识的值一律丢掉 —— 一个拼错的维度名
 * 会**静默地让定向变宽**（那一维变成空数组 = 不限），
 * 而「本来只想发给农村园，结果发给了所有人」是不会报错的那种错。
 */
export function normalizeTarget(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const strs = (v, max = 32) => [...new Set(arr(v)
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .map((x) => x.slice(0, max)))];
  const inSet = (v, allowed) => strs(v).filter((x) => allowed.includes(x));
  const ints = (v) => [...new Set(arr(v).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

  return {
    provinces: strs(t.provinces, 16),
    cities: strs(t.cities, 32),
    area_types: inSet(t.area_types, AREA_TYPES),
    ownerships: inSet(t.ownerships, OWNERSHIPS),
    kindergarten_ids: ints(t.kindergarten_ids),
    age_groups: inSet(t.age_groups, AGE_GROUPS),
  };
}

/** 这个定向有没有限制任何东西。全空 = 发给所有已激活的老师 */
export function isUnrestricted(target) {
  return TARGET_DIMS.every((d) => !(target?.[d]?.length));
}

/**
 * 构造「哪些老师命中这个定向」的 SQL 片段。
 *
 * @param {object} target 已经 normalizeTarget 过的
 * @param {Array}  params 正在拼的参数数组，会被 push
 * @returns {string} 一段 WHERE 片段，引用别名 `t`（teachers）和 `k`（kindergartens）
 *
 * 规则只有两条：
 *   · **空数组 = 这一维不限**
 *   · **非空维度之间是 AND**（都要命中）
 *
 * 【没有园所的老师】
 * 前四个维度（省/市/城乡/办园性质）和 kindergarten_ids 都要靠 k 那张表。
 * 匿名进来、没填园所的老师 `kindergarten_id` 是 NULL，LEFT JOIN 出来 k 全是 NULL，
 * 于是**任何一个园所相关的维度只要非空，她就命中不了** —— 这是对的，
 * 但必须写在文档里：否则她永远收不到定向任务，而我们不会知道。
 * 「发给所有人」（六维全空）她还是收得到。
 */
export function buildMatchSql(target, params) {
  const where = [
    // 只发给**已激活且没注销**的老师。名单里躺着但还没进来的人收不到任务 ——
    // 她连小程序都没打开过，任务给她也看不见
    `t.activated_at IS NOT NULL`,
    `t.status = 'active'`,
  ];
  const push = (val) => { params.push(val); return `$${params.length}`; };

  if (target.provinces?.length) where.push(`k.province = ANY(${push(target.provinces)}::text[])`);
  if (target.cities?.length) where.push(`k.city = ANY(${push(target.cities)}::text[])`);
  if (target.area_types?.length) where.push(`k.area_type = ANY(${push(target.area_types)}::text[])`);
  if (target.ownerships?.length) where.push(`k.ownership = ANY(${push(target.ownerships)}::text[])`);
  if (target.kindergarten_ids?.length) {
    where.push(`t.kindergarten_id = ANY(${push(target.kindergarten_ids)}::bigint[])`);
  }
  if (target.age_groups?.length) where.push(`t.age_group = ANY(${push(target.age_groups)}::text[])`);

  return where.join(' AND ');
}

/**
 * 试算：这个定向会发给几位老师，都是谁。
 *
 * **发布前必须能试算**。定向条件叠到六层之后，不试算没法确认筛对了 ——
 * 而发错是发给真人的。
 *
 * 顺带回几个样本（姓氏 + 园所 + 班级），因为「12 位」这个数字本身
 * 不足以让人相信筛对了；看到「王老师 @ 阳光幼儿园 小一班」才踏实。
 */
export async function previewTarget(target) {
  const t = normalizeTarget(target);
  const params = [];
  const clause = buildMatchSql(t, params);

  const [cnt, sample] = await Promise.all([
    queryOne(`
      SELECT COUNT(*)::int AS n FROM teachers t
        LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
       WHERE ${clause}`, params),
    query(`
      SELECT t.real_name, t.class_name, t.position, k.name AS kindergarten
        FROM teachers t LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
       WHERE ${clause}
       ORDER BY t.last_login_at DESC NULLS LAST LIMIT 8`, params),
  ]);

  return {
    teachers: cnt.n,
    unrestricted: isUnrestricted(t),
    target: t,
    // 只给姓氏 —— 试算是「筛对了吗」，不需要全名
    sample: sample.rows.map((r) => ({
      surname: r.real_name ? `${String(r.real_name).slice(0, 1)}老师` : '（未填姓名）',
      kindergarten: r.kindergarten,
      class_name: r.class_name,
      position: r.position,
    })),
  };
}

/**
 * 一个任务的详情与群体特征（2026-08-21 新增）。
 *
 * 用户要的是「每个任务到底有多少人收到、群体的基本特征是什么」——
 * 因为发起时勾了一堆定向条件（城乡 / 办园性质 / 年龄班 / 省市 / 具体园所），
 * 列表里那一列写不清，而勾对了没有只能靠**实际覆盖到的人**回答。
 *
 * 🔴 **谓词复用 `buildMatchSql`，一个字都不另写。**
 * 试算（previewTarget）、老师端列表（listTasksFor）、这里的详情，三处同一个函数。
 * 写两份的表现是「后台说发给 12 个人，实际只有 8 个人看到」，而且不报错 ——
 * CLAUDE.md 里那条就是为这件事写的。
 *
 * 分布只按**机构属性**分组（园所 / 城乡 / 办园性质 / 老师带的年龄班）。
 * 这几项都是园所或岗位的特征，不是关于某个孩子的信息。
 */
export async function taskAudience(task) {
  const t = normalizeTarget(task.target);
  const params = [];
  const clause = buildMatchSql(t, params);
  // 已读是按 (task_id, teacher_id) 记的，所以要把任务 id 也带进去
  const readParam = params.length + 1;

  const [rows, byArea, byOwner, byAge, byKg] = await Promise.all([
    query(`
      SELECT t.id, t.real_name, t.class_name, t.position, t.age_group,
             k.name AS kindergarten, k.area_type, k.ownership,
             tr.read_at
        FROM teachers t
        LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
        LEFT JOIN task_reads tr ON tr.teacher_id = t.id AND tr.task_id = $${readParam}
       WHERE ${clause}
       ORDER BY tr.read_at DESC NULLS LAST, t.last_login_at DESC NULLS LAST
       LIMIT 200`, [...params, task.id]),
    // 分组用同一个 clause —— 换一套条件就等于换了一批人，那些百分比会跟总数对不上
    query(`SELECT COALESCE(k.area_type,'（未填）') AS v, COUNT(*)::int AS n
             FROM teachers t LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
            WHERE ${clause} GROUP BY 1 ORDER BY n DESC`, params),
    query(`SELECT COALESCE(k.ownership,'（未填）') AS v, COUNT(*)::int AS n
             FROM teachers t LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
            WHERE ${clause} GROUP BY 1 ORDER BY n DESC`, params),
    query(`SELECT COALESCE(t.age_group,'（未填）') AS v, COUNT(*)::int AS n
             FROM teachers t LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
            WHERE ${clause} GROUP BY 1 ORDER BY n DESC`, params),
    query(`SELECT COALESCE(k.name,'（未指定园所）') AS v, COUNT(*)::int AS n
             FROM teachers t LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
            WHERE ${clause} GROUP BY 1 ORDER BY n DESC`, params),
  ]);

  const covered = rows.rows;
  return {
    covers: covered.length,
    reads: covered.filter((r) => r.read_at).length,
    unrestricted: isUnrestricted(t),
    // 一行一位老师。姓名怎么打码由路由层决定（它才知道调用者是谁）
    teachers: covered.map((r) => ({
      id: r.id,
      real_name: r.real_name,
      kindergarten: r.kindergarten,
      class_name: r.class_name,
      position: r.position,
      age_group: r.age_group,
      area_type: r.area_type,
      ownership: r.ownership,
      read_at: r.read_at,
    })),
    breakdown: {
      area_type: byArea.rows,
      ownership: byOwner.rows,
      age_group: byAge.rows,
      kindergarten: byKg.rows,
    },
  };
}

/**
 * 某位老师能看到哪些任务。
 *
 * 跟 previewTarget 共用 buildMatchSql —— 但方向是反的：
 * 那边是「给定 target 找老师」，这边是「给定老师找 tasks」。
 * 所以这里对每个 open 任务跑一次谓词判断。
 *
 * 任务数量是个位数（我一个人发的），逐个判断完全无所谓；
 * 换成一条大 SQL 反而要把 JSONB 拆开比，那才是会写错的地方。
 */
export async function listTasksFor(teacherId) {
  const me = await queryOne(`
    SELECT t.id, t.age_group, t.kindergarten_id,
           k.province, k.city, k.area_type, k.ownership
      FROM teachers t LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
     WHERE t.id = $1`, [teacherId]);
  if (!me) return { items: [], unread: 0 };

  const rows = (await query(`
    SELECT s.*, (r.teacher_id IS NOT NULL) AS read
      FROM tasks s
      LEFT JOIN task_reads r ON r.task_id = s.id AND r.teacher_id = $1
     WHERE s.status = 'open'
       -- 过期的不出现。截止日期那一天本身还算在内（<=），
       -- 写成 < 会让「今天截止」的任务今天就消失
       AND (s.deadline IS NULL OR s.deadline >= current_date)
     ORDER BY s.created_at DESC`, [teacherId])).rows;

  const hit = (target) => {
    const t = normalizeTarget(target);
    if (t.provinces.length && !t.provinces.includes(me.province)) return false;
    if (t.cities.length && !t.cities.includes(me.city)) return false;
    if (t.area_types.length && !t.area_types.includes(me.area_type)) return false;
    if (t.ownerships.length && !t.ownerships.includes(me.ownership)) return false;
    if (t.kindergarten_ids.length && !t.kindergarten_ids.includes(Number(me.kindergarten_id))) return false;
    if (t.age_groups.length && !t.age_groups.includes(me.age_group)) return false;
    return true;
  };

  const items = rows.filter((s) => hit(s.target)).map((s) => ({
    id: s.id,
    title: s.title,
    body: s.body,
    survey_url: s.survey_url,
    reward_text: s.reward_text,
    reward_image: s.reward_image,
    deadline: s.deadline,
    // 剩几天。她判断「今天还来不来得及」靠这个，不是靠一个日期
    days_left: s.deadline
      ? Math.max(0, Math.round((new Date(s.deadline) - new Date(new Date().toDateString())) / 86400000))
      : null,
    unread: !s.read,
  }));

  return { items, unread: items.filter((x) => x.unread).length };
}

export async function markRead(taskId, teacherId) {
  // 没有记录就是未读，所以标已读是插一行。复合主键天然防重复
  await query(
    `INSERT INTO task_reads (task_id, teacher_id) VALUES ($1, $2)
     ON CONFLICT (task_id, teacher_id) DO NOTHING`,
    [taskId, teacherId]
  );
}
