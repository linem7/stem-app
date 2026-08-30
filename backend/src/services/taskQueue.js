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
 * 生成进度（api-spec 第 4 节）。**2026-08-25 从「一句提示文案」换成了「正在写出来的正文」。**
 *
 * 每个 taskId 存三样：
 *   phase  走到哪一段了：thinking（模型在想） / writing（正文在长） / checking（按年龄班校）
 *   text   已经写出来的**教案正文**（不是原始 JSON，那一步在 planStream 做完了）
 *   epoch  这是第几次尝试。模型被截断、思考吃穿预算时会重打一次，
 *          那时候正文要从头再来 —— 前端靠 epoch 变了知道该清屏重画
 *
 * 为什么放内存不放数据库：这东西每秒钟变好几次，落库就是每秒钟几次写。
 * 进程重启拿不到，前端那边表现成「这一屏没有正文可看」，教案照样在写 ——
 * 后端起来之后 recoverStuckTasks 会把真卡住的标 failed。
 *
 * ⚠️ 存的是**教案正文**，也就是老师自己写的那些东西的下游产物。
 * 日志里一个字都不许出现（api-spec 第 10 节：日志不记对话正文）。
 */
const progress = new Map(); // taskId -> { phase, text, epoch }

const blank = () => ({ phase: 'thinking', text: '', epoch: 1 });

export function getProgress(taskId) {
  return progress.get(taskId) || null;
}

export function setPhase(taskId, phase) {
  const p = progress.get(taskId) || blank();
  p.phase = phase;
  progress.set(taskId, p);
}

/**
 * 这一次尝试作废，正文从头再来。epoch + 1 是给前端的信号：清屏。
 * phase 退回 thinking —— 重打的那一次确实又要从头想一遍。
 */
export function resetStream(taskId) {
  const p = progress.get(taskId) || blank();
  progress.set(taskId, { phase: 'thinking', text: '', epoch: p.epoch + 1 });
}

/**
 * 更新正文。传的是**到目前为止的全文**，不是新增的那一段。
 *
 * 🔴 这里有一道兜底：新文本不以旧文本开头（也就是它不是「又长了一截」，
 * 而是变了一副样子）就**换一个 epoch**。planStream 保证了只增不减，
 * 所以正常情况下这一条永远不触发；真触发了说明我漏了一个边界，
 * 而这时候「慢一拍重画一次」远好过「前端把两段不相干的文字拼在一起」——
 * 后者是花屏，而且不报错。
 */
export function setStreamText(taskId, text) {
  const p = progress.get(taskId) || blank();
  const next = String(text || '');
  if (!next.startsWith(p.text)) {
    p.epoch += 1;
    logger.warn('stream_text_not_monotonic', { task_id: taskId, was: p.text.length, now: next.length });
  }
  p.text = next;
  progress.set(taskId, p);
}

export function clearProgress(taskId) {
  progress.delete(taskId);
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
      clearProgress(task.id);
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
