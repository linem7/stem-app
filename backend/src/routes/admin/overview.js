import { Router } from 'express';
import { query, queryOne } from '../../db/pool.js';
import { ok, asyncRoute } from '../../utils/errors.js';
import { getMoney } from '../../services/costLedger.js';

export const overviewRouter = Router();

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
overviewRouter.get(
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
