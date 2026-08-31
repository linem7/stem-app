/**
 * 后台各域共用的守卫和小工具。
 *
 * 会放进来的只有一种东西：**跨域被用到的**。
 * `maskName` 在名单、老师、兑换码、任务四处都要；`requireSuper` 更是散在六个文件里。
 * 只有一个调用方的东西留在它自己那个文件里，别往这儿搬 —— 这里一胖，
 * 「拆开」这件事就白做了。
 */
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { ROLES } from '../../services/admins.js';
import { surnameOf } from '../../services/roster.js';

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
export function requireSuper(req, res, next) {
  if (!req.isSuper) {
    return next(new AppError(ErrorCode.UNAUTHORIZED, {
      message: '这一项只有超级管理员能看',
      detail: { need: 'super' },
    }));
  }
  next();
}

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
export function maskName(name, isSuper) {
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
export function sendXlsx(res, buf, filename) {
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
export function maskPhone(p) {
  if (!p) return null;
  const s = String(p);
  return s.length < 8 ? '***' : `${s.slice(0, 3)}****${s.slice(-4)}`;
}
