/**
 * 管理后台 API —— operations.md 第 6 节
 *
 * 与小程序**完全隔离**：不同的登录方式、不同的 token、不同的中间件。
 * 老师的 JWT 打不开这里，管理员的 token 也调不了业务接口。
 *
 * 【两级权限，和对老师的承诺直接相关】
 * 老师同意的协议里写着「你的幼儿园和园长看不到这里的任何东西」。
 * 同事不是园方，这句承诺依然成立；但最敏感的两项锁在超级管理员手里：
 *   · **手机号全号** —— 一般管理员只看打码
 *   · **对话正文与教案内容** —— 一般管理员完全看不到
 * 同事做运营（发额度、建兑换码、看反馈）不需要读老师写了什么。
 * 少一个人能读，那句承诺就多一分是真的。
 *
 * 仍然**没有**「园所管理员」这种角色。要是哪天加了园长只读账号，
 * 那句承诺就作废了，必须先跟老师们重新讲清楚。
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { ok, asyncRoute, badRequest, notFound, AppError, ErrorCode } from '../utils/errors.js';
import { generateCode } from '../utils/code.js';
import { getQuota, grantQuota } from '../services/quota.js';
import {
  ROLES, findAdmin, verifyPassword, touchLogin, createAdmin,
  setPassword, listAdmins, logAction,
} from '../services/admins.js';
import { listModels, generateWith, FORMATS, isKnownFormat } from '../services/imageModels.js';
import { uploadImage, buildImageUrl } from '../services/imageStore.js';
import { getSetting, setSetting, SETTING_KEYS } from '../services/appSettings.js';
import { getMoney } from '../services/costLedger.js';
import { parseRoster, annotateExisting, summarize, surnameOf } from '../services/roster.js';
import { previewTarget, normalizeTarget, taskAudience } from '../services/tasks.js';
import { buildTemplate, sheetToRows, rowsToText } from '../services/xlsx.js';
import { logger } from '../utils/logger.js';

export const adminRouter = Router();

const TOKEN_TTL = 12 * 3600; // 12 小时，一个工作日

/**
 * 姓名按权限出：超管给全名，一般管理员只给姓氏（`王**`）。
 *
 * 🔴 **没填姓名的人回 null，不回 `'**'`。**
 * 原来四处各写一遍 `` `${surnameOf(x)}**` ``，而 `surnameOf(null)` 是空字符串，
 * 拼出来就是字面的 `'**'` —— 屏幕上那是句假话：看着像「有名字，只是我看不到」，
 * 实际是**从来没填过**。名单里不填姓名是允许的（只有姓氏是必需的那条规则更晚才有），
 * 所以这不是脏数据。
 *
 * 这个坑不只在界面上：`'**'` 是**真值**，于是任何
 * `items.filter(t => t.real_name)` 都会把无名的人算进「有姓名的人」——
 * roles-test 就是这么挑到一个无名账号再去断言「超管看得到全名」，
 * 然后红在一句看不懂的 `超管看到全名：null` 上。2026-08-21 查了一轮才找到。
 */
function maskName(name, isSuper) {
  const s = String(name ?? '').trim();
  if (!s) return null;
  return isSuper ? s : `${surnameOf(s)}**`;
}

/**
 * 回一个 xlsx 附件。
 *
 * 文件名走 `filename*=UTF-8''…`：中文文件名用普通的 `filename=` 传，
 * 浏览器拿到的是一串乱码（HTTP 头只认 latin-1）。两个都给 ——
 * `filename=` 那个留给不认 RFC 5987 的旧客户端。
 */
function sendXlsx(res, buf, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="template.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return res.send(buf);
}

/**
 * 139****1234 —— 保留前 3 后 4，够认人又不至于满屏号码。
 *
 * **现在只有园长的联系电话用它**。老师的手机号 016 迁移已经从库里删掉了 ——
 * 她的号只在问卷星那边，要联系她去那边看答卷。
 */
function maskPhone(p) {
  if (!p) return null;
  const s = String(p);
  return s.length < 8 ? '***' : `${s.slice(0, 3)}****${s.slice(-4)}`;
}

// ---------------------------------------------------------------
// 登录
// ---------------------------------------------------------------
adminRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    const admin = await findAdmin(username);
    // 用户名不存在时也跑一次哈希比较，让响应时间跟「密码错」一致 ——
    // 否则可以靠计时枚举出哪些用户名存在
    const okPwd = admin
      ? await verifyPassword(password, admin.password_hash, admin.salt)
      : await verifyPassword(password, crypto.randomBytes(64).toString('hex'), 'x');

    if (!admin || !okPwd) {
      logger.warn('admin_login_failed', { username, ip: req.ip });
      throw new AppError(ErrorCode.UNAUTHORIZED, { message: '用户名或密码不对' });
    }

    await touchLogin(admin.id);
    const token = jwt.sign(
      { role: 'admin', aid: admin.id, arole: admin.role },
      config.jwt.secret, { expiresIn: TOKEN_TTL }
    );
    logger.info('admin_login', { admin_id: admin.id, role: admin.role });
    return ok(res, {
      token, expires_in: TOKEN_TTL,
      admin: { id: admin.id, username: admin.username, role: admin.role, display_name: admin.display_name },
    });
  })
);

/** 管理员守卫。老师的 token 里没有 role=admin，进不来。 */
export function requireAdmin(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) return next(new AppError(ErrorCode.UNAUTHORIZED, { message: '请先登录' }));
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    if (payload.role !== 'admin') {
      return next(new AppError(ErrorCode.UNAUTHORIZED, { message: '这个账号没有后台权限' }));
    }
    req.adminId = payload.aid;
    req.adminRole = payload.arole || ROLES.ADMIN;
    req.isSuper = req.adminRole === ROLES.SUPER;
    next();
  } catch {
    next(new AppError(ErrorCode.UNAUTHORIZED, { message: '登录过期了，重新登录一下' }));
  }
}

/** 只有超管能过。用在账号管理、看手机号全号、看对话正文这几处。 */
function requireSuper(req, res, next) {
  if (!req.isSuper) {
    return next(new AppError(ErrorCode.UNAUTHORIZED, {
      message: '这一项只有超级管理员能看',
      detail: { need: 'super' },
    }));
  }
  next();
}

// ---------------------------------------------------------------
// 概览
// ---------------------------------------------------------------
/**
 * 概览。2026-08-18 按用户的要求重做了一遍。
 *
 * 删掉的：**「最近写的」**（用户原话「没有实际意义」）、以及「今天写了几份 /
 * 今天几张配图 / 累计多少老师」这类只会一直变大的累计数 ——
 * 它们看一眼就没用了，不告诉你今天该做什么。
 *
 * 现在这一屏只回答四句话：
 *   1. **我的钱** —— 充了多少、花了多少、还剩多少（配图 + 文本分开列）
 *   2. **谁在用** —— 几个园、几位老师，近 7 天各是多少
 *   3. **哪个园用了多少额度** —— 合作是按园谈的，钱也该按园看
 *   4. **等我处理** —— 反馈、失败、快没额度的老师、码不够了
 *
 * 顺手修了一个真 bug：教案评价分布原来查 `kind = 'rating'`，
 * 而库里的真实值是 `'lesson_rating'` —— 所以那一屏**永远显示「还没有人评价过」**，
 * 而实际上早就有数据了。这是这个产品最大未知数的唯一数据源，
 * 一个 typo 让它静静地消失，看起来还完全正常。
 */
adminRouter.get(
  '/overview',
  asyncRoute(async (req, res) => {
    const [money, usage, quality, lowQuota, todo] = await Promise.all([
      getMoney(),
      // 「几位老师 / 近 7 天来过几位」这两个数**必须同一个口径**，
      // 否则会出现「33 位老师，近 7 天来过 41 位」这种读不通的话。
      // 原来活跃那个 count 没排掉未激活和已注销的账号（联调脚本造了一堆），
      // 于是分子比分母大 —— 这类错不会报警，只会让人不再相信这一屏
      queryOne(`
        SELECT
          (SELECT COUNT(*) FROM kindergartens)::int AS kindergartens,
          (SELECT COUNT(DISTINCT t.kindergarten_id) FROM teachers t
            WHERE t.kindergarten_id IS NOT NULL
              AND t.activated_at IS NOT NULL AND t.status <> 'deleted'
              AND t.last_login_at > now() - interval '7 days')::int AS kindergartens_active_7d,
          (SELECT COUNT(*) FROM teachers
            WHERE activated_at IS NOT NULL AND status <> 'deleted')::int AS teachers,
          (SELECT COUNT(*) FROM teachers
            WHERE activated_at IS NOT NULL AND status <> 'deleted'
              AND last_login_at > now() - interval '7 days')::int AS teachers_active_7d
      `),
      // 教案评价分布 —— 「AI 写的教案是否真的适龄可用」是这个产品最大的未知数，
      // 这一行是它唯一的持续数据源，必须摆在概览上。
      // **kind 是 'lesson_rating' 不是 'rating'**（原来写错了，这一屏一直是空的）
      query(`SELECT rating, COUNT(*)::int n FROM feedback
              WHERE kind = 'lesson_rating' AND rating IS NOT NULL GROUP BY rating`),
      // 快没额度的老师：她下一次点「写教案」就会撞墙，而那时才发现就晚了
      query(`
        SELECT t.id, t.real_name, k.name AS kindergarten,
               COALESCE(g.text,0)::int - COALESCE(p.n,0)::int AS text_left
          FROM teachers t
          LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
          LEFT JOIN (SELECT teacher_id, SUM(delta_text) text FROM quota_grants GROUP BY teacher_id) g ON g.teacher_id = t.id
          LEFT JOIN (SELECT teacher_id, COUNT(*) n FROM lesson_plans GROUP BY teacher_id) p ON p.teacher_id = t.id
         WHERE t.activated_at IS NOT NULL AND t.status = 'active'
           AND COALESCE(g.text,0) - COALESCE(p.n,0) <= 2
         ORDER BY text_left ASC LIMIT 8`),
      queryOne(`
        SELECT
          (SELECT COUNT(*) FROM feedback WHERE handled = false)::int AS feedback_new,
          (SELECT COUNT(*) FROM conversations
            WHERE status = 'failed' AND updated_at > now() - interval '7 days')::int AS gen_failed_7d,
          (SELECT COUNT(*) FROM lesson_images
            WHERE status = 'failed' AND created_at > now() - interval '7 days')::int AS images_failed_7d,
          (SELECT COUNT(*) FROM redemption_codes WHERE status = 'unused')::int AS codes_unused
      `),
      // 「按园所消耗」那张表 **2026-08-22 撤掉了**（用户定）。
      // 不是嫌它没用，是它跟园所页那张表回答同一个问题、而且列还更少 ——
      // 花费这一列已经挪进园所列表（那里还有地区、性质、起始合作，
      // 判断「这个园值不值得续」要的是那一整行，不是孤零零一个花费数）。
      // 一件事写在两处，迟早两处算法分叉，而分叉的表现是两页数字对不上。
    ]);

    const byRating = Object.fromEntries(quality.rows.map((r) => [r.rating, r.n]));
    return ok(res, {
      money,
      usage,
      todo: {
        ...todo,
        low_quota: lowQuota.rows.map((r) => ({
          id: r.id,
          // 姓名也算身份信息，一般管理员只看得到姓氏
          name: req.isSuper ? r.real_name : `${String(r.real_name || '').slice(0, 1)}老师`,
          kindergarten: r.kindergarten,
          text_left: r.text_left,
        })),
      },
      quality: {
        usable: byRating.usable || 0,
        needs_edit: byRating.needs_edit || 0,
        unusable: byRating.unusable || 0,
      },
    });
  })
);

// ---------------------------------------------------------------
// 充值台账 —— **2026-08-21 整个撤掉了**（用户定）
//
// 原来这里有 `GET /topups` 和 `POST /topups`，概览上有一张「账面还剩」的卡，
// 「要处理」里还有一条「账面只剩 X，该充值了」。
//
// 撤掉的理由不是嫌它麻烦，是那个余额**永远不准而且看起来很准**：
// 充值靠手录（漏录一笔余额就虚高），而真实余额分散在 DeepSeek、12ai、
// MiniMax 各自的后台里 —— 那三个数才是能拿去对账的。
// 支出侧不一样，它是每次调用当场落库的事实，所以留着（见 costLedger.js 文件头）。
//
// `platform_topups` 那张表和库里已有的 3 笔记录**没有删**，只是没有入口了。
// 要恢复的话这两个路由在 git 历史里，`costLedger.js` 的 listTopups / addTopup
// 也是一起删的。**别只恢复一半。**
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// 名单 —— 激活的第二把钥匙（013 迁移，operations.md 第 1 节）
//
// 码证明「你是这批人里的」（问卷星发），手机号证明「你是哪一个」（跟这张名单核对）。
// 两把钥匙**相互独立**：码不绑在名单某一行上，否则问卷星发的随机码
// 就对不上她的号，「答卷后自动发码」当场断掉。
//
// 🔴 真实手机号进库的前提：伦理审查 + 协议里单独写清楚。开发用假号。
// ---------------------------------------------------------------
adminRouter.get('/roster', asyncRoute(async (req, res) => {
  const status = String(req.query.status || 'all');
  const where = [];
  const params = [];
  if (['pending', 'claimed', 'void'].includes(status)) {
    params.push(status); where.push(`r.status = $${params.length}`);
  }
  if (req.query.kindergarten_id) {
    params.push(Number(req.query.kindergarten_id)); where.push(`r.kindergarten_id = $${params.length}`);
  }
  const q = String(req.query.q || '').trim();
  if (q) {
    params.push(`%${q}%`);
    where.push(`(r.real_name LIKE $${params.length} OR r.class_name LIKE $${params.length}
                 OR r.teacher_ref::text LIKE $${params.length})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, counts] = await Promise.all([
    query(`
      SELECT r.*, k.name AS kindergarten
        FROM teacher_roster r LEFT JOIN kindergartens k ON k.id = r.kindergarten_id
      ${clause}
       ORDER BY r.created_at DESC, r.id DESC LIMIT 500`, params),
    query(`SELECT status, COUNT(*)::int AS n FROM teacher_roster GROUP BY status`),
  ]);

  return ok(res, {
    items: rows.rows.map((r) => ({
      id: r.id,
      // 手机号跟老师详情同一条纪律：一般管理员只看打码
      // teacher_ref = **人**（换班也不变，研究追人按它归组）
      // id 本身 = **位置**（class_teacher_id）：人 × 园 × 班 × 岗位
      teacher_ref: r.teacher_ref,
      // 姓名对一般管理员只给姓氏 —— 跟老师那边同一条纪律
      real_name: maskName(r.real_name, req.isSuper),
      name_masked: !req.isSuper,
      kindergarten: r.kindergarten,
      kindergarten_id: r.kindergarten_id,
      class_name: r.class_name,
      position: r.position,
      age_group: r.age_group,
      note_public: r.note_public,
      status: r.status,
      claimed_teacher_id: r.claimed_by,
      claimed_at: r.claimed_at,
      // 「谁顶了谁的名额」只给超管：它是一个能指向具体微信账号的标识
      claimed_openid: req.isSuper ? r.claimed_openid : undefined,
      note: r.note,
      created_at: r.created_at,
    })),
    counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])),
  });
}));

/**
 * 粘贴一段文本 **或** 上传一个 xlsx 导入名单。
 *
 * **`dry_run` 先预览再写**（前端默认先干跑一次）。不给预览就是让人闭眼提交
 * 一份从微信里复制来的名单 —— 里面必然有全角逗号、多余空格、少一列的行、
 * 甚至连表头一起复制进来。
 *
 * 🔴 **两条入口共用同一个解析器**（2026-08-21 加 xlsx 时定的）。
 * xlsx 在这里就地被拼成「单元格用制表符连、行用换行连」的文本，
 * 然后走跟粘贴完全一样的那条路 —— 而制表符正是从 Excel 复制粘贴时的分隔符，
 * 所以 parseRoster 本来就认，一行都不用改。
 *
 * 为什么不为 xlsx 单写一份：那套「按内容认而不按列位认」的规则
 * （姓名/班级/岗位/年级顺序随便、全角逗号也认）是踩出来的。写成两份迟早分叉，
 * 而分叉的表现是「粘贴能导进去、上传同一份数据少认出三个人」，**不报错**。
 */
adminRouter.post('/roster/import', asyncRoute(async (req, res) => {
  const b = req.body || {};
  let text = String(b.text || '');
  // 按**键在不在**判，不按真假判：`file_base64: ''` 是「她选了文件、但读出来是空的」，
  // 走到下面那句「粘一段名单进来」会把她往完全错的方向引 ——
  // 她明明选了文件，界面却让她去粘文本。空内容的那句话在 sheetToRows 里
  if (b.file_base64 !== undefined) {
    const { rows: sheet } = await sheetToRows(b.file_base64);
    text = rowsToText(sheet);
  }
  if (!text.trim()) throw badRequest('粘一段名单进来，一行一个人');

  const kgId = b.kindergarten_id ? Number(b.kindergarten_id) : null;
  const rows = await annotateExisting(parseRoster(text), kgId);
  const summary = summarize(rows);
  const dryRun = b.dry_run !== false;

  if (dryRun) return ok(res, { rows, summary, imported: 0, dry_run: true });
  if (!summary.ok) throw badRequest('一行都没解析出来，检查一下格式');

  // 整批一个事务：要么全写进去，要么一行都不写 ——
  // 半截导入之后没人知道该从哪一行接着来
  const good = rows.filter((r) => r.ok);
  const created = await withTransaction(async (client) => {
    const out = [];
    for (const r of good) {
      // teacher_ref 每行分配一个新的：这一行代表一个**人**第一次进名单。
      // 她以后换班，是新开一行、沿用同一个 ref（走 /roster/:id/reassign）
      const row = (await client.query(
        `INSERT INTO teacher_roster
           (teacher_ref, real_name, kindergarten_id, class_name, position, age_group, note, created_by)
         VALUES (nextval('teacher_ref_seq'),$1,$2,$3,$4,$5,$6,$7)
         RETURNING id, teacher_ref`,
        [r.real_name, kgId, r.class_name, r.position, r.age_group,
          String(b.note || '').trim().slice(0, 128) || null, req.adminId]
      )).rows[0];
      out.push(row);
    }
    return out;
  });

  await logAction({ adminId: req.adminId, action: 'import_roster', target: `roster:${good.length}`,
    detail: { imported: good.length, skipped: summary.total - good.length, kindergarten_id: kgId } });
  // 日志里**不放姓名**（三条铁律之一），只记数量
  logger.info('roster_imported', { by: req.adminId, imported: good.length });
  return ok(res, { rows, summary, imported: good.length, created, dry_run: false });
}));

/**
 * 名单模板。**带两行示例，不给空模板。**
 *
 * 一份只有列头的空表，人填出来的「岗位」会是「班主任」「带班老师」这种 ——
 * parseRoster 只认 POSITIONS 里那几个词，认不出来就落到姓名那一列去了。
 * 给两行样例等于把可选值说清楚，而且不用在界面上写一段说明小字。
 *
 * 列顺序无所谓（parseRoster 按内容认不按列位认），但模板还是按
 * 「姓名在最前」排 —— 姓名那一列要是排在班级后面，
 * 「小一班」会被当成姓名，而 parseRoster 只能提醒、猜不出来。
 */
adminRouter.get('/roster/template', asyncRoute(async (req, res) => {
  const buf = await buildTemplate({
    sheetName: '名单',
    columns: ['姓名', '班级', '岗位', '年级'],
    samples: [
      ['王小美', '小一班', '主班', '小班'],
      ['李红', '中二班', '配班', '中班'],
    ],
    widths: [14, 14, 12, 10],
  });
  return sendXlsx(res, buf, '老师名单模板.xlsx');
}));

/**
 * 她换班了。
 *
 * **新开一行、沿用同一个 `teacher_ref`**，旧那一行标 `moved` 留着不删 ——
 * 那是历史，研究要用它区分「她在小一班那半年」和「她在中二班这半年」。
 * 她账号的 `roster_entry_id` 指到新那一行。**她自己什么都不用做。**
 *
 * 这是「追踪对象可能是人、也可能是班」那个需求的落点：
 * 追人按 `teacher_ref` 归组，追班按（园所 + 班级）归组，两种都算得出来。
 */
adminRouter.post('/roster/:id/reassign', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};

  const out = await withTransaction(async (client) => {
    const old = (await client.query(
      `SELECT * FROM teacher_roster WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!old) return { err: '名单上没有这一条' };
    if (old.status === 'void') return { err: '这一条已经作废了' };
    if (old.status === 'moved') return { err: '这一条已经是旧记录了，去她当前那一条上操作' };

    const className = b.class_name === undefined ? old.class_name : String(b.class_name).trim() || null;
    const ageGroup = b.age_group === undefined ? old.age_group : String(b.age_group).trim() || null;
    const position = b.position === undefined ? old.position : String(b.position).trim() || null;
    const kgId = b.kindergarten_id === undefined ? old.kindergarten_id : (Number(b.kindergarten_id) || null);

    if (className === old.class_name && position === old.position && kgId === old.kindergarten_id) {
      return { err: '班级、岗位、园所都没变，不用挪' };
    }

    const fresh = (await client.query(
      `INSERT INTO teacher_roster
         (teacher_ref, real_name, kindergarten_id, class_name, position, age_group,
          note_public, note, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [old.teacher_ref, old.real_name, kgId, className, position, ageGroup,
        old.note_public, old.note, req.adminId,
        // 她已经有账号了就直接算 claimed（她不用再认领一次）；
        // 还没激活的话新那一行仍然等她来认领
        old.status === 'claimed' ? 'claimed' : 'pending']
    )).rows[0];

    if (old.status === 'claimed') {
      await client.query(
        `UPDATE teacher_roster SET claimed_by = $1, claimed_openid = $2, claimed_at = $3
          WHERE id = $4`,
        [old.claimed_by, old.claimed_openid, old.claimed_at, fresh.id]);
      // 账号跟着指到新位置，并同步她的班级岗位（前端「我的」页显示的就是这些）
      await client.query(
        `UPDATE teachers
            SET roster_entry_id = $1, class_name = $2, position = $3,
                age_group = COALESCE($4, age_group), kindergarten_id = $5, updated_at = now()
          WHERE id = $6`,
        [fresh.id, className, position, ageGroup, kgId, old.claimed_by]);
    }

    // 旧那一行标 moved —— **不删**，它是历史
    await client.query(`UPDATE teacher_roster SET status = 'moved' WHERE id = $1`, [old.id]);
    return { entry: fresh, moved_from: old.id };
  });

  if (out.err) throw badRequest(out.err);
  await logAction({ adminId: req.adminId, action: 'reassign_roster',
    target: `roster:${out.entry.id}`,
    detail: { teacher_ref: out.entry.teacher_ref, from: out.moved_from } });
  return ok(res, out);
}));

adminRouter.post('/roster/:id/void', asyncRoute(async (req, res) => {
  const row = await queryOne(
    // 已经认领的不许作废：那会让一个正在用的账号失去它的名单依据
    `UPDATE teacher_roster SET status = 'void'
      WHERE id = $1 AND status = 'pending' RETURNING id, status`,
    [Number(req.params.id)]);
  if (!row) throw badRequest('只有还没被认领的才能作废');
  await logAction({ adminId: req.adminId, action: 'void_roster', target: `roster:${row.id}` });
  return ok(res, row);
}));

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

adminRouter.get(
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
adminRouter.get(
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
adminRouter.post(
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
adminRouter.post('/teachers/:id/rebind-code', requireSuper, asyncRoute(async (req, res) => {
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

adminRouter.post('/rebind-codes/:id/void', requireSuper, asyncRoute(async (req, res) => {
  const row = await queryOne(
    `UPDATE account_rebinds SET status = 'void'
      WHERE id = $1 AND status = 'pending' RETURNING id, teacher_id`, [Number(req.params.id)]);
  if (!row) throw badRequest('只有还没用过的换绑码可以作废');
  await logAction({ adminId: req.adminId, action: 'void_rebind_code',
    target: `teacher:${row.teacher_id}` });
  return ok(res, { voided: true });
}));

adminRouter.post(
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

// ---------------------------------------------------------------
// 兑换码
// ---------------------------------------------------------------
adminRouter.get(
  '/codes',
  asyncRoute(async (req, res) => {
    // 🔴 **一行 = 一次建码操作**，不是一行一个码（2026-08-21 用户定，019 迁移）。
    //
    // 原来是一个码一行。而实际动作是「批量建 20 个灌进问卷星」——
    // 那一次操作在列表里摊成 20 行，几批混在一起按时间倒序排，
    // 分不出哪 20 个是刚才那一批的。
    //
    // 「共几张 / 已用几张」一律 COUNT 出来，**不存计数列** ——
    // 跟额度台账、平台账同一条纪律：汇总数是算出来的，
    // 存一列 used_count 就有了两份事实，而老师兑码时没人会记得去 +1。
    //
    // 上一轮加的「谁兑的」那一列在这个模型下没有意义了（一次批量操作对应
    // 很多个兑换者），所以撤掉。要看谁兑了走批次详情或老师页。
    const status = String(req.query.status || 'all');
    // 按状态筛的语义变成「这一批**里还有**这种状态的码」。
    // 比「整批都是这个状态」有用：她筛「未使用」是想找还能发出去的那几批
    const having = status === 'all' ? '' : `
      HAVING COUNT(*) FILTER (WHERE c.status = '${
        status === 'unused' ? 'unused' : status === 'used' ? 'used' : 'void'}') > 0`;

    const rows = (await query(`
      SELECT b.id, b.kind, b.requested, b.init_text, b.init_image,
             b.grant_reason, b.created_at,
             k.name AS kindergarten,
             a.display_name, a.username,
             COUNT(c.id)::int                                            AS total,
             COUNT(c.id) FILTER (WHERE c.status = 'used')::int            AS used,
             COUNT(c.id) FILTER (WHERE c.status = 'unused')::int          AS unused,
             COUNT(c.id) FILTER (WHERE c.status = 'void')::int            AS voided
        FROM code_batches b
        LEFT JOIN kindergartens k ON k.id = b.kindergarten_id
        LEFT JOIN admins a        ON a.id = b.created_by
        LEFT JOIN redemption_codes c ON c.batch_id = b.id
       GROUP BY b.id, k.name, a.display_name, a.username
       ${having}
       ORDER BY b.created_at DESC, b.id DESC LIMIT 200`)).rows;

    return ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        // requested 和 total 都给：不一样就是「有几张没建成」（撞码重试失败），
        // 那本身是要看见的信息，不该被抹平
        requested: r.requested,
        total: r.total,
        used: r.used,
        unused: r.unused,
        voided: r.voided,
        init_text: r.init_text,
        init_image: r.init_image,
        grant_reason: r.grant_reason,
        kindergarten: r.kindergarten,
        created_by_name: r.display_name || r.username || null,
        created_at: r.created_at,
      })),
    });
  })
);

/**
 * 按**单个码**查。
 *
 * `GET /codes` 2026-08-21 改成了「一行一次操作」（019 迁移），
 * 于是「这一个码现在什么状态」没地方问了 —— 而那是个真问题：
 * 老师说「码用不了」，得能查出它是没兑过、已经被别人兑了、还是被作废了。
 *
 * 界面上暂时没有调用方（兑换码页列的是操作），但**别删** ——
 * 回归脚本靠它验「激活失败绝不能消耗那个码」这条红线，
 * 而那条红线的反面（码被悄悄消耗掉）在界面上是看不出来的。
 */
adminRouter.get('/codes/items', asyncRoute(async (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase().replace(/[\s]/g, '');
  const status = String(req.query.status || 'all');
  const params = [];
  const where = [];
  if (code) {
    params.push(`%${code.replace(/-/g, '')}%`);
    where.push(`REPLACE(c.code, '-', '') LIKE $${params.length}`);
  }
  if (['unused', 'used', 'void'].includes(status)) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  const rows = (await query(`
    SELECT c.id, c.code, c.status, c.init_text, c.init_image, c.grant_reason,
           c.batch_id, c.used_at, c.created_at,
           c.used_by AS teacher_id,
           COALESCE(r.real_name, t.real_name) AS teacher_name,
           k.name AS kindergarten
      FROM redemption_codes c
      LEFT JOIN teachers t       ON t.id  = c.used_by
      LEFT JOIN teacher_roster r ON r.id  = t.roster_entry_id
      LEFT JOIN kindergartens k  ON k.id  = c.kindergarten_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY c.created_at DESC, c.id DESC LIMIT 500`, params)).rows;
  return ok(res, {
    items: rows.map((r) => ({
      ...r,
      teacher_name: maskName(r.teacher_name, req.isSuper),
    })),
  });
}));

/**
 * 一批里的码。
 *
 * 用处只有一个（用户原话）：「发放对象没收到时重新抄录」。
 * 所以**只给码，不标哪一张已被使用** —— 她要的是那份原始清单，
 * 标注反而让人以为「已用的那些不用抄了」，而没收到的那个人可能正好拿的是已用的那张。
 */
adminRouter.get('/codes/batches/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const batch = await queryOne(`
    SELECT b.*, k.name AS kindergarten
      FROM code_batches b LEFT JOIN kindergartens k ON k.id = b.kindergarten_id
     WHERE b.id = $1`, [id]);
  if (!batch) throw notFound('没有这一批');
  const codes = (await query(
    `SELECT code FROM redemption_codes WHERE batch_id = $1 ORDER BY id`, [id]
  )).rows.map((r) => r.code);
  return ok(res, {
    batch: {
      id: batch.id, kind: batch.kind, requested: batch.requested,
      init_text: batch.init_text, init_image: batch.init_image,
      grant_reason: batch.grant_reason, kindergarten: batch.kindergarten,
      created_at: batch.created_at,
    },
    codes,
  });
}));

/**
 * 删掉几次操作。
 *
 * 用户定的规则（2026-08-21）：**删操作，已兑的码留在库里**。
 *   · 批次行删掉
 *   · 这批里**未兑**的码跟着删（没发出去过，留着只是噪音）
 *   · **已兑的码留下**，`batch_id` 被外键 ON DELETE SET NULL 清成空 ——
 *     它变成一条无所属的历史记录，老师详情里「她兑的是哪个码」照样查得到。
 *     那是她的额度从哪来的唯一凭据，删了出争议时查不到
 *
 * 代价写在这里：**列表上「共几张」从此跟库里的码数对不上**（少了已兑的那些）。
 * 这是用户明确选的那个取舍，不是 bug。
 *
 * 锁超管：这是不可逆的批量删除。
 */
adminRouter.post('/codes/batches/delete', requireSuper, asyncRoute(async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) throw badRequest('先选几行再删');

  const result = await withTransaction(async (client) => {
    const kept = (await client.query(
      `SELECT COUNT(*)::int AS n FROM redemption_codes
        WHERE batch_id = ANY($1::bigint[]) AND status <> 'unused'`, [ids]
    )).rows[0].n;
    const dropped = (await client.query(
      `DELETE FROM redemption_codes
        WHERE batch_id = ANY($1::bigint[]) AND status = 'unused' RETURNING id`, [ids]
    )).rowCount;
    // 批次一删，剩下那些已兑的码 batch_id 被 SET NULL —— 靠外键，不用手动 UPDATE
    const batches = (await client.query(
      `DELETE FROM code_batches WHERE id = ANY($1::bigint[]) RETURNING id`, [ids]
    )).rowCount;
    return { batches, dropped, kept };
  });

  await logAction({ adminId: req.adminId, action: 'delete_code_batches',
    target: `batches:${result.batches}`, detail: result });
  logger.info('code_batches_deleted', { by: req.adminId, ...result });
  return ok(res, result);
}));

/**
 * 建一个码。
 *
 * **码只是一张入场券**，不带任何身份（016 迁移把那几列删了）。
 * 身份全部来自名单 —— 她激活时从名单里选自己是哪一位。
 *
 * 所以这里只有三个参数：给哪个园（可不填）、初始额度、原因。
 * 原来还能填手机号姓名建「绑定码」，那条路撤掉了：
 * 留着两套激活逻辑，以后改其中一条一定会忘了另一条。
 */
adminRouter.post(
  '/codes',
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const kgId = b.kindergarten_id ? Number(b.kindergarten_id) : null;
    const initText = Number(b.init_text) > 0 ? Number(b.init_text) : 20;
    const initImage = Number(b.init_image) > 0 ? Number(b.init_image) : 10;
    const reason = String(b.grant_reason || '').trim() || '首次激活';
    const batch = await queryOne(
      `INSERT INTO code_batches
         (kind, requested, init_text, init_image, grant_reason, kindergarten_id, created_by)
       VALUES ('single',1,$1,$2,$3,$4,$5) RETURNING id`,
      [initText, initImage, reason, kgId, req.adminId]
    );
    const row = await queryOne(
      `INSERT INTO redemption_codes
         (code, kindergarten_id, init_text, init_image, grant_reason, batch_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        generateCode(),
        kgId,
        initText, initImage, reason,
        // 单张也记一次操作（kind='single'）—— 列表是按操作列的，
        // 不记的话单独建的码在那一页上一条都看不见
        batch.id,
      ]
    );
    await logAction({ adminId: req.adminId, action: 'create_code', target: `code:${row.code}`,
      detail: { init_text: row.init_text, init_image: row.init_image } });
    logger.info('code_created', { by: req.adminId, code_id: row.id });
    return ok(res, { code: row.code, id: row.id, batch_id: batch.id });
  })
);

adminRouter.post(
  '/codes/:id/void',
  asyncRoute(async (req, res) => {
    const row = await queryOne(
      `UPDATE redemption_codes SET status = 'void'
        WHERE id = $1 AND status = 'unused' RETURNING id, code`, [Number(req.params.id)]);
    if (!row) throw badRequest('只有还没被用的码可以作废');
    await logAction({ adminId: req.adminId, action: 'void_code', target: `code:${row.code}` });
    return ok(res, row);
  })
);

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
adminRouter.get('/kindergartens', asyncRoute(async (req, res) => {
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
      -- 文本成本靠 model_calls.teacher_id 归到园上（跟撤掉的那张概览表同一套算法）
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

adminRouter.post('/kindergartens', asyncRoute(async (req, res) => {
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
adminRouter.post('/kindergartens/:id/update', asyncRoute(async (req, res) => {
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
adminRouter.get('/kindergartens/template', asyncRoute(async (req, res) => {
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
adminRouter.post('/kindergartens/import', asyncRoute(async (req, res) => {
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

// ---------------------------------------------------------------
// 内容与反馈
// ---------------------------------------------------------------
/**
 * 把一串消息卷成**问答对**（2026-08-22 用户提）。
 *
 * 原来这一屏是把 messages 原样铺成 JSON：一条 assistant（题目）、
 * 一条 user（答案），各自带完整 payload —— 而 assistant 的 payload 里
 * 装着那道题的**全部推荐选项**（四个 label + sub），
 * 于是一份四题的教案能滚出两百多行，而真正要看的
 * 「问了什么 / 她答了什么」被埋在里面。用户原话：
 * 「呈现了问题但不呈现用户的答案，当前结构太长了」。
 *
 * 现在按 `question_id` 把题和答配成对，选项整个丢掉 ——
 * 选项是当时**给她挑的**，不是她说的；要复盘推荐质量得看别的东西。
 *
 * 🔴 **答不上的题也要留一行（答为 null）**，不能因为没答案就把题丢掉：
 * 「这道题她没答」本身是信号（题目看不懂 / 她被叫走了），
 * 而丢掉之后那一屏看起来就像她全答了。
 */
function buildTranscript(msgs) {
  const guided = [];
  const rounds = new Map();     // round -> { 轮次, 她说, 追问: [] }
  const qIndex = new Map();     // `${round}:${id}` -> 那个问答对象

  const roundOf = (n) => {
    if (!rounds.has(n)) rounds.set(n, { 轮次: n, 她说: null, 追问: [] });
    return rounds.get(n);
  };

  for (const m of msgs) {
    const p = m.payload || {};
    if (m.role === 'assistant') {
      const pair = { 问: m.content || p.title || null, 答: null };
      if (p.kind === 'revise_question') {
        roundOf(p.round).追问.push(pair);
        qIndex.set(`${p.round}:${p.id}`, pair);
      } else {
        guided.push(pair);
        qIndex.set(`0:${p.id}`, pair);
      }
      continue;
    }
    if (m.role !== 'user') continue;
    if (p.kind === 'revise_feedback') { roundOf(p.round).她说 = m.content || null; continue; }
    const key = p.kind === 'revise_answer' ? `${p.round}:${p.question_id}` : `0:${p.question_id}`;
    const pair = qIndex.get(key);
    // 配不上的答案（题被删过、或者历史数据）单独留一行，别静默丢掉
    if (pair) pair.答 = m.content || null;
    else if (p.kind === 'revise_answer') roundOf(p.round).追问.push({ 问: null, 答: m.content || null });
    else guided.push({ 问: null, 答: m.content || null });
  }

  const out = {};
  if (guided.length) out.引导 = guided;
  const rs = [...rounds.values()].sort((a, b) => a.轮次 - b.轮次);
  if (rs.length) out.改稿 = rs;
  return out;
}

/**
 * 教案正文和对话记录 —— **只有超管**。
 * 这是老师写的东西，运营工作（建码、看反馈）根本用不到。
 *
 * `?version=2` 看历史版本（2026-08-18 加）。为什么要按版本看：
 * 老师标「用不了」是标在**某一个版本**上的（feedback 绑 plan_version），
 * 而 lesson_plans 那一行只存当前内容 —— 她改过之后，
 * 当前内容已经不是她当初评价的那一份了。看错版本等于看错了证据。
 */
adminRouter.get('/plans/:id', requireSuper, asyncRoute(async (req, res) => {
  const planId = Number(req.params.id);
  const p = await queryOne(
    `SELECT p.*, t.real_name, k.name AS kindergarten
       FROM lesson_plans p
       JOIN teachers t ON t.id = p.teacher_id
       LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
      WHERE p.id = $1`, [planId]);
  if (!p) throw notFound('没有这份教案');

  const versions = (await query(
    `SELECT version, revise_note, created_at FROM lesson_plan_versions
      WHERE lesson_plan_id = $1 ORDER BY version`, [planId])).rows;

  // 要看哪一版。不传 = 当前内容（lesson_plans 那一行）
  const want = req.query.version ? Number(req.query.version) : null;
  let shown = p;
  let shownVersion = p.current_version ?? p.version;
  if (want) {
    const snap = await queryOne(
      `SELECT * FROM lesson_plan_versions WHERE lesson_plan_id = $1 AND version = $2`,
      [planId, want]);
    if (!snap) throw notFound(`这份教案没有第 ${want} 版`);
    // 用快照覆盖内容字段，但**保留身份字段**（谁写的、哪个园）——
    // 那些不在版本快照里，它们不随版本变
    shown = { ...p, title: snap.title, age_group: snap.age_group,
      duration_min: snap.duration_min, content_md: snap.content_md,
      content_json: snap.content_json, quality_self: snap.quality_self };
    shownVersion = snap.version;
  }

  // 对话记录**给结构化数组**，界面上以 JSON 呈现（2026-08-18 用户定）：
  // 这一屏的用处是拿去做研究分析，一个能整块选中复制的 JSON 比排好的表更有用。
  // system 那条不在库里（每次实时拼装，见 001_init.sql 的注释），所以本来就不会出现
  const msgs = (await query(
    `SELECT role, content, payload, created_at FROM messages
      WHERE conversation_id = $1 ORDER BY id`, [p.conversation_id])).rows;

  return ok(res, {
    plan: shown,
    shown_version: shownVersion,
    versions,
    // 界面用 transcript（问答对）。`messages` **保留原样下发** ——
    // 它是这份对话的原始记录，研究要拿去做分析时不该只剩我卷过的那一份；
    // 而且回归脚本读着它
    transcript: buildTranscript(msgs),
    messages: msgs,
  });
}));

adminRouter.get('/feedback', asyncRoute(async (req, res) => {
  const kind = String(req.query.kind || 'all');
  const where = kind === 'all' ? '' : `WHERE f.kind = '${kind === 'lesson_rating' ? 'lesson_rating' : 'suggestion'}'`;
  const rows = (await query(`
    SELECT f.*, t.real_name, k.name AS kindergarten, p.title AS plan_title, p.age_group
      FROM feedback f
      JOIN teachers t ON t.id = f.teacher_id
      LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
      LEFT JOIN lesson_plans p ON p.id = f.lesson_plan_id
    ${where}
     ORDER BY f.created_at DESC LIMIT 200`)).rows;
  return ok(res, { items: rows });
}));

adminRouter.post('/feedback/:id/handled', asyncRoute(async (req, res) => {
  const row = await queryOne(
    `UPDATE feedback SET handled = $1 WHERE id = $2 RETURNING id, handled`,
    [req.body?.handled !== false, Number(req.params.id)]);
  if (!row) throw notFound('没有这条反馈');
  return ok(res, row);
}));

// ---------------------------------------------------------------
// 任务 —— 告诉老师现在有什么活动可以换额度（012 迁移）
//
// **任务不自动发额度**（用户定的）。它只承诺，到账靠我事后核对答卷、
// 建码发给她，她自己兑。系统不去猜「她是不是真填了」——
// 答卷在问卷星，我们库里没有。
// ---------------------------------------------------------------
adminRouter.get('/tasks', asyncRoute(async (req, res) => {
  const rows = (await query(`
    SELECT s.*, a.display_name AS created_by_name,
           (SELECT COUNT(*)::int FROM task_reads r WHERE r.task_id = s.id) AS reads
      FROM tasks s LEFT JOIN admins a ON a.id = s.created_by
     ORDER BY s.status = 'open' DESC, s.created_at DESC LIMIT 200`)).rows;

  // 🔴 **这一页不再逐个试算覆盖人数**（2026-08-22）。
  // 「覆盖」那一列撤掉了（用户定，列表改成 标题/奖励/城市/办园性质/截止/状态），
  // 而算它是一个任务两条查询的 N+1 —— 20 个任务就是 40 条，
  // 只为了一个已经不显示的数。
  //
  // 试算没有消失，它在真正要它的两个地方：
  //   · 发送前的确认框（`POST /tasks/preview`，必然跑一次）
  //   · 任务详情（`GET /tasks/:id`，那一屏的主题就是「筛出了什么样的一群人」）
  // 这里只把 target 洗成规范形状，好让列表能显示城市和办园性质
  const items = rows.map((s) => ({
    id: s.id, title: s.title, body: s.body, survey_url: s.survey_url,
    reward_text: s.reward_text, reward_image: s.reward_image,
    deadline: s.deadline, status: s.status, target: normalizeTarget(s.target),
    reads: s.reads, created_by_name: s.created_by_name, created_at: s.created_at,
  }));
  return ok(res, { items });
}));

/**
 * 试算覆盖人数。
 *
 * **不是锦上添花**：定向条件叠到六层之后不试算没法确认筛对了，
 * 而发错是发给真人的。跟老师端 `GET /tasks` 共用 `buildMatchSql` ——
 * 写两份迟早分叉，分叉的表现是「后台说发给 12 个人，实际只有 8 个人看到」。
 */
adminRouter.post('/tasks/preview', asyncRoute(async (req, res) =>
  ok(res, await previewTarget(req.body?.target))));

function pickTask(b, cur = {}) {
  const str = (k, max) => (b[k] === undefined
    ? cur[k] ?? null : String(b[k]).trim().slice(0, max) || null);
  const num = (k) => {
    if (b[k] === undefined) return cur[k] ?? 0;
    const n = Number(b[k]);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  const url = str('survey_url', 500);
  // 问卷链接要能点开，所以必须是 http(s)。填了个「见群里」之类的东西
  // 界面上就会变成一个点不动的链接，而她不会知道为什么
  if (url && !/^https?:\/\//i.test(url)) {
    throw badRequest('问卷链接要以 http:// 或 https:// 开头');
  }
  return {
    title: str('title', 64),
    body: b.body === undefined ? cur.body ?? null : String(b.body).trim().slice(0, 2000) || null,
    survey_url: url,
    reward_text: num('reward_text'),
    reward_image: num('reward_image'),
    deadline: b.deadline === undefined ? cur.deadline ?? null : String(b.deadline).trim() || null,
    target: b.target === undefined ? normalizeTarget(cur.target) : normalizeTarget(b.target),
  };
}

adminRouter.post('/tasks', asyncRoute(async (req, res) => {
  const t = pickTask(req.body || {});
  if (!t.title) throw badRequest('给任务起个标题');
  // 建出来是**草稿**，不是直接发布 —— 发布是另一个动作，
  // 中间那一步就是给我机会试算一遍覆盖人数
  const row = await queryOne(
    `INSERT INTO tasks (title, body, survey_url, reward_text, reward_image,
                        deadline, target, created_by, status)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::jsonb,$8,'draft') RETURNING *`,
    [t.title, t.body, t.survey_url, t.reward_text, t.reward_image, t.deadline,
      JSON.stringify(t.target), req.adminId]);
  await logAction({ adminId: req.adminId, action: 'create_task', target: `task:${row.id}`,
    detail: { title: row.title } });
  return ok(res, row);
}));

/**
 * 一个任务的详情与覆盖人群（2026-08-21）。
 *
 * 列表上撤掉了「发给谁」和「看过的」两列（定向勾了六个维度，一列写不清），
 * 那两件事挪到这里 —— 而且这里能回答一个列表回答不了的问题：
 * **勾的那些条件实际筛出了什么样的一群人。**
 *
 * 姓名按权限打码（跟老师页同一条纪律）。已读时间不是内容，一般管理员也能看：
 * 「这条通知有没有人看见」是运营要判断的事。
 */
adminRouter.get('/tasks/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const task = await queryOne(`SELECT * FROM tasks WHERE id = $1`, [id]);
  if (!task) throw notFound('没有这个任务');
  const a = await taskAudience(task);
  return ok(res, {
    task: {
      id: task.id, title: task.title, body: task.body, survey_url: task.survey_url,
      reward_text: task.reward_text, reward_image: task.reward_image,
      deadline: task.deadline, status: task.status, target: task.target,
      created_at: task.created_at,
    },
    covers: a.covers,
    reads: a.reads,
    unrestricted: a.unrestricted,
    breakdown: a.breakdown,
    teachers: a.teachers.map((t) => ({
      ...t,
      real_name: maskName(t.real_name, req.isSuper),
      name_masked: !req.isSuper,
    })),
  });
}));

adminRouter.post('/tasks/:id/update', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await queryOne(`SELECT * FROM tasks WHERE id = $1`, [id]);
  if (!cur) throw notFound('没有这个任务');
  const t = pickTask(req.body || {}, cur);
  if (!t.title) throw badRequest('标题不能空');

  const row = await queryOne(
    `UPDATE tasks SET title=$2, body=$3, survey_url=$4, reward_text=$5, reward_image=$6,
            deadline=$7::date, target=$8::jsonb, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [id, t.title, t.body, t.survey_url, t.reward_text, t.reward_image, t.deadline,
      JSON.stringify(t.target)]);
  await logAction({ adminId: req.adminId, action: 'update_task', target: `task:${id}` });
  return ok(res, row);
}));

adminRouter.post('/tasks/:id/publish', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await queryOne(`SELECT * FROM tasks WHERE id = $1`, [id]);
  if (!cur) throw notFound('没有这个任务');
  if (cur.status === 'open') throw badRequest('这个任务已经发布了');
  // 过了截止日期再发布，老师那边一条都看不到（列表按 deadline >= today 筛）——
  // 那是「发布成功了但没人收到」，最难查的一种
  if (cur.deadline && new Date(cur.deadline) < new Date(new Date().toDateString())) {
    throw badRequest('截止日期已经过了，改一下日期再发布');
  }
  const row = await queryOne(
    `UPDATE tasks SET status='open', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
  const p = await previewTarget(row.target);
  await logAction({ adminId: req.adminId, action: 'publish_task', target: `task:${id}`,
    detail: { covers: p.teachers } });
  logger.info('task_published', { by: req.adminId, task_id: id, covers: p.teachers });
  return ok(res, { ...row, covers: p.teachers });
}));

adminRouter.post('/tasks/:id/close', asyncRoute(async (req, res) => {
  const row = await queryOne(
    `UPDATE tasks SET status='closed', updated_at=now() WHERE id=$1 RETURNING id, status`,
    [Number(req.params.id)]);
  if (!row) throw notFound('没有这个任务');
  await logAction({ adminId: req.adminId, action: 'close_task', target: `task:${row.id}` });
  return ok(res, row);
}));

// ---------------------------------------------------------------
// 管理员账号 —— 全部只有超管能碰
// ---------------------------------------------------------------
adminRouter.get('/admins', requireSuper, asyncRoute(async (req, res) => {
  return ok(res, { items: await listAdmins(), me: req.adminId });
}));

adminRouter.post('/admins', requireSuper, asyncRoute(async (req, res) => {
  const b = req.body || {};
  try {
    const row = await createAdmin({
      username: b.username, password: b.password,
      role: b.role, displayName: b.display_name, createdBy: req.adminId,
    });
    await logAction({ adminId: req.adminId, action: 'create_admin',
      target: `admin:${row.username}`, detail: { role: row.role } });
    logger.info('admin_created', { by: req.adminId, admin_id: row.id, role: row.role });
    return ok(res, row);
  } catch (e) { throw badRequest(e.message); }
}));

adminRouter.post('/admins/:id/password', requireSuper, asyncRoute(async (req, res) => {
  try {
    const row = await setPassword(Number(req.params.id), req.body?.password);
    if (!row) throw notFound('没有这个账号');
    await logAction({ adminId: req.adminId, action: 'reset_password', target: `admin:${row.username}` });
    return ok(res, { id: row.id, username: row.username });
  } catch (e) { throw badRequest(e.message); }
}));

adminRouter.post('/admins/:id/status', requireSuper, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  // 不能停用自己 —— 停完就登不进来了，得手动改库才能救回来
  if (id === req.adminId) throw badRequest('不能停用自己的账号');

  const status = String(req.body?.status || '');
  if (!['active', 'disabled'].includes(status)) throw badRequest('状态不对');

  // 最后一个可用的超管不能被停用，否则没人能管账号了
  if (status === 'disabled') {
    const target = await queryOne(`SELECT role FROM admins WHERE id = $1`, [id]);
    if (target?.role === ROLES.SUPER) {
      const n = await queryOne(
        `SELECT COUNT(*)::int AS n FROM admins WHERE role = 'super' AND status = 'active'`);
      if (n.n <= 1) throw badRequest('这是最后一个超级管理员，停用之后就没人能管账号了');
    }
  }

  const row = await queryOne(
    `UPDATE admins SET status = $1 WHERE id = $2 RETURNING id, username, status`, [status, id]);
  if (!row) throw notFound('没有这个账号');
  await logAction({ adminId: req.adminId, action: 'admin_status',
    target: `admin:${row.username}`, detail: { status } });
  return ok(res, row);
}));

/** 改自己的密码 —— 这个一般管理员也能做，改的是自己的 */
adminRouter.post('/me/password', asyncRoute(async (req, res) => {
  const oldPwd = String(req.body?.old_password || '');
  const newPwd = String(req.body?.new_password || '');
  const me = await queryOne(`SELECT * FROM admins WHERE id = $1`, [req.adminId]);
  if (!me) throw notFound('账号不存在');
  if (!(await verifyPassword(oldPwd, me.password_hash, me.salt))) {
    throw badRequest('原密码不对');
  }
  try {
    await setPassword(req.adminId, newPwd);
    await logAction({ adminId: req.adminId, action: 'change_own_password' });
    return ok(res, { changed: true });
  } catch (e) { throw badRequest(e.message); }
}));

/**
 * 改自己的称呼。
 *
 * `admins` 表能算「个人基本信息」的就这一列（其余是 username / role / status /
 * password_hash / salt / created_by / 两个时间）—— 所以这个接口只有一个字段，
 * 不是漏了别的。
 *
 * 🔴 **用户名和角色在这里改不了**，哪怕请求体里带了也不看：
 *   · 改自己的角色 = 一般管理员把自己提成超管，绕过整套权限
 *   · 改用户名 = 操作记录里 `admin:username` 那些 target 全部指向一个不存在的人
 * 角色要变走 `/admins`（超管专属）。
 */
adminRouter.post('/me/profile', asyncRoute(async (req, res) => {
  const name = String(req.body?.display_name ?? '').trim().slice(0, 32);
  if (!name) throw badRequest('称呼不能是空的');
  const row = await queryOne(
    `UPDATE admins SET display_name = $2 WHERE id = $1
     RETURNING id, username, role, display_name`,
    [req.adminId, name]
  );
  if (!row) throw notFound('账号不存在');
  await logAction({ adminId: req.adminId, action: 'update_own_profile', target: `admin:${row.username}` });
  return ok(res, { admin: row });
}));

/**
 * 操作审计。多人之后「这笔额度是谁发的」必须能查。
 *
 * 2026-08-18 加了筛选和分页。一开始只是一张倒序裸表 LIMIT 200 ——
 * 攒到几百条之后它就废了：翻不动，而且第 201 条起根本看不到，
 * 也就是说「查得到」这件事在数据变多之后自己失效了，还不出声。
 *
 * `?admin_id=&action=&from=&to=&page=`，每页 100。
 * 也回一份 `admins` 和 `actions` 让筛选下拉只列**真正出现过的**值 ——
 * 列一堆从来没发生过的动作，筛选框自己就变成噪音。
 */
/**
 * 操作类型分成 5 组（2026-08-22 用户提：「类别太多了，约束一下，保持在 5 类之内」）。
 *
 * 原来那个下拉列的是**动作本身**，二十多项 —— 而人翻记录时想的从来不是
 * 「我要找 set_default_image_model」，是「谁动了后台设置」。
 *
 * 🔴 **`system` 是兜底组，用「不属于其他四组」定义，不是列举。**
 * 列举的话，以后新加一个动作（比如导出什么）就会**同时不属于任何一组** ——
 * 于是它在按组筛的时候一条都查不到，而全部记录里又看得见。
 * 那种「筛了就消失」的缺陷不报错，只让人以为记录丢了。
 */
const ACTION_GROUPS = [
  { key: 'quota', cn: '额度与兑换码',
    actions: ['grant_quota', 'create_code', 'create_codes_batch', 'void_code',
      'export_codes', 'delete_code_batches', 'add_topup'] },
  { key: 'org', cn: '园所与名单',
    actions: ['create_kindergarten', 'update_kindergarten', 'import_kindergartens',
      'import_roster', 'void_roster', 'reassign_roster'] },
  { key: 'task', cn: '任务',
    actions: ['create_task', 'update_task', 'publish_task', 'close_task'] },
  { key: 'teacher', cn: '教师账号',
    actions: ['teacher_status', 'create_rebind_code', 'void_rebind_code'] },
  // 兜底：管理员账号、配图模型、本人的密码与信息，外加任何新动作
  { key: 'system', cn: '后台管理', actions: null },
];
const GROUPED_ACTIONS = ACTION_GROUPS.flatMap((g) => g.actions || []);

/** 时间范围三档（2026-08-22 用户定）。手选起止日期撤掉了 */
const LOG_RANGES = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

adminRouter.get('/logs', requireSuper, asyncRoute(async (req, res) => {
  // 每页 20，可选 50 / 100（2026-08-22 用户定）。原来写死 100 ——
  // 一屏根本铺不完，「翻页」那两个按钮等于永远不出现。
  // **白名单而不是直接收 Number(per)**：`?per=100000` 会把这一页变成
  // 一次全表扫描，而它是超管随手能改的 URL
  const PER = [20, 50, 100].includes(Number(req.query.per)) ? Number(req.query.per) : 20;
  const page = Math.max(1, Number(req.query.page) || 1);

  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (req.query.admin_id) add('l.admin_id = $?', Number(req.query.admin_id));
  // `action`（单个动作）**留着**：回归脚本按它断言，而且出事时按单个动作查更准。
  // 界面用的是 `group`
  if (req.query.action) add('l.action = $?', String(req.query.action));
  const group = ACTION_GROUPS.find((g) => g.key === String(req.query.group || ''));
  if (group) {
    if (group.actions) add('l.action = ANY($?)', group.actions);
    else add('NOT (l.action = ANY($?))', GROUPED_ACTIONS);   // 兜底组，见上面那段
  }
  const range = LOG_RANGES[String(req.query.range || '')];
  if (range) where.push(`l.created_at > now() - interval '${range}'`);
  // from / to 也留着（回归脚本在用）。界面已经改成三档预设，不再传它们。
  // to 那天本身要算在里面，所以是「< 次日零点」而不是 <= 那天零点 ——
  // 写成 <= 会让当天的记录一条都筛不出来，而这种错很难看出来
  if (req.query.from) add('l.created_at >= $?::date', String(req.query.from));
  if (req.query.to) add("l.created_at < ($?::date + interval '1 day')", String(req.query.to));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [total, rows, admins, groupCounts] = await Promise.all([
    queryOne(`SELECT COUNT(*)::int AS n FROM admin_logs l ${clause}`, params),
    query(`
      SELECT l.*, a.username
        FROM admin_logs l LEFT JOIN admins a ON a.id = l.admin_id
      ${clause}
       ORDER BY l.created_at DESC
       LIMIT ${PER} OFFSET ${(page - 1) * PER}`, params),
    query(`SELECT DISTINCT l.admin_id, a.username
             FROM admin_logs l LEFT JOIN admins a ON a.id = l.admin_id
            WHERE l.admin_id IS NOT NULL ORDER BY a.username`),
    // 每组多少条。下拉里带上条数，跟原来按动作列时一样 ——
    // 空组也列出来（不是「真正出现过的才列」那条规则的反例：
    // 五组是固定的语义分区，藏掉一组反而让人以为那类操作不存在）
    query(`SELECT action, COUNT(*)::int AS n FROM admin_logs GROUP BY action`),
  ]);

  const perAction = Object.fromEntries(groupCounts.rows.map((r) => [r.action, r.n]));
  const groups = ACTION_GROUPS.map((g) => ({
    key: g.key,
    cn: g.cn,
    n: g.actions
      ? g.actions.reduce((s, a) => s + (perAction[a] || 0), 0)
      : Object.entries(perAction).reduce((s, [a, n]) => s + (GROUPED_ACTIONS.includes(a) ? 0 : n), 0),
  }));

  return ok(res, {
    items: rows.rows,
    total: total.n,
    page,
    pages: Math.max(1, Math.ceil(total.n / PER)),
    per_page: PER,
    admins: admins.rows,
    groups,
    ranges: Object.keys(LOG_RANGES),
  });
}));

// ---------------------------------------------------------------
// 配图模型 —— **超管专属**
//
// 为什么不在小程序设置页里加：那一屏是给老师看的。加一个模型要填地址和 API key，
// 而「API key 只在服务端、任何情况不下发到小程序」是这个项目的铁律
// （CLAUDE.md）。让老师在手机上敲 key，等于把钥匙串挂在门上，
// 而且任何一个老师都能改所有人用的模型。
//
// 所以：**这里负责增删改（含 key），小程序设置页只负责选**。
// 老师那边拿到的永远只有 key/名字/一句话，没有地址也没有密钥。
// ---------------------------------------------------------------

/** key 一律遮住再下发。sk-abcd…wxyz 这种形状足够认出是哪一把，又拼不回原文 */
function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 12) return s ? '****' : '';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

adminRouter.get('/image-models', requireSuper, asyncRoute(async (req, res) => {
  const all = await listModels({ includeDisabled: true });
  return ok(res, {
    // 内置那两家也列出来，但标着 builtin —— 它们的 key 在 .env 里，后台改不了。
    // 不列的话会显得「明明在用却查不到」
    items: all.map((m) => ({
      key: m.key,
      name_cn: m.name_cn,
      hint: m.hint,
      format: m.format,
      // `builtin` 现在**恒为 false**：.env 那两家启动时已经播种进 image_models 表，
      // 从此每个模型都是库里的一行，都能改、都能删（2026-08-22 用户定）。
      // 字段留着是因为前端还在读它 —— 播种之前那一瞬它仍然是 true
      builtin: Boolean(m.builtin),
      enabled: m.enabled,
      sort_order: m.sort_order,
      model: m.account?.model || '',
      // 内置的地址原来一律回空串，于是编辑表单里那一格是空的，
      // 保存一下就把地址清成了空 —— 现在照实回
      base_url: m.account?.baseURL || '',
      api_key_masked: maskKey(m.account?.apiKey),
    })),
    formats: Object.entries(FORMATS).map(([k, v]) => ({ key: k, cn: v.cn, hint: v.hint })),
    // 后台设过就以它为准，没设过才是 .env 那个 —— 跟 pickModel 的取值顺序保持一致，
    // 否则界面上显示的默认和实际用的会是两回事
    default_provider: await getSetting(SETTING_KEYS.imageProvider, config.imageProvider),
  });
}));

adminRouter.post('/image-models', requireSuper, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const key = String(b.key || '').trim().toLowerCase();
  // key 会存进 lesson_images.provider，所以限死字符集：以后按它统计、按它对账
  if (!/^[a-z0-9_-]{2,32}$/.test(key)) throw badRequest('模型代号只能用小写字母、数字、- 和 _，2–32 位');
  // 原来这里硬拦 gpt / minimax（「内置代号占用」）。2026-08-22 撤了：
  // 那两个代号现在就是库里普通的两行，删掉之后应该能用同名重建 ——
  // 硬拦会让「删了但加不回来」，而重名本来就有下面那道 exists 检查兜着
  if (!isKnownFormat(b.format)) throw badRequest('不认识这个接口格式');
  if (!String(b.base_url || '').startsWith('http')) throw badRequest('接口地址要以 http 开头');
  if (!String(b.api_key || '').trim()) throw badRequest('填一下 API key');
  if (!String(b.model || '').trim()) throw badRequest('填一下模型名');

  const exists = await queryOne(`SELECT id FROM image_models WHERE key = $1`, [key]);
  if (exists) throw badRequest('这个代号已经有了');

  const row = await queryOne(
    `INSERT INTO image_models (key, name_cn, hint, format, base_url, api_key, model, options, enabled, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id, key`,
    [
      key,
      String(b.name_cn || key).slice(0, 40),
      String(b.hint || '').slice(0, 60),
      b.format,
      String(b.base_url).trim(),
      String(b.api_key).trim(),
      String(b.model).trim(),
      JSON.stringify(b.options || {}),
      b.enabled === false ? false : true,
      Number(b.sort_order) || 100,
    ]
  );
  // detail 里**不放 key**。审计表是给人翻的，密钥进去就等于多一个明文副本
  await logAction({
    adminId: req.adminId, action: 'create_image_model',
    target: `image_model:${key}`, detail: { format: b.format, model: b.model },
  });
  logger.info('image_model_created', { by: req.adminId, key, format: b.format });
  return ok(res, { id: row.id, key: row.key });
}));

adminRouter.post('/image-models/:key/update', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const b = req.body || {};
  // .env 里那两家启动时就被播种进这张表了（2026-08-22，见 imageModels.js 文件头），
  // 所以这里不再有「内置模型改不了」这回事 —— 每个模型都是库里的一行
  const cur = await queryOne(`SELECT * FROM image_models WHERE key = $1`, [key]);
  if (!cur) throw notFound('没有这个模型');

  // api_key 留空 = 不改。否则每次改个名字都要把密钥重新敲一遍，
  // 而界面上显示的是遮住的那串，敲回去只会把 sk-abcd…wxyz 存成真 key
  const nextKey = String(b.api_key || '').trim();

  /* 🔴 **接口地址和模型名不许被改成空**（2026-08-22 修，真出事了才加的）。
     `POST /image-models` 建的时候校验了这两项，而这条 update **一直没校验** ——
     典型的「两条路只有一条守着」。
     出事经过：那时 `GET /image-models` 对内置模型一律回 `base_url: ''`，
     于是编辑表单里那一格是空的；用户打开 gpt 和 minimax 各按了一次保存，
     空串就写进库了 —— **两个模型从此画不出图，而全程没有任何报错**。
     （地址回空串那个毛病同一轮已经修掉，但校验这道也得有：
      下一次让它变空的可能是别的原因。） */
  const nextBase = String(b.base_url ?? cur.base_url).trim();
  const nextModel = String(b.model ?? cur.model).trim();
  if (!nextBase.startsWith('http')) throw badRequest('接口地址要以 http 开头，不能留空');
  if (!nextModel) throw badRequest('模型名不能留空');
  const row = await queryOne(
    `UPDATE image_models
        SET name_cn = $2, hint = $3, base_url = $4, model = $5,
            options = $6::jsonb, enabled = $7, sort_order = $8,
            api_key = COALESCE(NULLIF($9, ''), api_key), updated_at = now()
      WHERE key = $1 RETURNING key, enabled`,
    [
      key,
      String(b.name_cn ?? cur.name_cn).slice(0, 40),
      String(b.hint ?? cur.hint).slice(0, 60),
      nextBase,
      nextModel,
      JSON.stringify(b.options ?? cur.options ?? {}),
      b.enabled === undefined ? cur.enabled : Boolean(b.enabled),
      Number(b.sort_order ?? cur.sort_order) || 100,
      nextKey,
    ]
  );
  await logAction({
    adminId: req.adminId, action: 'update_image_model',
    target: `image_model:${key}`, detail: { enabled: row.enabled, key_changed: Boolean(nextKey) },
  });
  return ok(res, { key: row.key, enabled: row.enabled });
}));

adminRouter.post('/image-models/:key/delete', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  // 2026-08-22 起**每个模型都删得掉**（用户定：「不要写死在 .env 中，
  // 应该是可以删除或者编辑的」）。.env 那两家启动时已经播种进这张表，
  // 而播种只发生一次 —— 所以删掉之后不会在下次重启时自己回来
  const row = await queryOne(`DELETE FROM image_models WHERE key = $1 RETURNING key`, [key]);
  if (!row) throw notFound('没有这个模型');
  // 已经用它画出来的图不动 —— lesson_images.provider 只是一条历史记录，
  // 删模型不该让老师的图消失
  await logAction({ adminId: req.adminId, action: 'delete_image_model', target: `image_model:${key}` });
  logger.info('image_model_deleted', { by: req.adminId, key });
  return ok(res, { deleted: true });
}));

/**
 * 试一张。加完一个模型最想知道的就是「它到底能不能出图」，
 * 而不是回到小程序、开一份教案、选材料、等一分钟才发现地址填错了。
 */
adminRouter.post('/image-models/:key/test', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const model = (await listModels({ includeDisabled: true })).find((m) => m.key === key);
  if (!model) throw notFound('没有这个模型');
  const prompt =
    String(req.body?.prompt || '').trim() ||
    'Black and white line drawing on pure white paper, thick solid black outlines. ' +
      'An empty printable chart: one plain table, 3 columns and 4 rows, every cell empty. ' +
      'Absolutely no text of any kind.';
  const t = Date.now();
  const img = await generateWith(model, { prompt, width: 1536, height: 2048, optimize: false });
  const { objectKey } = await uploadImage({ buffer: img.buffer, ext: img.ext || 'jpg' });
  await logAction({ adminId: req.adminId, action: 'test_image_model', target: `image_model:${key}` });
  return ok(res, {
    ok: true,
    ms: Date.now() - t,
    width: img.width,
    height: img.height,
    bytes: img.bytes,
    url: buildImageUrl(objectKey),
  });
}));

/**
 * 设为默认 —— 老师配图时用哪家。
 *
 * 存进 app_settings 而不是改 .env：改完**立刻生效，不用重启**。
 * 这个选择要经常改（哪家把记录表画对了、哪家快、哪家便宜，都是试出来的），
 * 锁在服务器文件里等于锁给会 ssh 的人。
 */
adminRouter.post('/image-models/:key/default', requireSuper, asyncRoute(async (req, res) => {
  const key = String(req.params.key || '').toLowerCase();
  const model = (await listModels()).find((m) => m.key === key);
  // 只能把**启用着且配好了**的设成默认。设一个停用的等于让所有老师立刻画不出图
  if (!model) throw badRequest('这个模型不存在，或者已停用 / 没配好，不能设成默认');

  await setSetting(SETTING_KEYS.imageProvider, key, req.adminId);
  await logAction({ adminId: req.adminId, action: 'set_default_image_model', target: `image_model:${key}` });
  logger.info('default_image_model_changed', { by: req.adminId, key });
  return ok(res, { default_provider: key });
}));

/**
 * 批量建码。
 *
 * **不需要名单**（2026-08-18 用户定）：直接要 N 个码，谁拿到谁能兑。
 * 用法是把导出的 CSV 灌进问卷星当奖励发放，或者整批交给园所。
 *
 * 因此「问卷答卷 ↔ 小程序账号」的对应关系**不在我们库里**了 ——
 * 它在问卷星那边（哪个手机号领到了哪个码）。后台按手机号搜不到这些老师，
 * 改成按**兑换码**搜。这是这次改动的真实代价，
 * 别指望还能像以前那样按手机号对账。
 *
 * **也不绑园所**（2026-08-21 用户定，原话「兑换码的基本逻辑是谁持有谁使用，
 * 无需设置过多门槛」）。批量建码的用途正是「灌进问卷星谁填谁拿」——
 * 那一刻根本不知道拿到码的人在哪个园，硬填一个只会让
 * 园所页的「发了 N 个码没人兑」变成假数字。
 *
 * ⚠️ 单个建码（`POST /codes`）**仍然可以选园所**，那是有用的：
 * 整批交给某个园的时候，「这个园发了几个码、兑了几个」是跟进合作的依据
 * （园所页那一列就靠它）。两个接口在这一点上不一样，是有意的。
 */
adminRouter.post('/codes/batch', asyncRoute(async (req, res) => {
  const b = req.body || {};
  // 一次最多 200 个：再多就不是「发一批」而是「刷库」了，而且导出的 CSV 也没人看得完
  const count = Math.min(Math.max(Number(b.count) || 0, 1), 200);
  const initText = Number(b.init_text) > 0 ? Number(b.init_text) : 20;
  const initImage = Number(b.init_image) > 0 ? Number(b.init_image) : 10;
  const reason = String(b.grant_reason || '').trim() || '批量发放';

  // 先记这一次操作，再往里塞码。列表是按操作列的（019 迁移），
  // `requested` 记的是「要建几个」—— 跟实际建成的张数分开存：
  // 撞码重试失败时两个数会不一样，而那正是要看见的信息，不该被抹平
  // 要 1 个就记成 'single'（2026-08-22）。界面上「新建」和「批量建码」
  // 合成了一个入口、由数量决定，所以这条路现在也会收到 count=1 ——
  // 记成 'batch' 的话列表里会出现一行「批量建 1 个」，读起来像出了什么错
  const batch = await queryOne(
    `INSERT INTO code_batches
       (kind, requested, init_text, init_image, grant_reason, created_by)
     VALUES ($6,$1,$2,$3,$4,$5) RETURNING id`,
    [count, initText, initImage, reason, req.adminId, count === 1 ? 'single' : 'batch']
  );

  const created = [];
  for (let i = 0; i < count; i += 1) {
    // generateCode 里已经避开了容易看错的字符（0/O、1/I），这里只管重试撞码
    let code = generateCode();
    for (let retry = 0; retry < 5; retry += 1) {
      const dup = await queryOne(`SELECT id FROM redemption_codes WHERE code = $1`, [code]);
      if (!dup) break;
      code = generateCode();
    }
    await query(
      `INSERT INTO redemption_codes
         (code, init_text, init_image, grant_reason, status, batch_id)
       VALUES ($1,$2,$3,$4,'unused',$5)`,
      [code, initText, initImage, reason, batch.id]
    );
    created.push(code);
  }

  await logAction({ adminId: req.adminId, action: 'create_codes_batch', target: `codes:${created.length}`,
    detail: { count: created.length, init_text: initText, init_image: initImage } });
  logger.info('codes_batch_created', { by: req.adminId, count: created.length });

  // 把这一批的参数一起回给前端：建完要在弹框里**一行一个**铺出来，
  // 还要能就地生成一份 CSV 发给某个园或某个平台。
  // 参数是整批共用的（都是刚才那张表单填的），所以不用每行都查一遍库。
  // `kindergarten: null` 这个键留着只为一件事：老版前端还在读它，
  // 键没了会渲染出字面的 "undefined"。前端那份 CSV 已经把「幼儿园」那一列去掉了
  return ok(res, {
    created,
    batch: { id: batch.id, count: created.length, init_text: initText, init_image: initImage,
      grant_reason: reason, kindergarten: null },
  });
}));

/** 状态一律出中文。这份 CSV 是给人看的，unused / void 印在上面等于没写 */
const CODE_STATUS_CN = { unused: '未使用', used: '已使用', void: '已作废' };

/**
 * 导出 CSV。用途是把码灌进问卷星当奖励，或整批交给园所。
 *
 * 2026-08-19 之后**码上没有任何身份信息了**（016 迁移删了那几列），
 * 所以这份 CSV 只有六列，也不再有「手机号那列印着字面 null」那个毛病 ——
 * 那一列根本不存在了。之前修过的另两处保留：
 *   · 状态出中文（`unused` 印在给人看的表上等于没写）
 *   · `codes=A,B,C` 只导刚建的那一批（「发给某个园」要的是这一批，
 *     不是历史上所有未使用的码）
 *
 * 仍然锁超管：它是一份能直接兑成额度的东西，等于一叠现金券。
 */
adminRouter.get('/codes/export', requireSuper, asyncRoute(async (req, res) => {
  const status = String(req.query.status || 'unused');
  const only = String(req.query.code || '').trim();
  const list = String(req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean);

  const params = [];
  let where = '';
  if (list.length) { params.push(list); where = `WHERE c.code = ANY($${params.length}::text[])`; }
  else if (only) { params.push(only); where = `WHERE c.code = $${params.length}`; }
  else if (status !== 'all') { params.push(status); where = `WHERE c.status = $${params.length}`; }

  const rows = (await query(`
    SELECT c.code, c.init_text, c.init_image, c.grant_reason, c.status, c.created_at,
           k.name AS kindergarten
      FROM redemption_codes c
      LEFT JOIN kindergartens k ON k.id = c.kindergarten_id
    ${where} ORDER BY c.created_at DESC LIMIT 2000`, params)).rows;

  const cols = [
    ['兑换码', (r) => r.code],
    ['幼儿园', (r) => r.kindergarten || ''],
    ['教案额度', (r) => r.init_text],
    ['配图额度', (r) => r.init_image],
    ['说明', (r) => r.grant_reason || ''],
    ['状态', (r) => CODE_STATUS_CN[r.status] || r.status],
    ['创建时间', (r) => new Date(r.created_at).toISOString().slice(0, 10)],
  ];

  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.map(([h]) => h).join(',')]
    .concat(rows.map((r) => cols.map(([, get]) => cell(get(r))).join(',')))
    .join('\r\n');

  await logAction({ adminId: req.adminId, action: 'export_codes', target: `codes:${rows.length}`,
    detail: { status, count: rows.length, batch: list.length || undefined, single: Boolean(only) } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="codes-${list.length ? 'batch' : status}.csv"`);
  // BOM：没有它 Excel 打开中文列头是乱码
  res.send('﻿' + csv);
}));
