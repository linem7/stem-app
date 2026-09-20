/**
 * 回归脚本共用的一件事：**造一个能用的老师账号**。
 *
 * 【为什么突然需要它】
 * 2026-09-20 之前，所有起服务的回归脚本都靠后端的 `DEV_FAKE_LOGIN`：
 * 发一个 `code: 'dev:xxx'`，后端就凭空变一个老师出来。手机号 + 密码落地时
 * 那条分支删掉了，于是 10 个脚本同时跑不起来。
 *
 * 现在建账号只有一条路：**码 + 名单位置 + 手机号 + 密码**
 * （`POST /auth/activate`，见 routes/activate.js）。
 * 各脚本原来已经有一个 `makeTicket()` 在造「园 + 名单 + 码」了，
 * 所以这里只补最后一步 —— 把那张券兑成一个账号。
 *
 * 【为什么不用密码登录绕开】
 * 登录要一个已存在的账号，而造账号正是这里要做的事。绕不开。
 *
 * ⚠️ 造出来的账号会留在库里。清它靠 `cleanup-test-data.mjs` ——
 * 它按**园所名字**认垃圾，所以各脚本建园时必须用 `JUNK_KG_NAMES` 里有的名字。
 * 这些账号挂在那些园下面，跟着一起走。
 */

const BASE = process.env.API_BASE || process.env.BASE || 'http://localhost:3000';

/** 回归账号的密码。都是测试数据，不用藏 */
export const TEST_PASSWORD = 'regress123456';

let seq = 0;

/**
 * 每轮都不一样的 11 位手机号。
 *
 * 要真的不一样：`teachers.phone` 上有唯一索引，撞号会走进
 * 「这个手机号已经注册过了」那条分支，而那个报错看起来像脚本坏了。
 *
 * 13 + 时间戳后 6 位 + 序号 2 位 + 随机 1 位 = 11 位。
 * 序号管同一次运行里的多个账号，时间戳和随机位管不同的运行。
 */
export function testPhone() {
  seq += 1;
  return `13${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}${Math.floor(Math.random() * 10)}`;
}

/**
 * 把一张入场券兑成一个账号，返回激活响应（`{ token, teacher, quota, granted }`）。
 *
 * @param {{ code: string, slot?: number, id?: number }} ticket
 *   各脚本的 makeTicket 返回的字段名不太一样（slot / id），两个都认。
 */
export async function activateAccount(ticket) {
  const entryId = ticket.slot ?? ticket.id;
  if (!ticket?.code || !entryId) {
    throw new Error(`activateAccount 拿到一张不完整的券：${JSON.stringify(ticket)}`);
  }

  const phone = testPhone();
  const res = await fetch(`${BASE}/v1/auth/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: ticket.code,
      roster_entry_id: entryId,
      phone,
      phone_confirm: phone,
      password: TEST_PASSWORD,
    }),
  }).then((r) => r.json());

  if (!res.ok) {
    throw new Error(
      `激活回归账号失败：${res.error?.message} —— ` +
        `券是 ${ticket.code} / 位置 ${entryId}（回归脚本挂在这一步，多半是 activate 的契约变了）`
    );
  }

  /* 把用过的手机号一起带出来。
     接口**不会**回手机号（铁律：不下发到页面），所以调用方想知道
     「这个账号的登录名是什么」只能从这里拿 ——
     而「拿它 + 密码能登回来」正是这轮功能的验收点，测不了就等于没测。 */
  return { ...res.data, testPhone: phone };
}
