import { Router } from 'express';
import { query, queryOne } from '../../db/pool.js';
import { ok, asyncRoute, badRequest, notFound } from '../../utils/errors.js';
import { logAction } from '../../services/admins.js';
import { previewTarget, normalizeTarget, taskAudience } from '../../services/tasks.js';
import { logger } from '../../utils/logger.js';
import { maskName } from './_shared.js';

export const tasksRouter = Router();

// ---------------------------------------------------------------
// 任务 —— 告诉老师现在有什么活动可以换额度（012 迁移）
//
// **任务不自动发额度**（用户定的）。它只承诺，到账靠我事后核对答卷、
// 建码发给她，她自己兑。系统不去猜「她是不是真填了」——
// 答卷在问卷星，我们库里没有。
// ---------------------------------------------------------------
tasksRouter.get('/tasks', asyncRoute(async (req, res) => {
  const rows = (await query(`
    SELECT s.*, a.display_name AS created_by_name,
           (SELECT COUNT(*)::int FROM task_reads r WHERE r.task_id = s.id) AS reads
      FROM tasks s LEFT JOIN admins a ON a.id = s.created_by
     ORDER BY s.status = 'open' DESC, s.created_at DESC LIMIT 200`)).rows;

  // 🔴 **这一页不再逐个试算覆盖人数**（2026-08-22）。
  // 「覆盖」那一列撤掉了（用户定，列表改成 标题/奖励/城市/办园性质/截止/状态），
  // 而算它是一个任务两条查询的 N+1 —— 20 个任务就是 40 条，
  // 只为了一个已经不显示的数。
  //
  // 试算没有消失，它在真正要它的两个地方：
  //   · 发送前的确认框（`POST /tasks/preview`，必然跑一次）
  //   · 任务详情（`GET /tasks/:id`，那一屏的主题就是「筛出了什么样的一群人」）
  // 这里只把 target 洗成规范形状，好让列表能显示城市和办园性质
  const items = rows.map((s) => ({
    id: s.id, title: s.title, body: s.body, survey_url: s.survey_url,
    reward_text: s.reward_text, reward_image: s.reward_image,
    deadline: s.deadline, status: s.status, target: normalizeTarget(s.target),
    reads: s.reads, created_by_name: s.created_by_name, created_at: s.created_at,
  }));
  return ok(res, { items });
}));

/**
 * 试算覆盖人数。
 *
 * **不是锦上添花**：定向条件叠到六层之后不试算没法确认筛对了，
 * 而发错是发给真人的。跟老师端 `GET /tasks` 共用 `buildMatchSql` ——
 * 写两份迟早分叉，分叉的表现是「后台说发给 12 个人，实际只有 8 个人看到」。
 */
tasksRouter.post('/tasks/preview', asyncRoute(async (req, res) =>
  ok(res, await previewTarget(req.body?.target))));

function pickTask(b, cur = {}) {
  const str = (k, max) => (b[k] === undefined
    ? cur[k] ?? null : String(b[k]).trim().slice(0, max) || null);
  const num = (k) => {
    if (b[k] === undefined) return cur[k] ?? 0;
    const n = Number(b[k]);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  };
  const url = str('survey_url', 500);
  // 问卷链接要能点开，所以必须是 http(s)。填了个「见群里」之类的东西
  // 界面上就会变成一个点不动的链接，而她不会知道为什么
  if (url && !/^https?:\/\//i.test(url)) {
    throw badRequest('问卷链接要以 http:// 或 https:// 开头');
  }
  return {
    title: str('title', 64),
    body: b.body === undefined ? cur.body ?? null : String(b.body).trim().slice(0, 2000) || null,
    survey_url: url,
    reward_text: num('reward_text'),
    reward_image: num('reward_image'),
    deadline: b.deadline === undefined ? cur.deadline ?? null : String(b.deadline).trim() || null,
    target: b.target === undefined ? normalizeTarget(cur.target) : normalizeTarget(b.target),
  };
}

tasksRouter.post('/tasks', asyncRoute(async (req, res) => {
  const t = pickTask(req.body || {});
  if (!t.title) throw badRequest('给任务起个标题');
  // 建出来是**草稿**，不是直接发布 —— 发布是另一个动作，
  // 中间那一步就是给我机会试算一遍覆盖人数
  const row = await queryOne(
    `INSERT INTO tasks (title, body, survey_url, reward_text, reward_image,
                        deadline, target, created_by, status)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::jsonb,$8,'draft') RETURNING *`,
    [t.title, t.body, t.survey_url, t.reward_text, t.reward_image, t.deadline,
      JSON.stringify(t.target), req.adminId]);
  await logAction({ adminId: req.adminId, action: 'create_task', target: `task:${row.id}`,
    detail: { title: row.title } });
  return ok(res, row);
}));

/**
 * 一个任务的详情与覆盖人群（2026-08-21）。
 *
 * 列表上撤掉了「发给谁」和「看过的」两列（定向勾了六个维度，一列写不清），
 * 那两件事挪到这里 —— 而且这里能回答一个列表回答不了的问题：
 * **勾的那些条件实际筛出了什么样的一群人。**
 *
 * 姓名按权限打码（跟老师页同一条纪律）。已读时间不是内容，一般管理员也能看：
 * 「这条通知有没有人看见」是运营要判断的事。
 */
tasksRouter.get('/tasks/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const task = await queryOne(`SELECT * FROM tasks WHERE id = $1`, [id]);
  if (!task) throw notFound('没有这个任务');
  const a = await taskAudience(task);
  return ok(res, {
    task: {
      id: task.id, title: task.title, body: task.body, survey_url: task.survey_url,
      reward_text: task.reward_text, reward_image: task.reward_image,
      deadline: task.deadline, status: task.status, target: task.target,
      created_at: task.created_at,
    },
    covers: a.covers,
    reads: a.reads,
    unrestricted: a.unrestricted,
    breakdown: a.breakdown,
    teachers: a.teachers.map((t) => ({
      ...t,
      real_name: maskName(t.real_name, req.isSuper),
      name_masked: !req.isSuper,
    })),
  });
}));

tasksRouter.post('/tasks/:id/update', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await queryOne(`SELECT * FROM tasks WHERE id = $1`, [id]);
  if (!cur) throw notFound('没有这个任务');
  const t = pickTask(req.body || {}, cur);
  if (!t.title) throw badRequest('标题不能空');

  const row = await queryOne(
    `UPDATE tasks SET title=$2, body=$3, survey_url=$4, reward_text=$5, reward_image=$6,
            deadline=$7::date, target=$8::jsonb, updated_at=now()
      WHERE id=$1 RETURNING *`,
    [id, t.title, t.body, t.survey_url, t.reward_text, t.reward_image, t.deadline,
      JSON.stringify(t.target)]);
  await logAction({ adminId: req.adminId, action: 'update_task', target: `task:${id}` });
  return ok(res, row);
}));

tasksRouter.post('/tasks/:id/publish', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await queryOne(`SELECT * FROM tasks WHERE id = $1`, [id]);
  if (!cur) throw notFound('没有这个任务');
  if (cur.status === 'open') throw badRequest('这个任务已经发布了');
  // 过了截止日期再发布，老师那边一条都看不到（列表按 deadline >= today 筛）——
  // 那是「发布成功了但没人收到」，最难查的一种
  if (cur.deadline && new Date(cur.deadline) < new Date(new Date().toDateString())) {
    throw badRequest('截止日期已经过了，改一下日期再发布');
  }
  const row = await queryOne(
    `UPDATE tasks SET status='open', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
  const p = await previewTarget(row.target);
  await logAction({ adminId: req.adminId, action: 'publish_task', target: `task:${id}`,
    detail: { covers: p.teachers } });
  logger.info('task_published', { by: req.adminId, task_id: id, covers: p.teachers });
  return ok(res, { ...row, covers: p.teachers });
}));

tasksRouter.post('/tasks/:id/close', asyncRoute(async (req, res) => {
  const row = await queryOne(
    `UPDATE tasks SET status='closed', updated_at=now() WHERE id=$1 RETURNING id, status`,
    [Number(req.params.id)]);
  if (!row) throw notFound('没有这个任务');
  await logAction({ adminId: req.adminId, action: 'close_task', target: `task:${row.id}` });
  return ok(res, row);
}));
