/**
 * 极简迁移执行器：`npm run migrate`
 *
 * 为什么不用 node-pg-migrate：db-schema.md 推荐了它，但它带来一套 CLI 约定和 JS 迁移文件格式，
 * 对「带着 AI 开发的非专业开发者」是额外的心智负担。这里的规则只有三条：
 *   1. migrations/ 目录下放 .sql 文件，按文件名排序执行
 *   2. 执行过的文件名记在 schema_migrations 表里，不会重复执行
 *   3. 每个文件在一个事务里跑，中途失败就整体回滚，库不会停在半截状态
 * 唯一的纪律要求：已经跑过的迁移文件不许再改，要改就新建 002_xxx.sql。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertConfigOrExit } from '../config.js';
import { pool, pingDatabase, closePool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, 'migrations');

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(255) PRIMARY KEY,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations({ silent = false } = {}) {
  const log = silent ? () => {} : (...a) => console.log(...a);

  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 001_ 002_ 这样命名，字符串排序就是执行顺序

  const client = await pool.connect();
  let applied = 0;
  try {
    await ensureMigrationTable(client);
    const done = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
    );

    for (const file of files) {
      if (done.has(file)) {
        log(`  跳过 ${file}（之前已执行）`);
        continue;
      }
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      log(`  执行 ${file} ...`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied += 1;
        log(`  完成 ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`迁移文件 ${file} 执行失败，数据库已回滚到执行前的状态。\n  原因：${err.message}`);
      }
    }
  } finally {
    client.release();
  }
  return { applied, total: files.length };
}

// 只有直接 `node src/db/migrate.js` 才走下面这段；被 import 时不执行。
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  assertConfigOrExit();
  console.log(`\n准备迁移数据库：${maskUrl(config.db.url)}\n`);

  const ping = await pingDatabase();
  if (!ping.ok) {
    console.error(`\n数据库连不上，迁移中止。\n  ${ping.hint}\n`);
    await closePool();
    process.exit(1);
  }

  try {
    const { applied, total } = await runMigrations();
    console.log(
      applied === 0
        ? `\n数据库已经是最新的，没有需要执行的迁移（共 ${total} 个迁移文件）。\n`
        : `\n迁移完成：本次执行了 ${applied} 个文件，共 ${total} 个。\n`
    );
    await closePool();
    process.exit(0);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    await closePool();
    process.exit(1);
  }
}

/** 打印连接串时把密码遮掉，避免密码出现在终端记录或截图里 */
function maskUrl(url) {
  if (!url) return '(未配置)';
  return url.replace(/:\/\/([^:]+):([^@]*)@/, '://$1:****@');
}
