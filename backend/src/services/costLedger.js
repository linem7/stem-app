/**
 * 平台自己的账：**花了多少**。
 *
 * 起因（2026-08-18）：后台概览要回答「这东西花了我多少钱」，而支出侧当时是缺的 ——
 * 只有配图成本，**文本成本一分钱都没记**：`deepseek.js` 每次调用都拿到了
 * token 数，但只写进了日志；`messages` 表那两个 token 列存在却从来没被写过
 * （240 行里 0 行有值）。而生成一份教案是最贵的那次调用，漏掉它「花了多少」就是错的。
 *
 * 🔴 **2026-08-21：「充了多少 / 还剩多少」整个概念撤掉了**（用户定）。
 * 原来这里算 `账面剩余 = Σ充值 − Σ支出`，概览上一张卡显示余额、
 * 「要处理」里还有一条「账面只剩 X，该充值了」。现在只记支出。
 *
 * 为什么这是对的：余额那个数**永远不准**，而它看起来很准。
 * 充值靠手录（漏录一笔余额就虚高），而真实余额分散在 DeepSeek、12ai、
 * MiniMax 三个平台各自的后台里 —— 那三个数字才是能拿去对账的。
 * 我们这边算出来的是「我记得我充了多少减去我算出来花了多少」，
 * 两头都是估计值，凑出来的第三个数只会更不准。
 *
 * **支出这一侧不一样**：它是每次调用当场落库的事实（`model_calls`、
 * `lesson_images.cost_cents`），不依赖人记得录什么。所以它留着。
 *
 * `platform_topups` 那张表和库里已有的记录**没有删**，只是没有任何入口了。
 * 哪天要恢复，接口和 listTopups / addTopup 在 git 历史里。
 */
import { query, queryOne } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * 按这次调用用的那个模型的单价算花了多少分。
 *
 * **调用当时就算好存进库**，不留到查询时再乘：价格会变，
 * 留到查询时算意味着改一次常量、全部历史成本一起漂移。
 *
 * 单价从模型的 options 里来（分/百万token，后台可改）——
 * 各家不同价，用全局单价算出来的是错账。没填单价就返回 null，
 * cost_cents 落 NULL，概览上用 text_missing_cost 诚实标注，而不是记一个假 0。
 */
export function estimateTextCostCents(tokenIn, tokenOut, prices = {}) {
  const pin = Number(prices.priceInPerMTok);
  const pout = Number(prices.priceOutPerMTok);
  if (!Number.isFinite(pin) || !Number.isFinite(pout)) return null;
  return ((tokenIn || 0) / 1e6) * pin + ((tokenOut || 0) / 1e6) * pout;
}

/**
 * 记一次文本模型调用。
 *
 * 从 `textChat.js` 的 chat() 里调 —— **一个地方覆盖全部调用点**
 * （引导出题、每题一句回应、生成教案、自检、教案解读、改稿追问、
 * 配图提示词、记忆提取，目前 8 处）。
 * 挂在每个调用点上就一定会漏掉新加的那个。
 *
 * **失败绝不能影响业务**：记账是旁路，它挂了老师照样该拿到教案。
 * 所以整个函数吞掉异常，只打一条 warn。
 */
export async function recordModelCall({
  teacherId = null, purpose = 'unknown', provider = 'unknown',
  model = null, tokenIn = null, tokenOut = null,
  priceInPerMTok = null, priceOutPerMTok = null,
}) {
  try {
    // cost_cents 是 NUMERIC(12,4)，存**小数分**不 round（021 迁移改的）：
    // 单次调用约 0.1 分，逐行 round 成整数的话一万次调用的总成本还是 0。
    // 汇总直接 SUM(cost_cents)，最后一步才 round。
    const cost = estimateTextCostCents(tokenIn, tokenOut, { priceInPerMTok, priceOutPerMTok });
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
 * 直接 SUM(cost_cents)（021 之后是小数分，历史行已按当时单价回填），
 * 最后一步才 round —— 不能再按 SUM(token)×全局单价：
 * 混了两家厂商之后「总 token × 一个价」在数学上就不成立了。
 */
async function sumTextSpend(sinceSql = '') {
  const r = await queryOne(`
    SELECT COALESCE(SUM(cost_cents), 0)::numeric AS c
      FROM model_calls ${sinceSql}`);
  return Math.round(Number(r.c));
}

/**
 * 概览要的那一块钱。
 *
 * `text_tracked_since` 和 `images_missing_cost` **必须一起返回并显示出来**：
 * 文本成本是 2026-08-18（011 迁移）之后才开始记的，早期的配图也有一批没有成本记录。
 * 不说这件事，那个「花了多少」会被当成全部历史，而它不是。
 */
export async function getMoney() {
  const [image, text, monthImage, monthText, since, missing, textMissing] = await Promise.all([
    queryOne(`SELECT COALESCE(SUM(cost_cents),0)::int AS n FROM lesson_images WHERE status = 'ready'`),
    sumTextSpend(),
    queryOne(`SELECT COALESCE(SUM(cost_cents),0)::int AS n FROM lesson_images
               WHERE status = 'ready' AND created_at >= date_trunc('month', now())`),
    sumTextSpend(`WHERE created_at >= date_trunc('month', now())`),
    queryOne(`SELECT MIN(created_at) AS d FROM model_calls`),
    // 早期那批图没有 cost_cents（换模型之前没记）。这个数是「我算出来的钱比实际少」的量级
    queryOne(`SELECT COUNT(*)::int AS n FROM lesson_images
               WHERE status = 'ready' AND cost_cents IS NULL`),
    // 没填单价的模型记的账 cost 是 NULL —— 同一类诚实标注
    queryOne(`SELECT COUNT(*)::int AS n FROM model_calls WHERE cost_cents IS NULL`),
  ]);

  // 没有 topup_cents / left_cents 了（2026-08-21）。**别加回去** ——
  // 加回来就得有人手录充值，而漏录一笔余额就静静地虚高
  return {
    spent_image_cents: image.n,
    spent_text_cents: text,
    spent_cents: image.n + text,
    month_image_cents: monthImage.n,
    month_text_cents: monthText,
    month_cents: monthImage.n + monthText,
    // 这几个是**诚实标注**，不是装饰：不说的话上面那些数会被当成全部历史
    text_tracked_since: since.d,
    images_missing_cost: missing.n,
    text_missing_cost: textMissing.n,
  };
}
