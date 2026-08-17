/**
 * 限流（api-spec 第 10 节）。
 *
 *   POST /conversations            每人每小时 10 次
 *   POST .../generate              每人每小时 20 次
 *   POST .../images                每人每天  10 张
 *
 * 两种实现，各有各的道理：
 *
 * 1) 前两个用「进程内计数」。ADR-001 明确不上 Redis，单进程部署下内存计数够用；
 *    重启会清零，但重启不是常态，且这两个限额是防手滑刷接口，不是防攻击。
 *
 * 2) 配图上限用「查数据库」。因为图片直接花钱，是最需要硬保证的一个闸门，
 *    进程一重启额度就重置是不可接受的。lesson_images 表里本来就有记录，直接 COUNT 即可。
 *
 * 日后要上多进程（PM2 cluster）时，把 1) 换成 Redis 计数即可，接口不用动。
 */
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** key -> { count, resetAt } */
const buckets = new Map();

// 定期清理过期桶，避免长期运行内存里堆满历史 key。
// unref() 让这个定时器不阻止进程退出。
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}, 10 * 60 * 1000);
if (typeof sweeper.unref === 'function') sweeper.unref();

/**
 * 固定窗口计数器。
 * 为什么用固定窗口而不是滑动窗口：窗口边界上最多放行 2 倍额度，
 * 对「防手滑」这个目的完全够用，而实现只要几行、不用存时间戳数组。
 */
function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return { allowed: b.count <= limit, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
}

/**
 * 生成一个限流中间件。
 * @param {object} o
 * @param {string} o.name       桶名，用于区分不同接口
 * @param {number} o.limit
 * @param {number} o.windowMs
 * @param {string} [o.message]  给老师看的中文（比通用文案更具体时才覆盖）
 */
export function rateLimit({ name, limit, windowMs, message }) {
  return (req, res, next) => {
    // 未登录的请求走不到这里（限流中间件永远挂在 requireAuth 之后）
    const key = `${name}:${req.teacherId}`;
    const { allowed, retryAfterSec } = hit(key, limit, windowMs);
    if (allowed) return next();

    res.set('Retry-After', String(retryAfterSec));
    logger.warn('rate_limited', { bucket: name, teacher_id: req.teacherId, limit });
    next(new AppError(ErrorCode.RATE_LIMITED, { message, detail: { bucket: name, limit } }));
  };
}

const HOUR = 60 * 60 * 1000;

/** POST /conversations —— 每小时 10 次 */
export const limitNewConversation = rateLimit({
  name: 'conv_create',
  limit: 10,
  windowMs: HOUR,
  message: '新建教案有点频繁，休息一会儿再来',
});

/** POST /conversations/:id/generate —— 每小时 20 次 */
export const limitGenerate = rateLimit({
  name: 'generate',
  limit: 20,
  windowMs: HOUR,
  message: '生成得有点频繁，等一小时再试',
});

/**
 * 配图每日上限：查库计数。
 * 注意 `date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai')` ——
 * 老师在北京时间的一天里用了几张，按 UTC 算会在凌晨 8 点前后错位。
 * @returns {Promise<{used:number, limit:number}>}
 * @throws {AppError} 超限时抛 RATE_LIMITED
 */
export async function assertImageQuota(teacherId) {
  const limit = config.minimax.dailyLimit;
  const res = await query(
    `SELECT COUNT(*)::int AS used
       FROM lesson_images i
       JOIN lesson_plans p ON p.id = i.lesson_plan_id
      WHERE p.teacher_id = $1
        AND i.status <> 'failed'
        AND (i.created_at AT TIME ZONE 'Asia/Shanghai')::date
            = (now() AT TIME ZONE 'Asia/Shanghai')::date`,
    [teacherId]
  );
  const used = res.rows[0]?.used ?? 0;
  if (used >= limit) {
    logger.warn('image_quota_exceeded', { teacher_id: teacherId, used, limit });
    throw new AppError(ErrorCode.RATE_LIMITED, {
      message: `今天的配图次数用完了（每天 ${limit} 张），明天再来吧`,
      detail: { used, limit },
    });
  }
  return { used, limit };
}
