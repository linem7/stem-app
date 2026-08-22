/**
 * PostgreSQL 连接池。
 *
 * 为什么手写 SQL 不上 ORM：见 ADR-001。这个业务的查询就那么十几条，
 * SQL 直接可读、出问题能整句复制到 psql 里跑，比一层 ORM 抽象更好排查。
 */
import pg from 'pg';
import { config } from '../config.js';
import { logger, startTimer } from '../utils/logger.js';
import { AppError, ErrorCode } from '../utils/errors.js';

// BIGSERIAL 主键在 pg 里默认被当成字符串返回（因为 JS 数字精度只有 2^53）。
// 我们的 id 远达不到那个量级，转成 number 能让 JSON 里是 1024 而不是 "1024"，
// 这样前端拿到的类型跟 api-spec 的示例一致。
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// NUMERIC(3,2) 的 confidence 同理，默认是字符串
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

/* 🔴 **DATE（oid 1082）原样回字符串，不要让 pg 转成 Date 对象。**
   （2026-08-22 加，量出来的，不是预防性的。）

   pg 默认把 DATE 解析成**本地时区午夜**的 Date。东八区里
   `2026-09-01` 就成了 `2026-09-01T00:00+08:00`，`JSON.stringify` 按 UTC 序列化
   之后变成 `"2026-08-31T16:00:00.000Z"` —— 前端一 `.slice(0,10)` 就得到
   **8 月 31 日**，整整差一天。

   踩到的两处：
     · 园所的「起始合作日期」：填 9 月 1 日，列表显示 8 月 31 日
     · 任务的「截止日期」：这个更糟 —— 编辑弹窗把 8 月 31 日填回输入框，
       一保存就真的存成了 8 月 31 日。**每打开保存一次，截止日期往前退一天**，
       而且从头到尾不报错

   DATE 就是一个「哪一天」，它本来就没有时刻也没有时区，
   转成时间点这一步本身就是错的。回字符串是唯一不丢信息的形态。

   ⚠️ 改这行之前先想清楚：有两处对 deadline 做过日期算术
   （admin.js 的发布闸门、services/tasks.js 的 days_left）。
   两处都验算过：字符串走 `new Date('2026-09-05')` 是 UTC 午夜，
   跟本地午夜差 8 小时，而它们一个是比大小、一个是 Math.round 到天，
   8 小时的偏移改不了结果。再加新的日期算术时要重新验一遍。 */
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// 空闲连接被数据库单方面掐断是常态（云 RDS 会这么干）。
// 不监听这个事件的话，pg 会把它当成 uncaught exception 直接把进程带走。
pool.on('error', (err) => {
  logger.warn('db_idle_client_error', { message: err.message });
});

/**
 * 执行一条 SQL。
 * @param {string} text  带 $1 $2 占位符的 SQL（永远不要用字符串拼接参数，会 SQL 注入）
 * @param {Array} [params]
 */
export async function query(text, params) {
  const t = startTimer();
  try {
    const res = await pool.query(text, params);
    const ms = t();
    if (ms > 300) {
      // 只记 SQL 的第一行，不记参数 —— 参数里可能有对话正文
      logger.warn('db_slow_query', { ms, sql: text.trim().split('\n')[0].slice(0, 120) });
    }
    return res;
  } catch (err) {
    logger.error('db_query_failed', {
      sql: text.trim().split('\n')[0].slice(0, 120),
      pg_code: err.code,
      message: err.message,
    });
    throw new AppError(ErrorCode.INTERNAL, { detail: { pg_code: err.code }, cause: err });
  }
}

/** 取一行或 null */
export async function queryOne(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

/**
 * 事务。回调里拿到的 client 有自己的 query 方法。
 * 用法：await withTransaction(async (c) => { await c.query(...) })
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 回滚失败通常意味着连接已断，忽略即可，原始错误更重要 */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 启动时探活。连不上就给一段能看懂的中文，而不是 ECONNREFUSED 一串栈。
 */
export async function pingDatabase() {
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    const hints = {
      ECONNREFUSED: '连不上数据库。检查：① PostgreSQL 服务是不是启动了 ② .env 里 DATABASE_URL 的主机和端口对不对',
      ENOTFOUND: '数据库主机名解析不了。检查 .env 里 DATABASE_URL 的主机地址有没有写错。',
      '28P01': '数据库用户名或密码不对。检查 .env 里 DATABASE_URL 中 : 和 @ 之间的那段密码。',
      '3D000': '数据库不存在。先建库：createdb stem_app（或在图形工具里新建同名数据库）。',
      ETIMEDOUT: '连接数据库超时。云数据库要检查白名单/安全组有没有放行你的 IP。',
    };
    const hint = hints[err.code] || `数据库连接失败：${err.message}`;
    return { ok: false, hint, code: err.code };
  }
}

export async function closePool() {
  await pool.end();
}
