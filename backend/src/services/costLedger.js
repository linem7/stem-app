/**
 * 平台自己的账：充了多少钱、花了多少、还剩多少。
 *
 * 起因（2026-08-18）：后台概览要回答「我账面上还剩多少」，而这个数以前算不出来 ——
 * 两头都缺。
 *
 *   · **收**：库里没有任何充值记录
 *   · **支**：只有配图成本。**文本成本一分钱都没记** ——
 *     `deepseek.js` 每次调用都拿到了 token 数，但只写进了日志。
 *     `messages` 表那两个 token 列存在却从来没被写过（240 行里 0 行有值）。
 *     而生成一份教案是最贵的那次调用，漏掉它，「花了多少」就是错的
 *
 * 跟额度台账（quota.js）同一个纪律：**余额是算出来的，不是存出来的**。
 *
 *     账面剩余 = Σ充值 − (Σ配图成本 + Σ文本成本)
 *
 * 不存 balance 字段是因为那样就有两份事实，迟早对不上 ——
 * 而这是要拿去跟真金白银对账的数。
 */
import { query, queryOne } from '../db/pool.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * 按当时的单价算这次调用花了多少分。
 *
 * **调用当时就算好存进库**，不留到查询时再乘：价格会变，
 * 留到查询时算意味着改一次常量、全部历史成本一起漂移。
 *
 * 不四舍五入到整分而是保留原始值再 round：单次调用常常不到 1 分，
 * 每次都 round 成 0 的话，一万次调用的总成本会是 0。
 * 所以这里返回的是**小数分**，落库前才 round —— 见 recordModelCall 的注释。
 */
export function estimateTextCostCents(tokenIn, tokenOut) {
  const cin = ((tokenIn || 0) / 1e6) * config.deepseek.priceInPerMTok;
  const cout = ((tokenOut || 0) / 1e6) * config.deepseek.priceOutPerMTok;
  return cin + cout;
}

/**
 * 记一次文本模型调用。
 *
 * 从 `deepseek.js` 的 chat() 里调 —— **一个地方覆盖全部调用点**
 * （引导出题、生成教案、自检、改稿追问、配图提示词、记忆提取，目前 7 处）。
 * 挂在每个调用点上就一定会漏掉新加的那个。
 *
 * **失败绝不能影响业务**：记账是旁路，它挂了老师照样该拿到教案。
 * 所以整个函数吞掉异常，只打一条 warn。
 */
export async function recordModelCall({
  teacherId = null, purpose = 'unknown', provider = 'deepseek',
  model = null, tokenIn = null, tokenOut = null,
}) {
  try {
    // 单次调用往往不到 1 分（一次问答约 0.1 分）。
    // 直接 round 会把它变成 0，于是一万次调用的总成本还是 0 —— 那就白记了。
    // 所以**不到 1 分的记 0，但把原始小数一起留在 token 数里**：
    // 汇总时用 SUM(token) 重算才是准的，cost_cents 只是给单行看的近似值。
    // 概览的总成本走 sumTextSpend()，它按 token 汇总后再乘价，不累积舍入误差。
    const cost = Math.round(estimateTextCostCents(tokenIn, tokenOut));
    await query(
      `INSERT INTO model_calls (teacher_id, purpose, provider, model, token_in, token_out, cost_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [teacherId, String(purpose).slice(0, 32), provider, model, tokenIn, tokenOut, cost]
    );
  } catch (err) {
    // 记账是旁路。它挂了老师照样该拿到教案 —— 绝不往上抛
    logger.warn('model_call_record_failed', { purpose, message: err.message });
  }
}

/**
 * 文本总花费。
 *
 * **按 token 汇总之后再乘单价**，不是把每行的 cost_cents 加起来 ——
 * 单次调用常常不到 1 分，逐行 round 之后求和会系统性偏低（大多数行是 0）。
 * 这是这个模块唯一一处容易算错又看不出来的地方。
 */
async function sumTextSpend(sinceSql = '') {
  const r = await queryOne(`
    SELECT COALESCE(SUM(token_in),0)::bigint  AS tin,
           COALESCE(SUM(token_out),0)::bigint AS tout
      FROM model_calls ${sinceSql}`);
  return Math.round(estimateTextCostCents(Number(r.tin), Number(r.tout)));
}

/**
 * 概览要的那一块钱。
 *
 * `text_tracked_since` 和 `images_missing_cost` **必须一起返回并显示出来**：
 * 文本成本是 2026-08-18（011 迁移）之后才开始记的，早期的配图也有一批没有成本记录。
 * 不说这件事，那个「花了多少」会被当成全部历史，而它不是。
 */
export async function getMoney() {
  const [topup, image, text, monthImage, monthText, since, missing] = await Promise.all([
    queryOne(`SELECT COALESCE(SUM(amount_cents),0)::int AS n FROM platform_topups`),
    queryOne(`SELECT COALESCE(SUM(cost_cents),0)::int AS n FROM lesson_images WHERE status = 'ready'`),
    sumTextSpend(),
    queryOne(`SELECT COALESCE(SUM(cost_cents),0)::int AS n FROM lesson_images
               WHERE status = 'ready' AND created_at >= date_trunc('month', now())`),
    sumTextSpend(`WHERE created_at >= date_trunc('month', now())`),
    queryOne(`SELECT MIN(created_at) AS d FROM model_calls`),
    // 早期那批图没有 cost_cents（换模型之前没记）。这个数是「我算出来的钱比实际少」的量级
    queryOne(`SELECT COUNT(*)::int AS n FROM lesson_images
               WHERE status = 'ready' AND cost_cents IS NULL`),
  ]);

  const spent = image.n + text;
  return {
    topup_cents: topup.n,
    spent_image_cents: image.n,
    spent_text_cents: text,
    spent_cents: spent,
    left_cents: topup.n - spent,
    month_image_cents: monthImage.n,
    month_text_cents: monthText,
    // 这两个是**诚实标注**，不是装饰：不说的话上面那些数会被当成全部历史
    text_tracked_since: since.d,
    images_missing_cost: missing.n,
  };
}

/** 充值台账。只追加：记错了记一笔负数冲账，不改历史 */
export async function listTopups() {
  return (await query(
    `SELECT t.*, a.display_name, a.username
       FROM platform_topups t LEFT JOIN admins a ON a.id = t.created_by
      ORDER BY t.occurred_on DESC, t.id DESC LIMIT 200`
  )).rows;
}

export const TOPUP_CHANNELS = ['deepseek', '12ai', 'minimax', 'other'];

export async function addTopup({ amountCents, channel, note, occurredOn, adminId }) {
  return queryOne(
    `INSERT INTO platform_topups (amount_cents, channel, note, occurred_on, created_by)
     VALUES ($1,$2,$3,COALESCE($4::date, current_date),$5) RETURNING *`,
    [amountCents, channel, note || null, occurredOn || null, adminId || null]
  );
}
