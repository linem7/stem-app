/**
 * 首次激活 —— api-spec 第 1.5 节、operations.md 第 1 节
 *
 *   POST /auth/roster/options   拉名单（园所 → 位置）
 *   POST /auth/activate         码 + 名单 + 手机号 + 密码 → 建账号
 *
 * 【为什么这两个单独一个文件，而且不带 requireAuth】
 * 它们是**给还没有账号的人**用的。小程序时代人人一进来就静默登录、都有 token，
 * 所以那时候它们挂在 requireAuth 后面没有问题。
 * web 端没有静默登录 —— 「拉名单要有 token」和「有 token 要先有账号」
 * 合起来就是一个死循环，她永远激活不了。
 *
 * 所以这两个接口是公开的。挡人的是**码**：
 *   · 拉名单必须先有一个有效且未使用的码，否则任何人打开网页就能看到一整个园的老师名单
 *   · 激活要码 + 名单行两样都对，而且**校验全过之前一个字都不写**
 *
 * 已登录的人用的那三个（续兑、协议、额度）在 routes/account.js。
 */
import { Router } from 'express';
import { queryOne, withTransaction } from '../db/pool.js';
import { ok, asyncRoute, badRequest } from '../utils/errors.js';
import { config } from '../config.js';
import { normalizeCode } from '../utils/code.js';
import { normalizePhone } from '../utils/phone.js';
import { hashPassword } from '../services/admins.js';
import { signToken, toTeacherDTO } from '../middleware/auth.js';
import { getQuota } from '../services/quota.js';
import {
  listOpenRegions, listOpenCities, listOpenKindergartens, listOpenEntries,
  OWNERSHIPS,
} from '../services/roster.js';
import { logger } from '../utils/logger.js';

export const activateRouter = Router();

/**
 * 把一个可能来自表单的字符串洗成「非空就是它，否则 null」。
 *
 * ⚠️ 用它而不是 `req.body?.x || null`：后者会把 `0` 和 `"0"` 也当成空
 * （`||` 对 falsy 一视同仁），而这里虽然暂时只洗地名，
 * 但同一个文件里马上要出现 `teaching_years: 0` 那种**有意义的值**，
 * 两种写法混用迟早在那个字段上出错。
 */
const str = (v) => {
  const s = String(v ?? '').trim();
  return s || null;
};

// ---------------------------------------------------------------
// POST /auth/roster/options —— 激活那一屏的选择器数据
//
// ⚠️ **必须带一个有效的码才给数据。** 不设这道门，任何人打开网页
// 就能看到一整个园的老师名单。
//
// （2026-09-20 从 account.js 搬过来，逻辑没动，只是不再要求登录。）
// ---------------------------------------------------------------
activateRouter.post(
  '/roster/options',
  asyncRoute(async (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!code) throw badRequest('先输兑换码');

    const row = await queryOne(`SELECT status FROM redemption_codes WHERE code = $1`, [code]);
    if (!row) throw badRequest('这个兑换码不存在，检查一下有没有敲错');
    if (row.status === 'used') throw badRequest('这个兑换码已经被用过了');
    if (row.status !== 'unused') throw badRequest('这个兑换码已经作废了，找发码给你的人要一个新的');

    /* 四级：省 → 市 → 园 → 位置。
       **判据是「给到哪一级就回哪一级」**，按最深那个有值的参数决定，
       不是四个 if 各自返回 —— 那样传了 province + city 会同时收到两份数据。

       🔴 码**不限定园所**（2026-09-21 用户定）：任意有效未使用的码
       都能查到任何园的位置。门是「有没有码」，不是「你是哪个园的」。 */
    const kgId = req.body?.kindergarten_id ? Number(req.body.kindergarten_id) : null;
    if (kgId) return ok(res, { entries: await listOpenEntries(kgId) });

    const city = str(req.body?.city);
    const province = str(req.body?.province);
    if (city && province) {
      return ok(res, { kindergartens: await listOpenKindergartens(province, city) });
    }
    if (province) return ok(res, { cities: await listOpenCities(province) });

    return ok(res, { regions: await listOpenRegions() });
  })
);

// ---------------------------------------------------------------
// POST /auth/activate —— 建账号
//
// **两条路**（2026-09-21 新增第二条）：
//
//   路径一（`roster_entry_id` 有值）：白名单里的老师，从四级下拉认领一个位置
//   路径二（没传 `roster_entry_id`）：不在名单的人，自己填姓名/园所/省市区/园所类型
//
// 判据是 `roster_entry_id` 有没有传，不是另加一个 kind 参数 ——
// 少一个参数就少一处「两个字段对不上」的可能。
//
// 两条路都要：码 + 手机号（两遍）+ 密码。
//
// 【为什么手机号要传两遍】
// 11 位打错一位是常事，而后果特别隐蔽：她下次登录输的是**正确的号**、
// 库里存的是**打错的号**，进不去，且她完全不知道哪里出了问题。
// 前端要她输两遍，后端也**必须自己再比一次** ——
// 只在前端比的话，绕过前端（curl、或者哪天前端改坏了）就会存进一个错的号。
// ⚠️ **对两条路一视同仁**（2026-09-21 用户定），不因为自填的人填得多就省掉。
//
// 🔴 **校验失败绝不能消耗那个码。** 所以事务里的顺序是
// **先把所有校验做完，再做第一次写入**：任何一条校验不过就 return，
// 那时候还什么都没写，commit 也是空的。
// 她进不来时只会说一句「用不了」，没有别的线索。
// ---------------------------------------------------------------
activateRouter.post(
  '/activate',
  asyncRoute(async (req, res) => {
    const code = normalizeCode(req.body?.code);
    if (!code) throw badRequest('请输入兑换码');

    const entryId = Number(req.body?.roster_entry_id) || null;

    /* 路径二要的几样。**在事务外先洗完**，因为它们要参与「先全部校验」
       那一轮，而那一轮里不该有 `req.body` 直接出现。 */
    const self = entryId ? null : {
      realName: str(req.body?.real_name),
      kgName: str(req.body?.kindergarten_name),
      province: str(req.body?.province),
      city: str(req.body?.city),
      ownership: str(req.body?.ownership),
    };

    if (self) {
      if (!self.realName) throw badRequest('填一下你的姓名');
      if (!self.kgName) throw badRequest('填一下你所在的幼儿园');
      /* 🔴 地区必须从下拉里选。自由填会脏成「北京 / 北京市 / 北京朝阳」，
         而研究上要按地区分组 —— 那种数据分不了组。
         这里只挡空值，**「在不在下拉里」要在事务里跟园所表比**，
         因为那个校验要查库。 */
      if (!self.province || !self.city) throw badRequest('地区从下拉里选一下');
      if (!self.ownership) throw badRequest('园所类型从选项里选一下');
      if (!OWNERSHIPS.includes(self.ownership)) {
        throw badRequest(`园所类型从选项里选一下（${OWNERSHIPS.join(' / ')}）`);
      }
    }

    const phone = normalizePhone(req.body?.phone);
    if (!phone) throw badRequest('手机号看起来不对，是 11 位数字');

    const phoneAgain = normalizePhone(req.body?.phone_confirm);
    if (phoneAgain && phoneAgain !== phone) {
      throw badRequest('两次填的手机号不一样，再核对一下');
    }

    const password = String(req.body?.password || '');
    if (password.length < 6) throw badRequest('密码至少 6 位');
    if (password.length > 64) throw badRequest('密码最多 64 位');

    /* 哈希在事务**外**算。scrypt 是故意慢的（这是它的价值），
       在事务里算等于白白多占一个数据库连接几百毫秒。 */
    const { hash, salt } = await hashPassword(password);

    let result;
    try {
      result = await withTransaction(async (client) => {
        // ---- 全部校验，一个字都还没写 ----
        //
        // 拿锁的顺序固定：码 → 名单 → 手机号。两条并发的激活请求顺序一致，
        // 才不会互相等成死锁。

        // FOR UPDATE 挡住同一个码被两个人同时兑换
        const row = (await client.query(
          `SELECT * FROM redemption_codes WHERE code = $1 FOR UPDATE`, [code])).rows[0];

        if (!row) return { err: '这个兑换码不存在，检查一下有没有敲错' };
        if (row.status === 'used') return { err: '这个兑换码已经被用过了' };
        if (row.status === 'void') return { err: '这个兑换码已经作废了，找发码给你的人要一个新的' };

        let entry;

        if (entryId) {
          // ---- 路径一：从名单里认领一个位置 ----
          // FOR UPDATE 挡住两个人同时认领同一个位置
          entry = (await client.query(
            `SELECT * FROM teacher_roster WHERE id = $1 FOR UPDATE`, [entryId])).rows[0];

          // 几句话要分得清 —— 这是她唯一的线索
          if (!entry) return { err: '名单上找不到这一位，退回去重新选一次' };
          if (entry.status === 'void') return { err: '名单上这一条已经作废了，找园长确认一下' };
          if (entry.status === 'moved') return { err: '名单上这一条是旧记录了，退回去重新选一次' };
          if (entry.status === 'claimed') {
            return { err: '这个位置已经有人认领了。要是被同事选错了，跟我们说一声' };
          }
        } else {
          // ---- 路径二：不在名单，自己填 ----

          /* 🔴 地区必须是库里出现过的。前端是下拉（选不出别的值），
             但这里是**服务端的第二道** —— 绕过前端（curl、或者哪天前端改坏了）
             就会存进一个自由文本，而那种数据研究上分不了组。
             跟「手机号前端输两遍、后端再比一次」同一个理由。 */
          const known = (await client.query(
            `SELECT 1 FROM kindergartens WHERE province = $1 AND city = $2 LIMIT 1`,
            [self.province, self.city])).rows[0];
          if (!known) return { err: '地区从下拉里选一下' };

          /* 给她插一行 teacher_roster。
             🔴 **为什么不直接建 teachers 行**：`teacher_ref` 是「人」这一层
             的身份（见 api-spec「三层身份」），研究要按它归组 ——
             自填的人也得能被追踪。

             status 直接是 'claimed'：跳过「待认领」，因为不存在「谁去认领它」。
             class_name / position / age_group 留 NULL —— 她没提供，**也不该编**。 */
          const ref = (await client.query(
            `SELECT COALESCE(MAX(teacher_ref), 1000) + 1 AS next FROM teacher_roster`
          )).rows[0].next;

          entry = (await client.query(
            `INSERT INTO teacher_roster
               (teacher_ref, real_name, kindergarten_id, class_name, position,
                age_group, status, claimed_at)
             VALUES ($1, $2, NULL, NULL, NULL, NULL, 'claimed', now())
             RETURNING *, $3::text AS kindergarten_name, $4::text AS province,
                       $5::text AS city, $6::text AS ownership`,
            [ref, self.realName, self.kgName, self.province, self.city,
              self.ownership])).rows[0];
        }

        const dup = (await client.query(
          `SELECT id FROM teachers WHERE phone = $1`, [phone])).rows[0];
        if (dup) {
          return { err: '这个手机号已经注册过了。要是你之前激活过，用手机号登录就行' };
        }

        // ---- 校验全过了，从这里开始写。四件事同生共死 ----
        // 码标记成已用但账号没建出来，老师就永远拿不到这个码了

        /* openid 留空 —— 那是小程序时代的列，web 端没有它。
           它已经放开 NOT NULL（022 迁移），新账号一律 NULL。

           ⚠️ `entry_source` 和 `kindergarten_name` 的取值分两条路：
             路径一：'roster'、kindergarten_name 由园所名带出来（下面补）
             路径二：'self'  、kindergarten_name 就是她自己填的那个 */
        const teacher = (await client.query(
          `INSERT INTO teachers
             (phone, password_hash, password_salt,
              real_name, position, class_name, kindergarten_id, age_group,
              kindergarten_name, entry_source,
              roster_entry_id, activated_at, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   COALESCE((SELECT name FROM kindergartens WHERE id = $7), $9),
                   $10,
                   $11, now(), now())
           RETURNING *`,
          [phone, hash, salt,
            entry.real_name, entry.position, entry.class_name,
            entry.kindergarten_id, entry.age_group,
            self ? self.kgName : null,
            self ? 'self' : 'roster',
            entry.id])).rows[0];

        await client.query(
          `UPDATE redemption_codes SET status = 'used', used_by = $1, used_at = now() WHERE id = $2`,
          [teacher.id, row.id]);

        /* claimed_openid 不再写了（web 端没有 openid）。
           「谁认领过这个位置」现在靠 claimed_by —— 它是指向 teachers 的外键，
           而 teachers 那一行是**留壳**的，注销之后 id 还在，所以这段历史接得上。

           ⚠️ **只在路径一跑。** 路径二那一行刚插进来时就已经是 `claimed` 了
           （她自己就是认领人，不存在「谁去认领它」），再 UPDATE 一次虽然结果一样，
           但等于同一件事写两遍 —— 以后改其中一处就会漏掉另一处。 */
        if (entryId) {
          await client.query(
            `UPDATE teacher_roster
                SET status = 'claimed', claimed_by = $1, claimed_at = now()
              WHERE id = $2`,
            [teacher.id, entry.id]);
        }

        await client.query(
          `INSERT INTO quota_grants (teacher_id, delta_text, delta_image, reason)
           VALUES ($1, $2, $3, $4)`,
          [teacher.id, row.init_text, row.init_image, row.grant_reason || '首次激活']);

        return { teacher, granted: { text: row.init_text, image: row.init_image } };
      });
    } catch (err) {
      /* 同一个手机号被两次**并发**的激活请求插进去。
         上面那句 SELECT 挡不住这个 —— 两个人（或她双击了提交按钮）
         在各自的快照里都看不到对方，唯一索引才是最后那道闸。
         不接住它就是一个 500，而这件事她完全看得懂。 */
      if (err?.code === '23505' && err?.constraint === 'teachers_phone_key') {
        throw badRequest('这个手机号已经注册过了。要是你之前激活过，用手机号登录就行');
      }
      throw err;
    }

    if (result.err) throw badRequest(result.err);

    // 日志里不记手机号和姓名（三条铁律）
    logger.info('account_activated', {
      teacher_id: result.teacher.id,
      kindergarten_id: result.teacher.kindergarten_id,
      granted_text: result.granted.text,
      granted_image: result.granted.image,
    });

    return ok(res, {
      kind: 'activate',
      // 建完直接给 token，免得她刚设完密码又要立刻用它登一次
      token: signToken(result.teacher.id, result.teacher.token_version),
      expires_in: config.jwt.expiresInSeconds,
      teacher: toTeacherDTO(result.teacher),
      quota: await getQuota(result.teacher.id),
      granted: result.granted,
    });
  })
);
