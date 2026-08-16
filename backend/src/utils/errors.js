/**
 * 统一错误码与响应格式（对应 api-spec 第 0 节）。
 *
 * 为什么把中文文案放在后端：api-spec 明确写了「话术统一在后端，方便日后调整措辞」。
 * 前端拿到什么就显示什么，改文案不用发版小程序。
 */

/** 错误码表：code → { http, message, retryable } —— 与 api-spec 第 0 节逐行对应 */
export const ERROR_CATALOG = {
  UNAUTHORIZED: { http: 401, message: '登录已过期，请重新进入', retryable: false },
  NOT_FOUND: { http: 404, message: '没有找到这份教案', retryable: false },
  VALIDATION_FAILED: { http: 400, message: '提交的内容有点问题', retryable: false },
  RATE_LIMITED: { http: 429, message: '有点忙，请稍等一下再试', retryable: true },
  MODEL_TIMEOUT: { http: 504, message: '生成超时了，再试一次通常就好', retryable: true },
  MODEL_FAILED: { http: 502, message: '生成没成功，换个说法再试试', retryable: true },
  IMAGE_FAILED: { http: 502, message: '配图没生成出来，可以重试', retryable: true },
  INTERNAL: { http: 500, message: '出了点问题，我们已经记录下来了', retryable: true },
};

/** 便于代码里少写字符串字面量，拼错会立刻 undefined 而不是静默 */
export const ErrorCode = Object.freeze(
  Object.fromEntries(Object.keys(ERROR_CATALOG).map((k) => [k, k]))
);

export class AppError extends Error {
  /**
   * @param {string} code   ERROR_CATALOG 里的 key
   * @param {object} [opts]
   * @param {string} [opts.message]  覆盖默认展示文案（仍然要求是可直接给老师看的中文）
   * @param {object} [opts.detail]   仅进日志、不下发给前端的排查信息
   * @param {Error}  [opts.cause]
   */
  constructor(code, opts = {}) {
    const entry = ERROR_CATALOG[code] || ERROR_CATALOG.INTERNAL;
    super(opts.message || entry.message);
    this.name = 'AppError';
    this.code = ERROR_CATALOG[code] ? code : 'INTERNAL';
    this.http = entry.http;
    this.retryable = entry.retryable;
    this.detail = opts.detail;
    if (opts.cause) this.cause = opts.cause;
  }

  toResponse() {
    return {
      ok: false,
      error: { code: this.code, message: this.message, retryable: this.retryable },
    };
  }
}

/** 语义糖，读起来像句子：throw badRequest('缺少 seed_input') */
export const unauthorized = (message) => new AppError(ErrorCode.UNAUTHORIZED, { message });
export const notFound = (message) => new AppError(ErrorCode.NOT_FOUND, { message });
export const badRequest = (message, detail) =>
  new AppError(ErrorCode.VALIDATION_FAILED, { message, detail });
export const rateLimited = (message) => new AppError(ErrorCode.RATE_LIMITED, { message });
export const internal = (detail, cause) =>
  new AppError(ErrorCode.INTERNAL, { detail, cause });

/** 成功响应。放在这里是因为「统一响应格式」成败两半是一件事，分开放容易漂。 */
export function ok(res, data, httpStatus = 200) {
  return res.status(httpStatus).json({ ok: true, data });
}

/**
 * 包住 async 路由处理函数，让抛出的异常进到 errorHandler。
 * Express 4 不会自动捕获 async 函数里的 reject，漏了就是整个进程静默挂起。
 */
export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
