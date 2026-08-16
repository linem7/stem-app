/**
 * 进程内异步任务队列（ADR-001：不上消息队列）。
 *
 * 为什么需要它：教案生成 15-30 秒，微信小程序的请求会超时。
 * 所以接口立刻返回 task_id，真正的活儿放到这里慢慢干，前端轮询查状态。
 *
 * 为什么这么简单也够用：
 * 单进程 + 数据库状态表就能支撑到几千用户。真正的"状态"落在
 * conversations.status / lesson_images.status 里，队列只是个执行器。
 * 这意味着即使进程重启，数据不会不一致 —— 最坏情况是有几条卡在 generating。
 *
 * 已知的取舍（写清楚，日后要么接受要么改）：
 *   1. 进程重启，排队中和执行中的任务会丢。补救见 recoverStuckTasks()。
 *   2. 上多进程（PM2 cluster）时会各跑各的队列。要么固定单进程，要么换成
 *      数据库轮询领取任务（加一张 tasks 表 + FOR UPDATE SKIP LOCKED）。
 */
import { config } from '../config.js';
import { logger, startTimer } from '../utils/logger.js';
import { query } from '../db/pool.js';

/**
 * 进度提示文案（api-spec 第 4 节的 progress_hint）。
 *
 * 为什么放内存不放数据库：db-schema.md 没有这个列，为一句会一直变的提示文案
 * 去加一列不划算（每推进一步就是一次写库）。进程重启后拿不到细粒度提示，
 * 降级成按 status 给一句通用文案，前端体验上察觉不到差别。
 */
const progressHints = new Map(); // taskId -> string

export function setProgressHint(taskId, hint) {
  progressHints.set(taskId, hint);
}
export function getProgressHint(taskId) {
  return progressHints.get(taskId) || null;
}
export function clearProgressHint(taskId) {
  progressHints.delete(taskId);
}

class TaskQueue {
  constructor(concurrency) {
    this.concurrency = Math.max(1, concurrency);
    this.pending = [];
    this.running = 0;
    /** 正在排队/执行中的 taskId，用于防止同一份教案被重复提交生成 */
    this.active = new Set();
  }

  /**
   * @param {object} o
   * @param {string} o.id       任务 id，如 'gen_1024' / 'img_3'。同 id 重复入队会被忽略
   * @param {string} o.kind     'generate_lesson' | 'generate_image' | 'extract_memory'
   * @param {Function} o.run    async () => {}
   * @param {Function} [o.onError] async (err) => {}  用来把失败状态落库
   * @returns {boolean} 是否真的入队（false = 已有同 id 任务在跑）
   */
  enqueue({ id, kind, run, onError }) {
    if (this.active.has(id)) {
      logger.info('task_duplicate_ignored', { task_id: id, kind });
      return false;
    }
    this.active.add(id);
    this.pending.push({ id, kind, run, onError });
    logger.info('task_enqueued', { task_id: id, kind, queued: this.pending.length, running: this.running });
    this.#drain();
    return true;
  }

  isActive(id) {
    return this.active.has(id);
  }

  stats() {
    return { queued: this.pending.length, running: this.running, concurrency: this.concurrency };
  }

  #drain() {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      this.running += 1;
      this.#execute(task);
    }
  }

  async #execute(task) {
    const t = startTimer();
    try {
      await task.run();
      logger.info('task_done', { task_id: task.id, kind: task.kind, ms: t() });
    } catch (err) {
      // 任务里的异常绝不能冒到全局，否则会把整个进程带走
      logger.error('task_failed', {
        task_id: task.id,
        kind: task.kind,
        ms: t(),
        code: err?.code,
        message: String(err?.message).slice(0, 300),
      });
      if (task.onError) {
        try {
          await task.onError(err);
        } catch (e2) {
          logger.error('task_onerror_failed', { task_id: task.id, message: String(e2?.message).slice(0, 200) });
        }
      }
    } finally {
      this.running -= 1;
      this.active.delete(task.id);
      clearProgressHint(task.id);
      this.#drain();
    }
  }
}

export const taskQueue = new TaskQueue(config.taskConcurrency);

/**
 * 启动时把「上次进程被杀时卡在进行中」的记录扫掉。
 *
 * 判断依据是时间：生成最多 30 秒，还在 generating 超过 10 分钟的，
 * 一定是进程重启导致的孤儿，直接标 failed，老师在教案库里能看到并重试。
 */
export async function recoverStuckTasks() {
  const conv = await query(
    `UPDATE conversations
        SET status = 'failed', updated_at = now()
      WHERE status = 'generating'
        AND updated_at < now() - interval '10 minutes'
        AND deleted_at IS NULL
      RETURNING id`
  );
  const img = await query(
    `UPDATE lesson_images
        SET status = 'failed', error_msg = '服务重启导致中断，请重试'
      WHERE status = 'pending'
        AND created_at < now() - interval '10 minutes'
      RETURNING id`
  );
  if (conv.rowCount || img.rowCount) {
    logger.warn('stuck_tasks_recovered', { conversations: conv.rowCount, images: img.rowCount });
  }
  return { conversations: conv.rowCount, images: img.rowCount };
}
