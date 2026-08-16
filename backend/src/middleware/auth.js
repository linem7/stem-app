/**
 * JWT 签发与校验。
 *
 * token 里只放 teacher_id（和签发时间），不放 openid、不放昵称。
 * 理由：token 会存在小程序本地，内容是可以被任何人解出来看的（JWT 只签名不加密）。
 * 放 id 意味着即使 token 泄露，泄露的也只是一个自增数字。
 */
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { queryOne } from '../db/pool.js';
import { AppError, ErrorCode, unauthorized } from '../utils/errors.js';

export function signToken(teacherId) {
  return jwt.sign({ tid: teacherId }, config.jwt.secret, {
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

    req.teacher = teacher;
    req.teacherId = teacher.id;
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
    // 档案引导页的判定条件：这两项齐了才算填过档案
    profile_completed: Boolean(row.kindergarten_name && row.age_group),
  };
}
