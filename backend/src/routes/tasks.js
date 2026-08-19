/**
 * 老师端的任务 —— api-spec 第 1.5 节
 *
 *   GET  /tasks            我能看到的、还没过期的
 *   POST /tasks/:id/read   标已读
 *
 * 挂在 requireAuth + requireActivated 后面：没激活的老师看任务没有意义，
 * 她连额度是什么都还不知道。
 *
 * **任务和奖励是断开的**：任务只承诺「填完给 20 次教案」，
 * 到账靠我事后核对答卷、建码发给她，她自己兑。
 * 系统不去猜「她是不是真填了」—— 答卷在问卷星，我们库里没有。
 */
import { Router } from 'express';
import { ok, asyncRoute, notFound } from '../utils/errors.js';
import { listTasksFor, markRead } from '../services/tasks.js';
import { queryOne } from '../db/pool.js';

export const tasksRouter = Router();

tasksRouter.get(
  '/',
  asyncRoute(async (req, res) => ok(res, await listTasksFor(req.teacherId)))
);

tasksRouter.post(
  '/:id/read',
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    // 只对确实存在且已发布的任务标已读 —— 拿一个乱填的 id 进来不该写脏数据
    const t = await queryOne(`SELECT id FROM tasks WHERE id = $1 AND status = 'open'`, [id]);
    if (!t) throw notFound('没有这个任务');
    await markRead(id, req.teacherId);
    return ok(res, { read: true });
  })
);
