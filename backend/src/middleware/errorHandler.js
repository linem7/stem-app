/**
 * 统一错误响应（api-spec 第 0 节）。
 *
 * 关键点：任何走到这里的异常，返回给前端的一定是
 *   { ok:false, error:{ code, message, retryable } }
 * 绝不把英文栈、SQL 错误、模型返回的原文透给前端 —— 那些只进日志。
 */
import { AppError, ErrorCode, ERROR_CATALOG } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** 404：没有匹配到任何路由 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: {
      code: ErrorCode.NOT_FOUND,
      message: '这个功能还没有上线，请更新小程序试试',
      retryable: false,
    },
  });
}

export function errorHandler(err, req, res, _next) {
  const appErr = normalize(err);

  // 4xx 是「用户/客户端问题」，记 warn；5xx 是「我们的问题」，记 error 要能被告警抓到
  const level = appErr.http >= 500 ? 'error' : 'warn';
  logger[level]('request_failed', {
    method: req.method,
    path: req.path,
    teacher_id: req.teacherId,
    code: appErr.code,
    http: appErr.http,
    // detail 是我们自己塞的排查信息（不含对话正文）；stack 只在 5xx 时留
    detail: appErr.detail,
    message: appErr.http >= 500 ? String(err && err.message).slice(0, 300) : undefined,
  });

  if (res.headersSent) return; // 流已经开始写了，只能中断

  res.status(appErr.http).json(appErr.toResponse());
}

/** 把各种奇形怪状的异常收敛成 AppError */
function normalize(err) {
  if (err instanceof AppError) return err;

  // express.json() 解析失败会抛这个：请求体不是合法 JSON
  if (err && err.type === 'entity.parse.failed') {
    return new AppError(ErrorCode.VALIDATION_FAILED, {
      message: '提交的内容有点问题',
      detail: { reason: 'invalid_json' },
    });
  }
  if (err && err.type === 'entity.too.large') {
    return new AppError(ErrorCode.VALIDATION_FAILED, {
      message: '内容太长了，精简一下再试',
      detail: { reason: 'payload_too_large' },
    });
  }

  return new AppError(ErrorCode.INTERNAL, { cause: err });
}

/** 给需要在别处直接构造响应体的地方用（如任务队列写失败原因） */
export function errorBody(code) {
  const entry = ERROR_CATALOG[code] || ERROR_CATALOG.INTERNAL;
  return { code, message: entry.message, retryable: entry.retryable };
}
