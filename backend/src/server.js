/**
 * 入口。启动顺序刻意做成「一步一步报清楚」：
 *   1. 检查环境变量  → 缺了就中文列出缺哪几项、去哪申请，然后退出
 *   2. 连数据库     → 连不上就告诉你可能是哪一步没做
 *   3. 检查表建了没  → 没建就提示先跑 npm run migrate
 *   4. 清理上次残留的任务
 *   5. 起 HTTP 服务
 * 任何一步失败都不抛英文栈。
 */
import express from 'express';
import { config, assertConfigOrExit } from './config.js';
import { pingDatabase, query, closePool } from './db/pool.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { recoverStuckTasks, taskQueue } from './services/taskQueue.js';
import { logger, startTimer } from './utils/logger.js';

import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { conversationsRouter } from './routes/conversations.js';
import { generateRouter } from './routes/generate.js';
import { lessonPlansRouter } from './routes/lessonPlans.js';
import { imagesRouter } from './routes/images.js';
import { memoriesRouter } from './routes/memories.js';

// ---------------------------------------------------------------
// 1. 环境变量
// ---------------------------------------------------------------
assertConfigOrExit();

// ---------------------------------------------------------------
// 2 & 3. 数据库
// ---------------------------------------------------------------
const ping = await pingDatabase();
if (!ping.ok) {
  console.error(
    [
      '',
      '════════════════════════════════════════════════════════',
      ' 启动失败：连不上数据库',
      '════════════════════════════════════════════════════════',
      '',
      `  ${ping.hint}`,
      '',
      '  详细步骤见 README.md 的「第一步：装数据库」',
      '════════════════════════════════════════════════════════',
      '',
    ].join('\n')
  );
  await closePool();
  process.exit(1);
}

try {
  await query('SELECT 1 FROM teachers LIMIT 1');
} catch {
  console.error(
    [
      '',
      '════════════════════════════════════════════════════════',
      ' 启动失败：数据库连上了，但表还没建',
      '════════════════════════════════════════════════════════',
      '',
      '  先执行一次迁移把表建出来：',
      '',
      '      npm run migrate',
      '',
      '  然后再 npm start',
      '════════════════════════════════════════════════════════',
      '',
    ].join('\n')
  );
  await closePool();
  process.exit(1);
}

// ---------------------------------------------------------------
// 4. 清理上次进程被杀时卡住的任务
// ---------------------------------------------------------------
await recoverStuckTasks();

// ---------------------------------------------------------------
// 5. HTTP
// ---------------------------------------------------------------
const app = express();

// 部署在 Nginx 后面时，要它才能拿到真实客户端 IP
app.set('trust proxy', 1);
// Express 默认会在响应头里写 X-Powered-By: Express，白送攻击者一条信息
app.disable('x-powered-by');

// 教案正文可能几千字，默认 100kb 够用，这里放到 256kb 留余量
app.use(express.json({ limit: '256kb' }));

/** 请求日志：只记方法、路径、状态、耗时、老师 id —— 不记 body（api-spec 第 10 节） */
app.use((req, res, next) => {
  const t = startTimer();
  res.on('finish', () => {
    // 健康检查每几秒一次，记下来只会淹没真正有用的日志
    if (req.path === '/healthz') return;
    logger.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: t(),
      teacher_id: req.teacherId,
    });
  });
  next();
});

/**
 * 健康检查。没有它就没法判断「服务是活的但数据库挂了」还是「服务本身没起来」。
 * 不需要登录，但也不返回任何敏感信息。
 */
app.get('/healthz', async (req, res) => {
  const db = await pingDatabase();
  res.status(db.ok ? 200 : 503).json({
    ok: db.ok,
    data: {
      service: 'stem-lesson-backend',
      db: db.ok ? 'up' : 'down',
      queue: taskQueue.stats(),
      time: new Date().toISOString(),
    },
  });
});

// api-spec 里 Base URL 带 /v1。同时挂 /v1 和根路径：
// 前端按文档用 /v1，你自己用 curl 调试时懒得敲 /v1 也能通。
const v1 = express.Router();

v1.use('/auth', authRouter); // 唯一不需要登录的
v1.use('/me', requireAuth, meRouter);
// conversations 和 generate 都挂在 /conversations 下。
// 路径不冲突：generate 的是 /:id/generate 和 /:id/generate/status，比 /:id 多一段。
v1.use('/conversations', requireAuth, conversationsRouter);
v1.use('/conversations', requireAuth, generateRouter);
// lesson-plans 同理：images 的是 /:id/images[/...]
v1.use('/lesson-plans', requireAuth, lessonPlansRouter);
v1.use('/lesson-plans', requireAuth, imagesRouter);
v1.use('/memories', requireAuth, memoriesRouter);

app.use('/v1', v1);
app.use('/', v1);

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(
    [
      '',
      '════════════════════════════════════════════════════════',
      ' 后端启动成功',
      '════════════════════════════════════════════════════════',
      `  地址：      http://localhost:${config.port}`,
      `  环境：      ${config.nodeEnv}`,
      `  文本模型：  ${config.deepseek.model}`,
      `  配图：      ${config.doubao.configured ? '已配置' : '未配置（不影响其他功能）'}`,
      `  内容安全：  ${config.wechat.contentCheckEnabled ? '开' : '关（上线前必须开）'}`,
      '',
      '  验证一下：',
      `      curl http://localhost:${config.port}/healthz`,
      '════════════════════════════════════════════════════════',
      '',
    ].join('\n')
  );
});

// ---------------------------------------------------------------
// 优雅退出：正在跑的教案生成任务不该被一刀切断
// ---------------------------------------------------------------
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_start', { signal, queue: taskQueue.stats() });

  server.close(async () => {
    // 给正在跑的任务 20 秒收尾（一次生成最多 30 秒，20 秒能救回大部分）
    const deadline = Date.now() + 20000;
    while (taskQueue.stats().running > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    await closePool();
    logger.info('shutdown_done', {});
    process.exit(0);
  });

  // 兜底：30 秒还没退干净就强退，免得 PM2 一直等
  setTimeout(() => process.exit(0), 30000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 兜底：任何没被 catch 的异常都记下来。
// 不 exit —— 单进程服务里，一个后台任务的疏漏不该让所有老师断线。
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { message: String(reason?.message || reason).slice(0, 300) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { message: String(err?.message).slice(0, 300) });
});
