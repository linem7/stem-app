/**
 * 额度：发放台账 + 从事实表派生的消耗。
 *
 * 核心决定（operations.md 第 3 节）：**余额是算出来的，不是存出来的**。
 *
 *     余额 = Σ(quota_grants 的发放) − 消耗(数 lesson_plans / lesson_images)
 *
 * 不存 balance 字段的理由很实际：那样就有了两份事实，而它们迟早对不上 ——
 * 某次生成失败后忘了退、某次并发扣了两次、某次手动改库改错了。
 * 到那时谁都说不清哪个是对的，而这是要拿去跟老师对账的数。
 * 台账 + 事实表任何时刻都能重算，还能回答「她为什么有 40 次额度」。
 *
 * 代价是每次查余额要跑三个聚合查询。这个量级（几十位老师）完全无所谓。
 */
import { query, queryOne } from '../db/pool.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * 每份教案免费改稿次数（2026-08-17 用户拍板）。
 *
 * 不需要新字段：lesson_plans.version 本来就随改稿 +1（初稿 v1，改一次 v2，再改 v3），
 * 所以「第 3 次改稿」= version 变成 4 的那次。消耗数 = max(0, version − 3)。
 * 从既有数据直接算，不引入会漂移的计数器。
 */
export const FREE_REVISIONS = 2;
/** version ≤ 这个值都不额外计费（初稿那 1 次已经在 count 里算过了） */
const FREE_VERSION_CEILING = 1 + FREE_REVISIONS;

/**
 * 查某位老师的额度。
 * @returns {Promise<{text:{granted,used,left}, image:{granted,used,left}}>}
 */
export async function getQuota(teacherId) {
  const granted = await queryOne(
    `SELECT COALESCE(SUM(delta_text),0)::int  AS text,
            COALESCE(SUM(delta_image),0)::int AS image
       FROM quota_grants WHERE teacher_id = $1`,
    [teacherId]
  );

  // 文案消耗 = 教案份数 + 超出免费额度的改稿次数
  const textUsed = await queryOne(
    `SELECT COUNT(*)::int AS plans,
            COALESCE(SUM(GREATEST(0, version - $2)),0)::int AS extra_revisions
       FROM lesson_plans WHERE teacher_id = $1`,
    [teacherId, FREE_VERSION_CEILING]
  );

  // 配图消耗只数成功的：失败的那次不该让老师买单
  const imageUsed = await queryOne(
    `SELECT COUNT(*)::int AS n
       FROM lesson_images i
       JOIN lesson_plans p ON p.id = i.lesson_plan_id
      WHERE p.teacher_id = $1 AND i.status = 'ready'`,
    [teacherId]
  );

  const tUsed = textUsed.plans + textUsed.extra_revisions;
  const iUsed = imageUsed.n;

  return {
    text:  { granted: granted.text,  used: tUsed, left: granted.text  - tUsed },
    image: { granted: granted.image, used: iUsed, left: granted.image - iUsed },
  };
}

/** 发一笔额度。reason 必填 —— 它既是对账依据，也是研究记录。 */
export async function grantQuota({ teacherId, deltaText = 0, deltaImage = 0, reason }) {
  if (!reason || !String(reason).trim()) {
    throw new Error('发额度必须写原因');
  }
  const row = await queryOne(
    `INSERT INTO quota_grants (teacher_id, delta_text, delta_image, reason)
     VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [teacherId, deltaText, deltaImage, String(reason).trim().slice(0, 64)]
  );
  // 字段名不能叫 text —— logger 的脱敏名单里有它（防对话正文进日志），
  // 叫 text 的字段一律只记长度，20 会被记成 text_len:2
  logger.info('quota_granted', {
    teacher_id: teacherId, delta_text: deltaText, delta_image: deltaImage, reason,
  });
  return row;
}

/** 台账明细，给「我的」页展示 —— 老师能对账，额度就不是黑箱 */
export async function listGrants(teacherId, limit = 20) {
  const res = await query(
    `SELECT delta_text, delta_image, reason, created_at
       FROM quota_grants WHERE teacher_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [teacherId, limit]
  );
  return res.rows;
}

/**
 * 闸门。不够就抛一个带出路的错误 ——
 * 「额度用完了」如果不告诉她怎么才能有，就只是个死胡同。
 */
export async function assertQuota(teacherId, kind) {
  const q = await getQuota(teacherId);
  const left = kind === 'image' ? q.image.left : q.text.left;
  if (left > 0) return q;

  throw new AppError(ErrorCode.QUOTA_EXCEEDED, {
    message: kind === 'image'
      ? '这个月的配图额度用完了 —— 完成问卷任务可以再拿一些，找发你兑换码的那位就行'
      : '这个月的教案额度用完了 —— 完成问卷任务可以再拿一些，找发你兑换码的那位就行',
    detail: { kind, granted: kind === 'image' ? q.image.granted : q.text.granted },
  });
}

/**
 * 改稿要不要收费：下一版的 version 超过免费线才收。
 * 在 revise 那条路上单独用，因为它跟「生成新教案」的计费规则不一样。
 */
export async function assertReviseQuota(teacherId, currentVersion) {
  if (currentVersion + 1 <= FREE_VERSION_CEILING) return null;  // 还在免费次数里
  return assertQuota(teacherId, 'text');
}
