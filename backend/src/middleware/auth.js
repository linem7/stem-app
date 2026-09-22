/**
 * JWT 签发与校验。
 *
 * token 里只放 teacher_id（和签发时间），不放 openid、不放昵称。
 * 理由：token 会存在浏览器里，内容是可以被任何人解出来看的（JWT 只签名不加密）。
 * 放 id 意味着即使 token 泄露，泄露的也只是一个自增数字。
 */
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { queryOne } from '../db/pool.js';
import { AppError, ErrorCode, unauthorized } from '../utils/errors.js';

/**
 * @param {number} teacherId
 * @param {number} [tokenVersion] teachers.token_version。换绑时会 +1，
 *   于是旧设备上那个 token 当场失效 —— 见 015 迁移的注释
 */
export function signToken(teacherId, tokenVersion = 0) {
  return jwt.sign({ tid: teacherId, tv: tokenVersion }, config.jwt.secret, {
    expiresIn: config.jwt.expiresInSeconds,
  });
}

function extractToken(req) {
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * 校验中间件。通过后挂 req.teacher（完整行）和 req.teacherId。
 *
 * 为什么每次都查一次库而不是只信 token：
 * 账号被停用（status='disabled'）或注销后，已签发的 token 还没到期。
 * 每次查一行主键索引的成本很低，换来「后台一改立刻生效」的确定性。
 */
export async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      throw unauthorized('登录已过期，请重新进入');
    }

    let payload;
    try {
      payload = jwt.verify(token, config.jwt.secret);
    } catch (err) {
      // TokenExpiredError / JsonWebTokenError 一律归到 UNAUTHORIZED —— 前端的处理是一样的：重新登录
      throw new AppError(ErrorCode.UNAUTHORIZED, { detail: { reason: err.name } });
    }

    const teacher = await queryOne('SELECT * FROM teachers WHERE id = $1', [payload.tid]);
    if (!teacher) {
      throw unauthorized('登录已过期，请重新进入');
    }
    if (teacher.status !== 'active') {
      throw unauthorized('这个账号已被停用，如有疑问请联系我们');
    }
    // 换绑之后旧设备上那个 token 要立刻失效。
    // 换绑不改 status（那一行还是同一个活账号），所以上面那道拦不住它 ——
    // 而「换绑」的常见起因之一就是手机丢了。
    // 老 token 里没有 tv，读出来 undefined 当 0 看，跟列默认值一致：现有登录不会被踢。
    if ((payload.tv ?? 0) !== (teacher.token_version ?? 0)) {
      throw unauthorized('这个账号换过登录方式了，请重新进入');
    }

    req.teacher = teacher;
    req.teacherId = teacher.id;
    /* 这枚 token 什么时候过期（unix 秒）。
       给 `GET /me` 判断「要不要顺手续一个」用（2026-09-21）。
       ⚠️ 从**已验证的 payload** 里取，不是自己再解一遍 ——
       再解一遍就多一处可能跟这里不一致的地方。 */
    req.tokenExp = payload.exp || null;
    next();
  } catch (err) {
    next(err);
  }
}

/** 把老师行转成 api-spec 第 1/2 节约定的 teacher 对象 */
export function toTeacherDTO(row) {
  return {
    id: row.id,
    nickname: row.nickname,
    avatar_url: row.avatar_url,
    kindergarten_name: row.kindergarten_name,
    age_group: row.age_group,
    teaching_years: row.teaching_years,
    preferences: row.preferences || {},
    class_name: row.class_name,
    position: row.position,
    // 018：她自己填的两项。跟教龄同级 —— 关于老师这个从业者，不关于任何一个孩子。
    // 可以下发（是她自己填的、她自己要看），跟 real_name 不同级，别一起屏蔽掉。
    education: row.education,
    professional_title: row.professional_title,
    // 024：出生年月（YYYY-MM）。同样可下发 —— 她主动填的、她自己要看，
    // 而且它跟 real_name/phone 不是一个量级的可识别信息
    birth_month: row.birth_month,
    /* 档案引导页的判定条件。
       ⚠️ 2026-09-21 改：原来只看 `kindergarten_name && age_group`，
       而**自填进来的老师不填园所名**（用户 2026-09-21 定），
       所以那个判据对他们**恒为 false** —— 他们会永远被当成「档案没填」。
       现在改成看「完善信息」那几步真正收的四项。
       ⚠️ 但**别拿它当「领过额度」的判据** —— 那是 quota_grants 里
       那条 reason='完善信息' 的记录说了算（见 me.js）。她会改档案，
       而改完之后这个标记仍然可能为真，两者不是一回事。 */
    profile_completed: Boolean(row.birth_month && row.education
      && row.teaching_years !== null && row.age_group),
    // 前端靠这两位决定落在哪个页：没激活 → 待激活页，没同意 → 协议页，都齐了才进主流程
    activated: Boolean(row.activated_at),
    agreed: Boolean(row.agreed_at),
  };
  // 注意这里**没有** real_name（手机号那一列 016 迁移已经从库里删了）。
  // 它们永不下发到前端 —— operations.md 的三条铁律之一。
  // 前端任何地方都不该出现老师的手机号，包括她自己的。
}

/**
 * 激活守卫。挂在需要「已激活 + 已同意协议」的业务接口前面。
 *
 * 为什么单独一层而不是并进 requireAuth：登录本身必须对所有人放行 ——
 * 没激活的老师也要能登进来看到「待激活」页并输码，
 * 挂在一起就成了「要激活才能激活」的死循环。
 *
 * 返回的错误码带 need 字段，前端据此跳页，不用自己猜。
 */
export function requireActivated(req, res, next) {
  const t = req.teacher;
  if (!t?.activated_at) {
    return next(new AppError(ErrorCode.NOT_ACTIVATED, {
      message: '这里目前只开放给合作园的老师 —— 填一份问卷就能拿到兑换码',
      detail: { need: 'redeem' },
    }));
  }
  if (!t?.agreed_at) {
    return next(new AppError(ErrorCode.NOT_ACTIVATED, {
      message: '开始之前，先看一下我们会记录哪些东西',
      detail: { need: 'agreement' },
    }));
  }
  next();
}
