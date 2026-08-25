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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertConfigOrExit } from './config.js';
import { pingDatabase, query, closePool } from './db/pool.js';
import { requireAuth, requireActivated } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { recoverStuckTasks, taskQueue } from './services/taskQueue.js';
import { seedEnvModels, anyModelReady, pickModel } from './services/modelRegistry.js';
import { logger, startTimer } from './utils/logger.js';

import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { conversationsRouter } from './routes/conversations.js';
import { generateRouter } from './routes/generate.js';
import { lessonPlansRouter } from './routes/lessonPlans.js';
import { imagesRouter } from './routes/images.js';
import { reviseRouter } from './routes/revise.js';
import { memoriesRouter } from './routes/memories.js';
import { accountRouter } from './routes/account.js';
import { feedbackRouter } from './routes/feedback.js';
import { tasksRouter } from './routes/tasks.js';
import { adminRouter, requireAdmin } from './routes/admin.js';
import { ensureSuperAdmin } from './services/admins.js';

// ---------------------------------------------------------------
// 1. 环境变量
// ---------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));

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

/* .env 里的模型 → ai_models 表，**一次性播种**（配图 2026-08-22，文本 2026-08-23）。
   播完之后就再也不读 .env 了，所以后台能真正编辑和删除它们
   （只要还会读 .env，删掉的下次重启就会自己回来）。
   已经播过就是个空操作，重启多少次都只发生一次。见 modelRegistry.js 文件头。 */
const seed = await seedEnvModels();
if (seed.image.seeded) {
  console.log(`  已把 .env 里的配图模型搬进数据库：${seed.image.keys.join(', ')}（以后在后台改）`);
}
if (seed.text.seeded) {
  console.log(`  已把 .env 里的文本模型搬进数据库：${seed.text.keys.join(', ')}（以后在后台改）`);
}

/* 没有可用的文本模型就不启动 —— 教案生成是核心功能，没它起来也没意义。
   这条检查以前是 config.js 里「DEEPSEEK_API_KEY 必填」，模型进库之后语义变了：
   老库里模型早就在库里，.env 空着也该能启动；全新部署缺 key 才该拦。
   后台有对应的红线（最后一个启用的文本模型不许删、不许停用），
   所以正常操作走不到这里 —— 走到了多半是下面第 2 条。 */
/* 配图没有同款硬闸（没配图模型只是画不了图），但要说出来 ——
   老库 021 没跑时会走到这里：配图的播种标记早是 1（只读库），而库里表名还是旧的，
   于是列表静默变空，老师看到的是「配图功能还没开通」。不提示就查不到根因。 */
if (!(await anyModelReady('image'))) {
  console.warn(
    '\n[提醒] 一个可用的配图模型都没有，配图功能会显示「还没开通」。' +
      '\n       刚升级的话先跑一次 npm run migrate；否则去后台「模型管理」检查配图那一栏。\n'
  );
}

if (!(await anyModelReady('text'))) {
  console.error(
    [
      '',
      '════════════════════════════════════════════════════════',
      ' 启动失败：一个可用的文本模型都没有',
      '════════════════════════════════════════════════════════',
      '',
      '  教案的生成、改稿、出题全靠文本模型，没有它服务起来也没意义。逐条排查：',
      '',
      '  1. 全新部署：在 backend/.env 里配 DEEPSEEK_API_KEY',
      '     （platform.deepseek.com → API keys → 创建，并先充值一点余额）',
      '  2. 刚升级：先跑一次 npm run migrate（021 会把模型表升级成 ai_models）',
      '  3. 都不是：查 ai_models 表里 kind=\'text\' 的行是不是全被停用或删掉了',
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

// 没有任何管理员账号时，用 .env 的 ADMIN_PASSWORD 建一个 username=admin 的超管。
// 不做这一步的话，升级到多账号之后没人能登进后台，得手动改库才能救 —— 那是很糟的死锁。
await ensureSuperAdmin();

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

// 没配对象存储时，配图存在本地磁盘，靠这条静态路由提供访问（见 minimax.js 的 uploadImage）。
// 只在开发期成立：多实例部署时各存各的，必须配上 OBJECT_STORAGE_*。
if (!config.storage.configured) {
  app.use('/local-images', express.static(config.localImageDir, { maxAge: '7d', fallthrough: true }));
}

// api-spec 里 Base URL 带 /v1。同时挂 /v1 和根路径：
// 前端按文档用 /v1，你自己用 curl 调试时懒得敲 /v1 也能通。
const v1 = express.Router();

v1.use('/auth', authRouter); // 唯一不需要登录的
// 兑换码激活和协议：要登录，但**不能**要求已激活 —— 否则是「要激活才能激活」的死循环。
// accountRouter 同时挂在 /auth（redeem）和 /me（agree、quota）下。
v1.use('/auth', requireAuth, accountRouter);
v1.use('/me', requireAuth, accountRouter);
v1.use('/me', requireAuth, meRouter);
// conversations 和 generate 都挂在 /conversations 下。
// 路径不冲突：generate 的是 /:id/generate 和 /:id/generate/status，比 /:id 多一段。
// 以下全部要求「已激活 + 已同意协议」
v1.use('/conversations', requireAuth, requireActivated, conversationsRouter);
v1.use('/conversations', requireAuth, requireActivated, generateRouter);
// lesson-plans 同理：images 的是 /:id/images[/...]
v1.use('/lesson-plans', requireAuth, requireActivated, lessonPlansRouter);
v1.use('/lesson-plans', requireAuth, requireActivated, imagesRouter);
// 改稿：/:id/revise 和 /:id/revise/answer，比 lessonPlansRouter 的 /:id 多一段，不冲突
v1.use('/lesson-plans', requireAuth, requireActivated, reviseRouter);
v1.use('/memories', requireAuth, requireActivated, memoriesRouter);
v1.use('/feedback', requireAuth, requireActivated, feedbackRouter);
// 任务：没激活的老师看任务没有意义，她连额度是什么都还不知道
v1.use('/tasks', requireAuth, requireActivated, tasksRouter);

app.use('/v1', v1);
app.use('/', v1);

// ---------------------------------------------------------------
// 管理后台。与小程序完全隔离：不同的登录、不同的 token、不同的守卫。
// 老师的 JWT 打不开这里（payload 里没有 role=admin），管理员 token 也调不了业务接口。
//
// 只有一个管理员账号 —— 系统里不存在「园所管理员」这种角色，
// 这是「你的幼儿园和园长看不到这里的任何东西」那句承诺的技术兑现。
// ---------------------------------------------------------------
const adminApi = express.Router();
adminApi.use((req, res, next) => {
  // 登录接口本身不能要求已登录，其余一律要
  if (req.path === '/login') return next();
  return requireAdmin(req, res, next);
});
adminApi.use(adminRouter);
app.use('/admin/api', adminApi);

// 后台页面是一个独立的静态 HTML，跟小程序不共享任何前端代码
app.use('/admin', express.static(path.join(here, '..', 'admin')));

app.use(notFoundHandler);
app.use(errorHandler);

// 横幅要显示的两行在这里先算好 —— listen 的回调不是 async，里面不能 await
const bannerTextModel = (await pickModel('text'))?.account?.model ?? '（未配置）';
const bannerImageReady = await anyModelReady('image');

const server = app.listen(config.port, () => {
  console.log(
    [
      '',
      '════════════════════════════════════════════════════════',
      ' 后端启动成功',
      '════════════════════════════════════════════════════════',
      `  地址：      http://localhost:${config.port}`,
      `  环境：      ${config.nodeEnv}`,
      `  文本模型：  ${bannerTextModel}`,
      `  配图：      ${bannerImageReady ? '已配置' : '未配置（不影响其他功能）'}`,
      `  内容安全：  ${config.wechat.contentCheckEnabled ? '开' : '关（上线前必须开）'}`,
      `  管理后台：  ${config.admin.configured ? `http://localhost:${config.port}/admin` : '未配置（设 ADMIN_PASSWORD 后可用）'}`,
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
