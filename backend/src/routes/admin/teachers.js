import { Router } from 'express';
import { query, queryOne } from '../../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../../utils/errors.js';
import { generateCode } from '../../utils/code.js';
import { getQuota, grantQuota } from '../../services/quota.js';
import { logAction } from '../../services/admins.js';
import { logger } from '../../utils/logger.js';
import { requireSuper, maskName } from './_shared.js';

export const teachersRouter = Router();

// ---------------------------------------------------------------
// 老师 —— **名单和已激活账号合成一张表**（2026-08-21 用户定）
//
// 原来是两页：「名单」列岗位（还没人来认领的），「老师」列已激活的账号。
// 用户的判断是那两页重复了：「所谓的名单，要么是园所名单（已经存在），
// 要么是教师名单（应该归属到教师页面）」。于是「名单」这个顶级页撤掉，
// 这一个接口同时回答「我们知道哪些人」和「她们激活了没有」。
//
// 🔴 **主体是 `teacher_roster`（岗位），不是 `teachers`（账号）。**
// 一行 = 一个岗位（人 × 园 × 班 × 岗位），激活了的那些多带一个账号和额度。
// 三层身份别混（CLAUDE.md 有一条红标）：
//   · `teacher_ref` = **人**，她换班也不变，研究追人按它归组
//   · `roster_id`   = **位置**（class_teacher_id）
//   · `id`          = **账号**（teachers.id），没激活时是 null
//
// ⚠️ **UNION 那半截不是可选的。** 早于名单体系的账号 `roster_entry_id` 是空的
// （本机那个「试用」就是，21 份教案都在它名下）。只查名单的话它会从这一页
// **静默消失** —— 而「一个有 21 份教案的账号不在老师列表里」是没人会想到去查的。
//
// 默认只给「在岗」（pending + claimed）：`moved` 是她换班之后留下的历史行，
// 跟当前那一行是同一个人，都列出来的话同一个人会出现两次。
// ---------------------------------------------------------------

/**
 * 额度、教案数、配图数按账号汇总。合并查询里 UNION 两边都要用，所以抽成 CTE 文本。
 *
 * 🔴 **这个 CTE 必须严格一个账号一行。** 原来的老查询在这里
 * `LEFT JOIN redemption_codes rc ON rc.used_by = t.id` —— 而一位老师
 * **可以兑好几个码**（`POST /auth/redeem` 支持续兑，那是额度的唯一入口）。
 * 于是兑过两个码的老师在列表里出现**两次**，额度数字还都是对的，
 * 看起来就像数据重复而不是查询写错。
 *
 * 2026-08-21 把名单和账号合并成一张表时才暴露出来（合并之后行数变多，
 * 重复一眼就看见了）。所以码改成两处分开取：
 *   · 显示用**最近兑的那一个**（标量子查询，恒定一行）
 *   · 搜索用 EXISTS 遍历她的**全部**码 —— 只按最近那个搜的话，
 *     拿一个旧码去后台搜会搜不到人，而那正是对账时最常做的事
 */
const TEACHER_USAGE_CTE = `
  usage AS (
    SELECT t.id AS teacher_id,
           COALESCE(g.text,0)::int  AS granted_text,
           COALESCE(g.image,0)::int AS granted_image,
           -- 那个 3 是 quota.js 的 FREE_VERSION_CEILING（初稿 + 2 次免费改稿）。
           -- 园所列表和这里都硬写着同一个数，改免费次数时两处一起改
           COALESCE(p.n,0)::int + COALESCE(p.extra,0)::int AS used_text,
           COALESCE(i.n,0)::int AS used_image,
           (SELECT rc.code FROM redemption_codes rc
             WHERE rc.used_by = t.id
             ORDER BY rc.used_at DESC NULLS LAST, rc.id DESC LIMIT 1) AS redeem_code
      FROM teachers t
      LEFT JOIN (SELECT teacher_id, SUM(delta_text) text, SUM(delta_image) image
                   FROM quota_grants GROUP BY teacher_id) g ON g.teacher_id = t.id
      LEFT JOIN (SELECT teacher_id, COUNT(*) n, SUM(GREATEST(0, version - 3)) extra
                   FROM lesson_plans GROUP BY teacher_id) p ON p.teacher_id = t.id
      LEFT JOIN (SELECT p2.teacher_id, COUNT(*) n
                   FROM lesson_images i2 JOIN lesson_plans p2 ON p2.id = i2.lesson_plan_id
                  WHERE i2.status = 'ready' GROUP BY p2.teacher_id) i ON i.teacher_id = t.id
  )`;

teachersRouter.get(
  '/teachers',
  asyncRoute(async (req, res) => {
    const kg = req.query.kindergarten_id ? Number(req.query.kindergarten_id) : null;
    const q = String(req.query.q || '').trim();
    // 'current'（默认）= 在岗；别的值就是 roster.status 本身；'all' = 全都要
    const status = String(req.query.status || 'current');

    const params = [];
    const rosterWhere = [];
    const acctWhere = ['t.roster_entry_id IS NULL', "t.status <> 'deleted'", 't.activated_at IS NOT NULL'];

    if (status === 'current') {
      rosterWhere.push(`r.status IN ('pending','claimed')`);
    } else if (['pending', 'claimed', 'moved', 'void'].includes(status)) {
      params.push(status);
      rosterWhere.push(`r.status = $${params.length}`);
      // 按 roster 状态筛时，没有名单行的账号一律不出现 —— 它没有那个状态。
      // 「已激活」是个例外：那个账号确实是激活的
      if (status !== 'claimed') acctWhere.push('false');
    }
    if (kg) {
      params.push(kg);
      rosterWhere.push(`r.kindergarten_id = $${params.length}`);
      acctWhere.push(`t.kindergarten_id = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const like = `$${params.length}`;
      params.push(`%${q.toUpperCase().replace(/[\s_-]/g, '')}%`);
      const codeLike = `$${params.length}`;
      // 姓名、班级、**兑换码**、**teacher_ref** 都能搜。
      // 库里没有手机号了（016 迁移删的），所以对账的锚点是
      // 「她兑的是哪个码」（对上问卷星那边的记录）和 teacher_ref（对上我的名单）。
      //
      // 码走 EXISTS 遍历她的**全部**码，不是只比 u.redeem_code（那只是最近一个）——
      // 拿一个旧码去搜会搜不到人，而对账时手里那个码往往正是旧的
      const codeExists = (idCol) => `EXISTS (SELECT 1 FROM redemption_codes rc2
        WHERE rc2.used_by = ${idCol}
          AND REPLACE(REPLACE(rc2.code, '-', ''), ' ', '') LIKE ${codeLike})`;
      rosterWhere.push(`(
        r.real_name LIKE ${like} OR r.class_name LIKE ${like} OR r.teacher_ref::text LIKE ${like}
        OR ${codeExists('r.claimed_by')}
      )`);
      acctWhere.push(`(
        t.real_name LIKE ${like} OR t.class_name LIKE ${like}
        OR ${codeExists('t.id')}
      )`);
    }

    // UNION 外面**必须套一层**才能按表达式排序：
    // 直接在 UNION 上写 `ORDER BY teacher_id IS NULL` 会被 Postgres 拒
    // （invalid UNION/INTERSECT/EXCEPT ORDER BY clause）——
    // UNION 的 ORDER BY 只认第一个 SELECT 的输出列名或列号，不认表达式
    const rows = (await query(`
      WITH ${TEACHER_USAGE_CTE}
      SELECT * FROM (
      SELECT r.id AS roster_id, r.teacher_ref, r.real_name, r.status AS roster_status,
             r.kindergarten_id, kg.name AS kindergarten,
             r.class_name, r.position, r.age_group, r.claimed_at,
             t.id AS teacher_id, t.status AS account_status, t.last_login_at,
             u.granted_text, u.used_text, u.granted_image, u.used_image, u.redeem_code
        FROM teacher_roster r
        LEFT JOIN kindergartens kg ON kg.id = r.kindergarten_id
        -- 用 roster_entry_id 反向连，不用 claimed_by：她换班之后账号指向的是**新**那一行，
        -- 而 claimed_by 在旧那一行上也还留着 —— 按 claimed_by 连，一个人会在
        -- 「换班了」那一行上也显示成已激活
        LEFT JOIN teachers t ON t.roster_entry_id = r.id AND t.status <> 'deleted'
        LEFT JOIN usage u ON u.teacher_id = t.id
       WHERE ${rosterWhere.length ? rosterWhere.join(' AND ') : 'true'}

      UNION ALL

      -- 没有名单行的已激活账号。见上面那段 ⚠️ —— 少了这半截它们会静默消失
      SELECT NULL, NULL, t.real_name, NULL,
             t.kindergarten_id, kg.name,
             t.class_name, t.position, t.age_group, t.activated_at,
             t.id, t.status, t.last_login_at,
             u.granted_text, u.used_text, u.granted_image, u.used_image, u.redeem_code
        FROM teachers t
        LEFT JOIN kindergartens kg ON kg.id = t.kindergarten_id
        LEFT JOIN usage u ON u.teacher_id = t.id
       WHERE ${acctWhere.join(' AND ')}
      ) x
      -- 已激活的排前面（那是要动手的那些），同组里按最近登录
      ORDER BY x.teacher_id IS NULL, x.last_login_at DESC NULLS LAST, x.roster_id DESC`, params)).rows;

    const counts = Object.fromEntries(
      (await query(`SELECT status, COUNT(*)::int AS n FROM teacher_roster GROUP BY status`))
        .rows.map((c) => [c.status, c.n])
    );

    return ok(res, {
      items: rows.map((r) => {
        const gt = r.granted_text || 0;
        const ut = r.used_text || 0;
        const gi = r.granted_image || 0;
        const ui = r.used_image || 0;
        return {
          // `id` 仍然是**账号 id**（没激活时是 null）：老师详情按它打开，
          // 回归脚本也按它走。别改成 roster_id
          id: r.teacher_id,
          roster_id: r.roster_id,
          teacher_ref: r.teacher_ref,
          // 姓名对一般管理员只给姓氏
          real_name: maskName(r.real_name, req.isSuper),
          name_masked: !req.isSuper,
          redeem_code: r.redeem_code,
          kindergarten: r.kindergarten,
          kindergarten_id: r.kindergarten_id,
          class_name: r.class_name,
          position: r.position,
          age_group: r.age_group,
          // **激活与否只有一个判据：有没有账号。** 不要再去看 roster_status ——
          // 那等于把同一件事记在两个地方
          activated: r.teacher_id != null,
          roster_status: r.roster_status,
          status: r.account_status,
          claimed_at: r.claimed_at,
          quota: {
            text: { granted: gt, used: ut, left: gt - ut },
            image: { granted: gi, used: ui, left: gi - ui },
          },
          last_login_at: r.last_login_at,
        };
      }),
      counts,
    });
  })
);

/**
 * 老师详情。这一页要回答四件事，缺哪一件都得跳出去查：
 *   1. **她是谁** —— 三层：`teacher_ref`（人，换班也不变）、
 *      `roster_entry_id`（位置 = 人 × 园 × 班 × 岗位）、她兑的那个码。
 *      **库里没有手机号**（016 迁移删的），要联系她去问卷星那边看答卷
 *   2. **额度用到哪了** —— 台账。**不再有发放表单**（2026-08-18）：
 *      额度只走兑换码一条路，我建码发给她，她自己兑
 *   3. **她用得怎么样** —— 写完几份、每份出到第几版、画了几张、花了多少钱
 *   4. **她说了什么** —— 评价与建议，附带那份教案的标题
 *
 * 教案那张表**只列写完的**（2026-08-18 用户提）：答题中的草稿不是「她写过的教案」，
 * 是她被叫走留下的半截。库里那些 draft 一行都不动 —— 断点续写依赖它们，
 * 只是这个视图不显示，另外给一个「还在答题中的有几个」的计数。
 */
teachersRouter.get(
  '/teachers/:id',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    // 🔴 **姓名、班级、岗位一律「名单优先、账号兜底」**，跟老师列表和兑换码列表
    // 用的是同一套顺序。身份来自名单（CLAUDE.md），账号那几列是激活时抄过去的副本 ——
    // 而副本会过期：`POST /roster/:id/reassign` 换班时新开一行名单、
    // 把 `roster_entry_id` 指过去，**但不回写 `teachers.real_name`**。
    //
    // 不统一的下场 2026-08-21 撞到了：列表显示「甲小美」，点进详情是 null，
    // 而两处都不报错。查了一轮才定位到「同一个人的姓名有两个来源」。
    //
    // rc.code 用标量子查询而不是 JOIN：一位老师可以兑好几个码（续兑），
    // JOIN 会让 queryOne 从多行里任取一行（见 TEACHER_USAGE_CTE 上面那段）
    const t = await queryOne(
      `SELECT t.*,
              COALESCE(r.real_name,  t.real_name)  AS real_name,
              COALESCE(r.class_name, t.class_name) AS class_name,
              COALESCE(r.position,   t.position)   AS position,
              COALESCE(r.age_group,  t.age_group)  AS age_group,
              k.name AS kindergarten, k.city AS city, r.teacher_ref,
              (SELECT rc.code FROM redemption_codes rc
                WHERE rc.used_by = t.id
                ORDER BY rc.used_at DESC NULLS LAST, rc.id DESC LIMIT 1) AS redeem_code
         FROM teachers t
         LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
         LEFT JOIN teacher_roster r ON r.id = t.roster_entry_id
        WHERE t.id = $1`, [id]);
    if (!t) throw notFound('没有这位老师');

    const PLAN_LIMIT = 50;
    const [quota, grants, plans, drafts, fb, img, purposes, pendingRebind] = await Promise.all([
      getQuota(id),
      query(`SELECT delta_text, delta_image, reason, created_at FROM quota_grants
              WHERE teacher_id = $1 ORDER BY created_at DESC`, [id]),
      // 每份教案连它的全部版本一起取：一次查询，用 json_agg 把版本卷进去 ——
      // 分两次查再在 JS 里拼，会变成「N+1 次查询」，而这一页本来就慢
      query(`SELECT c.id AS conversation_id, c.title, c.age_group, c.created_at,
                    p.id AS plan_id, p.version, p.current_version,
                    COALESCE((
                      SELECT json_agg(json_build_object(
                               'version', v.version,
                               'revise_note', v.revise_note,
                               'created_at', v.created_at) ORDER BY v.version)
                        FROM lesson_plan_versions v WHERE v.lesson_plan_id = p.id
                    ), '[]'::json) AS versions
               FROM conversations c JOIN lesson_plans p ON p.conversation_id = c.id
              WHERE c.teacher_id = $1 AND c.deleted_at IS NULL
                AND c.status = 'completed'
              ORDER BY c.created_at DESC LIMIT ${PLAN_LIMIT + 1}`, [id]),
      // 答题中的只给个数。她开了 12 个草稿只写完 2 份，这本身是个信号
      // （题目太长？被打断太多？），但列出 12 行半截的东西没有用
      queryOne(`SELECT COUNT(*)::int AS n FROM conversations
                 WHERE teacher_id = $1 AND deleted_at IS NULL AND status <> 'completed'`, [id]),
      // 反馈带上那份教案的标题：光看「用不了」不知道是哪一份，得去翻教案表对 id
      query(`SELECT f.id, f.kind, f.category, f.rating, f.text,
                    f.lesson_plan_id, f.plan_version, f.handled, f.created_at,
                    p.title AS plan_title
               FROM feedback f LEFT JOIN lesson_plans p ON p.id = f.lesson_plan_id
              WHERE f.teacher_id = $1 ORDER BY f.created_at DESC`, [id]),
      // 配图统计。配图是成本的主要变量（CLAUDE.md 说上线后要盯采用率），
      // 而「这位老师画了几张」只在这一页看得到
      queryOne(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE i.status = 'ready')::int  AS ready,
               COUNT(*) FILTER (WHERE i.status = 'failed')::int AS failed,
               COALESCE(SUM(i.cost_cents) FILTER (WHERE i.status = 'ready'), 0)::int AS cost_cents
          FROM lesson_images i JOIN lesson_plans p ON p.id = i.lesson_plan_id
         WHERE p.teacher_id = $1`, [id]),
      query(`
        SELECT i.purpose, COUNT(*)::int AS n
          FROM lesson_images i JOIN lesson_plans p ON p.id = i.lesson_plan_id
         WHERE p.teacher_id = $1 AND i.status = 'ready'
         GROUP BY i.purpose ORDER BY n DESC`, [id]),
      // 有没有一把还没用的换绑钥匙在外面。界面要显示它而不是又生成一把
      queryOne(`
        SELECT id, code, expires_at FROM account_rebinds
         WHERE teacher_id = $1 AND status = 'pending' AND expires_at > now()
         ORDER BY id DESC LIMIT 1`, [id]),
    ]);

    const truncated = plans.rows.length > PLAN_LIMIT;
    const planRows = plans.rows.slice(0, PLAN_LIMIT);

    return ok(res, {
      teacher: {
        id: t.id,
        // 三层身份：人 / 位置 / 账号（016 迁移，operations.md 第 1 节）
        teacher_ref: t.teacher_ref,
        roster_entry_id: t.roster_entry_id,
        // 姓名全名只给超管。一般管理员做运营用不着 ——
        // 少一个人能看到，对老师的那句承诺就多一分是真的。
        // **手机号根本不存**（016 迁移删了那一列）
        real_name: maskName(t.real_name, req.isSuper),
        name_masked: !req.isSuper,
        // 码不是身份信息（它不指向某个自然人），一般管理员也能看 ——
        // 否则她们连「这是谁」都答不上来，运营就做不了
        redeem_code: t.redeem_code,
        kindergarten: t.kindergarten,
        // 城市取的是**园所的**城市，不是老师的 —— 库里没有老师的住址，
        // 也不该有。它回答的是「这个人在哪个城市工作」
        city: t.city,
        class_name: t.class_name,
        position: t.position,
        age_group: t.age_group,
        // 学历 / 教龄（018 迁移）：老师自己在小程序档案里填的，是研究要用的自变量。
        // 🔴 **NULL 是「没填过」，别在任何地方显示成「未评定」或 0** ——
        // 「未评定」是职称那一栏她主动选的一个值，两者在研究上分得开。
        // teaching_years: 0 同理，那是「今年刚入职」，不是空
        education: t.education,
        professional_title: t.professional_title,
        teaching_years: t.teaching_years,
        status: t.status,
        activated_at: t.activated_at,
        agreed_at: t.agreed_at,
        last_login_at: t.last_login_at,
      },
      quota,
      grants: grants.rows,
      // 一般管理员只看到「写完几份、什么时候写的、出到第几版」，看不到标题和内容。
      // 是**删掉字段**而不是置空：前端靠 title === undefined 判断该显示
      // 「超管可见」，置空会变成一个看不出原因的空格。
      // **plan_id 和 versions 必须一起拿掉** —— 给了 plan_id 她就能自己去敲 /plans/:id
      plans: req.isSuper ? planRows : planRows.map((p) => ({
        conversation_id: p.conversation_id, age_group: p.age_group,
        created_at: p.created_at, version: p.version, current_version: p.current_version,
      })),
      // 界面必须说出「只显示了最近 50 份」，否则那个数字会被当成总数
      plans_truncated: truncated,
      drafts: drafts.n,
      feedback: req.isSuper ? fb.rows : fb.rows.map(({ plan_title, ...f }) => f),
      // 数量和成本是用量，不是老师写的内容，所以不锁超管
      images: { ...img, by_purpose: purposes.rows },
      // 只给超管：换绑码能接管一整个账号
      pending_rebind: req.isSuper ? pendingRebind || null : undefined,
      can_view_content: req.isSuper,
    });
  })
);

/** 发额度。这是最常用的操作：老师完成新任务 → 加一笔 */
teachersRouter.post(
  '/teachers/:id/grant',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const t = await queryOne(`SELECT id FROM teachers WHERE id = $1`, [id]);
    if (!t) throw notFound('没有这位老师');

    const dt = Number(req.body?.delta_text) || 0;
    const di = Number(req.body?.delta_image) || 0;
    const reason = String(req.body?.reason || '').trim();
    if (!dt && !di) throw badRequest('至少填一项额度');
    if (!reason) throw badRequest('写一下原因 —— 这是对账和研究记录的依据');

    await grantQuota({ teacherId: id, deltaText: dt, deltaImage: di, reason });
    // 多个人能改额度之后，「这 20 次是谁发的」必须能查
    await logAction({ adminId: req.adminId, action: 'grant_quota', target: `teacher:${id}`,
      detail: { delta_text: dt, delta_image: di, reason } });
    return ok(res, { quota: await getQuota(id) });
  })
);

/**
 * 「她换微信了」—— 生成一个换绑码（**超管专属**）。
 *
 * 为什么锁超管：这把钥匙能把一整个账号（教案、额度、记忆）交给另一个微信，
 * 比发额度敏感得多。
 *
 * 生成之前**必须线下核实这个人真是她**。不收手机号验证，所以只能问她
 * 只有她知道的东西：**她兑的是哪个码**（后台记着）或**她最近写的教案标题**。
 * 这一步没有技术保障，全靠人认真问 —— 见 operations.md 第 1.7 节。
 */
teachersRouter.post('/teachers/:id/rebind-code', requireSuper, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const t = await queryOne(`SELECT id, status FROM teachers WHERE id = $1`, [id]);
  if (!t) throw notFound('没有这位老师');
  if (t.status === 'deleted') throw badRequest('这个账号已经注销了，没法换绑');

  // **已经有没用的就返回那一个**，不重复生成 ——
  // 否则外面同时有两把能接管她账号的钥匙，而我不知道另一把在谁手上
  const exist = await queryOne(
    `SELECT * FROM account_rebinds
      WHERE teacher_id = $1 AND status = 'pending' AND expires_at > now()
      ORDER BY id DESC LIMIT 1`, [id]);
  if (exist) {
    return ok(res, { code: exist.code, expires_at: exist.expires_at, reused: true });
  }

  let code = generateCode();
  for (let retry = 0; retry < 5; retry += 1) {
    const dup = await queryOne(
      `SELECT 1 FROM account_rebinds WHERE code = $1
        UNION ALL SELECT 1 FROM redemption_codes WHERE code = $1`, [code]);
    if (!dup) break;
    code = generateCode();
  }

  const row = await queryOne(
    // 7 天：我生成之后要在微信上告诉她，她不一定当场就换。
    // 但也不能无限期 —— 这把钥匙能接管一整个账号
    `INSERT INTO account_rebinds (code, teacher_id, expires_at, created_by)
     VALUES ($1, $2, now() + interval '7 days', $3) RETURNING *`,
    [code, id, req.adminId]);

  await logAction({ adminId: req.adminId, action: 'create_rebind_code', target: `teacher:${id}` });
  logger.warn('rebind_code_created', { by: req.adminId, teacher_id: id });
  return ok(res, { code: row.code, expires_at: row.expires_at, reused: false });
}));

teachersRouter.post('/rebind-codes/:id/void', requireSuper, asyncRoute(async (req, res) => {
  const row = await queryOne(
    `UPDATE account_rebinds SET status = 'void'
      WHERE id = $1 AND status = 'pending' RETURNING id, teacher_id`, [Number(req.params.id)]);
  if (!row) throw badRequest('只有还没用过的换绑码可以作废');
  await logAction({ adminId: req.adminId, action: 'void_rebind_code',
    target: `teacher:${row.teacher_id}` });
  return ok(res, { voided: true });
}));

teachersRouter.post(
  '/teachers/:id/status',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body?.status || '');
    if (!['active', 'disabled'].includes(status)) throw badRequest('状态不对');
    const t = await queryOne(
      `UPDATE teachers SET status = $1, updated_at = now() WHERE id = $2 RETURNING id, status`,
      [status, id]);
    if (!t) throw notFound('没有这位老师');
    logger.info('admin_teacher_status', { teacher_id: id, status });
    await logAction({ adminId: req.adminId, action: 'teacher_status', target: `teacher:${id}`, detail: { status } });
    return ok(res, t);
  })
);
