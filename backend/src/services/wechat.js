/**
 * 微信服务端接口：code 换 openid、内容安全检查。
 *
 * Node 20 自带 fetch，不用装 axios。
 */
import { config } from '../config.js';
import { AppError, ErrorCode, badRequest } from '../utils/errors.js';
import { logger, startTimer } from '../utils/logger.js';

const API = 'https://api.weixin.qq.com';

/**
 * 用 wx.login 拿到的 code 换 openid。
 * code 只能用一次、5 分钟过期，所以这里不做重试 —— 重试必然是 40163 已使用。
 *
 * @returns {Promise<{openid:string, unionid:string|null}>}
 */
export async function code2Session(code) {
  // 开发期假登录：还没申请到微信 AppID 时也能把后端跑通（见 .env.example 的 DEV_FAKE_LOGIN）
  if (config.devFakeLogin && typeof code === 'string' && code.startsWith('dev:')) {
    const openid = `dev_${code.slice(4).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'default'}`;
    logger.warn('wechat_fake_login', { openid });
    return { openid, unionid: null };
  }

  const url =
    `${API}/sns/jscode2session?appid=${encodeURIComponent(config.wechat.appid)}` +
    `&secret=${encodeURIComponent(config.wechat.secret)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;

  const t = startTimer();
  let body;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    body = await res.json();
  } catch (err) {
    logger.error('wechat_code2session_network_failed', { ms: t(), message: err.message });
    throw new AppError(ErrorCode.INTERNAL, { detail: { step: 'code2session' }, cause: err });
  }

  logger.info('wechat_code2session', { ms: t(), errcode: body.errcode ?? 0 });

  if (body.errcode) {
    // 40029 无效 code、40163 code 已使用 —— 这两个是客户端问题，让老师重进一次即可
    if (body.errcode === 40029 || body.errcode === 40163) {
      throw badRequest('登录信息已失效，请退出小程序重新进入', { errcode: body.errcode });
    }
    // 40013 AppID 无效、40125 AppSecret 无效 —— 这是我们配错了
    logger.error('wechat_code2session_failed', { errcode: body.errcode, errmsg: body.errmsg });
    throw new AppError(ErrorCode.INTERNAL, {
      detail: { errcode: body.errcode, hint: '检查 .env 里的 WECHAT_APPID / WECHAT_SECRET' },
    });
  }

  if (!body.openid) {
    throw new AppError(ErrorCode.INTERNAL, { detail: { step: 'code2session', reason: 'no_openid' } });
  }
  return { openid: body.openid, unionid: body.unionid || null };
}

// ---------------------------------------------------------------
// access_token 缓存
// ---------------------------------------------------------------
// 微信的 access_token 有效期 7200 秒，且**每次调获取接口都会让旧的失效**，
// 所以必须缓存，不能每次现取。单进程部署下用模块级变量即可；
// 日后上多进程要挪到 Redis 或改用微信的「稳定版接口」stable_token。
let tokenCache = { token: null, expiresAt: 0 };
let inflight = null; // 并发时只发一个请求，避免互相把对方的 token 挤掉

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 60_000) return tokenCache.token;
  if (inflight) return inflight;

  inflight = (async () => {
    const url =
      `${API}/cgi-bin/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(config.wechat.appid)}&secret=${encodeURIComponent(config.wechat.secret)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    if (!body.access_token) {
      logger.error('wechat_token_failed', { errcode: body.errcode, errmsg: body.errmsg });
      throw new AppError(ErrorCode.INTERNAL, { detail: { step: 'access_token', errcode: body.errcode } });
    }
    tokenCache = { token: body.access_token, expiresAt: now + (body.expires_in || 7200) * 1000 };
    return body.access_token;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/**
 * 内容安全检查（msgSecCheck v2）。
 *
 * api-spec 第 10 节：老师输入和 AI 输出都要过这个接口。
 * 微信规定小程序有 UGC 就必须做，不做审核不通过 —— 这不是可选项。
 *
 * @param {object} o
 * @param {string} o.content  待检文本
 * @param {string} o.openid   用户 openid（v2 接口必填，且该用户需近两小时内访问过小程序）
 * @param {number} [o.scene]  1资料 2评论 3论坛 4社交日志；教案内容归 3
 * @param {string} [o.stage]  只用于日志，标明是老师输入还是 AI 输出
 * @returns {Promise<{pass:boolean, suggest:string, label:number|null}>}
 */
export async function msgSecCheck({ content, openid, scene = 3, stage = 'unknown' }) {
  if (!config.wechat.contentCheckEnabled) {
    // 关掉时明确记一条日志，免得上线后忘了开还以为在检查
    logger.debug('content_check_skipped', { stage });
    return { pass: true, suggest: 'skipped', label: null };
  }
  const text = String(content || '').trim();
  if (!text) return { pass: true, suggest: 'pass', label: null };

  // 微信限制单次 2500 字（UTF-8 编码后 2500 字符），超了要分片。
  // 教案正文动辄三四千字，所以这里按 2000 切片，任一片不过就整体不过。
  const chunks = splitByLength(text, 2000);
  const t = startTimer();

  try {
    const token = await getAccessToken();
    for (const chunk of chunks) {
      const res = await fetch(`${API}/wxa/msg_sec_check?access_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 2, openid, scene, content: chunk }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json();

      // 40001 = token 失效（可能被别处刷新了），清缓存重试一次
      if (body.errcode === 40001) {
        tokenCache = { token: null, expiresAt: 0 };
        const retryToken = await getAccessToken();
        const res2 = await fetch(`${API}/wxa/msg_sec_check?access_token=${retryToken}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 2, openid, scene, content: chunk }),
          signal: AbortSignal.timeout(10000),
        });
        const body2 = await res2.json();
        const r = interpret(body2, stage, t());
        if (!r.pass) return r;
        continue;
      }

      const r = interpret(body, stage, t());
      if (!r.pass) return r;
    }
    logger.info('content_check', { stage, ms: t(), suggest: 'pass', chunks: chunks.length });
    return { pass: true, suggest: 'pass', label: null };
  } catch (err) {
    // 检查接口本身挂了怎么办？
    // 这里选择「放行 + 告警」而不是「拦截」：微信侧抖动会让老师完全没法用产品，
    // 而漏检的风险由后续的人工巡查兜。若日后审核对此有要求，把这里改成 fail-closed 即可。
    logger.error('content_check_unavailable', { stage, ms: t(), message: err.message });
    return { pass: true, suggest: 'unavailable', label: null };
  }
}

function interpret(body, stage, ms) {
  if (body.errcode && body.errcode !== 0) {
    logger.warn('content_check_errcode', { stage, ms, errcode: body.errcode, errmsg: body.errmsg });
    // 87014 是"内容含有违法违规内容"的旧返回形式
    if (body.errcode === 87014) return { pass: false, suggest: 'risky', label: null };
    return { pass: true, suggest: 'unavailable', label: null };
  }
  const suggest = body.result?.suggest || 'pass';
  const label = body.result?.label ?? null;
  // risky 直接拦；review 也拦 —— MVP 阶段没有人工复审队列，宁可让老师换个说法
  const pass = suggest === 'pass';
  if (!pass) logger.warn('content_check_blocked', { stage, ms, suggest, label });
  return { pass, suggest, label };
}

function splitByLength(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * 检查不通过时统一抛这个，保证前后端拿到一致的文案。
 * @param {string} stage 'teacher_input' | 'ai_output'
 */
export function contentBlockedError(stage) {
  return new AppError(ErrorCode.VALIDATION_FAILED, {
    message:
      stage === 'ai_output'
        ? '生成的内容没通过安全检查，换个说法再试试'
        : '这段内容没通过安全检查，换个说法试试',
    detail: { stage },
  });
}
