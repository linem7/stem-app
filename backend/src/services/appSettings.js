/**
 * 运行期设置 —— 后台改完立刻生效，不用重启（app_settings 表）。
 *
 * 只放**运营参数**，不放密钥。目前就一个键：
 *   image_provider —— 配图默认用哪个模型
 *
 * 优先级：数据库 > .env > 代码默认。这个顺序是有意的 ——
 * 全新部署时数据库里什么都没有，靠 .env 兜底照样能跑；
 * 后台设过一次之后，以数据库为准（否则「我明明在后台改了却没变」）。
 */
import { query, queryOne } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/**
 * 内存缓存。
 *
 * 每张图都要读一次这个值，而它一天可能改一次，不该每次都打数据库。
 * 但也**不能永久缓存**：后台改完要立刻生效，不然还是得重启，白改。
 * 30 秒是个折中 —— 后台改完最多等半分钟；写入时会主动清掉，所以一般是立即生效。
 */
const TTL_MS = 30000;
const cache = new Map();

export async function getSetting(key, fallback = '') {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  try {
    const row = await queryOne(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    const value = row?.value ?? fallback;
    cache.set(key, { value, until: Date.now() + TTL_MS });
    return value;
  } catch (err) {
    // 表还没建（迁移没跑）时不该让业务瘫掉，退回 .env 那一档
    logger.warn('app_setting_read_failed', { key, message: err.message });
    return fallback;
  }
}

export async function setSetting(key, value, adminId = null) {
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
    [key, String(value), adminId]
  );
  // 主动清缓存，不等 TTL —— 后台点完「设为默认」，下一张图就该用新的
  cache.delete(key);
}

export const SETTING_KEYS = {
  imageProvider: 'image_provider',
  /* .env 里那两家配图模型有没有播种进 image_models 表（2026-08-22）。
     这个键**只是一个一次性的标记**，不是运营参数 ——
     它存在的全部理由是：播种之后就不再读 .env 了，
     否则在后台删掉的模型下次重启会自己回来（见 imageModels.js 文件头）。 */
  envModelsSeeded: 'env_models_seeded',
};
