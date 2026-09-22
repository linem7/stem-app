/**
 * 配置读取与启动自检。
 *
 * 为什么单独做一层而不是到处 process.env：
 * 非专业开发者最常见的卡点是「跑不起来但看不懂报错」。把所有环境变量集中在这里，
 * 启动时一次性把「缺什么、去哪申请」全部列出来（而不是跑到一半才抛一个英文栈），
 * 是这个项目里性价比最高的一段代码。
 */
import 'dotenv/config';

/** 读字符串，空字符串按未设置处理（.env 里留空是常见写法） */
function str(name, fallback = undefined) {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  return v.trim();
}

function num(name, fallback) {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback = false) {
  const v = str(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const nodeEnv = str('NODE_ENV', 'development');

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: num('PORT', 3000),
  logLevel: str('LOG_LEVEL', 'info'),

  db: {
    url: str('DATABASE_URL'),
    ssl: bool('DATABASE_SSL', false),
  },

  jwt: {
    secret: str('JWT_SECRET'),
    // api-spec 第 1 节的 expires_in 就是这个值
    expiresInSeconds: num('JWT_EXPIRES_IN', 2592000),
  },

  /* 内容安全 —— 阿里云内容安全（Green）的 TextModerationPlus。
     替掉微信那套（2026-09-22）。两个 service 对应两个调用点：
     老师输入 2000 字、AI 输出 5000 字，见 services/contentSafety.js。

     开关和凭据分开校验：开启却缺凭据时启动失败，不能静默关闭审核。 */
  contentSafety: {
    enabled: bool('CONTENT_CHECK_ENABLED', false),
    accessKeyId: str('ALIBABA_CLOUD_ACCESS_KEY_ID'),
    accessKeySecret: str('ALIBABA_CLOUD_ACCESS_KEY_SECRET'),
    // 内容安全在杭州、北京、上海、深圳、成都都有端点。
    // 服务器在杭州（ADR-003），离得近。换个地域只改这个值。
    region: str('CONTENT_SAFETY_REGION', 'cn-hangzhou'),
    get configured() {
      return Boolean(this.accessKeyId && this.accessKeySecret);
    },
  },

  /**
   * ⚠️ 2026-08-23 起，deepseek 这一段只是**播种源 + 播种前的兜底**：
   * 启动时被 seedEnvModels() 抄进 ai_models 表（含单价/超时/重试），
   * 之后改这里不再生效 —— 改模型一律走管理后台的「模型管理」。
   */
  deepseek: {
    apiKey: str('DEEPSEEK_API_KEY'),
    baseURL: str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    model: str('DEEPSEEK_MODEL', 'deepseek-chat'),
    timeoutMs: num('DEEPSEEK_TIMEOUT_MS', 60000),
    maxRetries: num('DEEPSEEK_MAX_RETRIES', 2),

    /**
     * 单价，**分 / 百万 token**。后台概览的「花了多少钱」靠这两个数算。
     *
     * 为什么放配置而不是写死在代码里：**价格会变**，而且缓存命中/未命中是两个价。
     * 写死了就会在某次调价之后悄悄算错，还看不出来。
     * 默认值按 2026-08 DeepSeek 官网 deepseek-chat 的标准价填的，
     * **上线前去官网核一遍**，别当成事实。
     *
     * 算出来的钱在调用当时就存进 model_calls.cost_cents，不留到查询时再乘 ——
     * 否则改一次这个常量会让全部历史成本集体漂移。
     */
    priceInPerMTok: num('DEEPSEEK_PRICE_IN_CENTS_PER_MTOK', 200),
    priceOutPerMTok: num('DEEPSEEK_PRICE_OUT_CENTS_PER_MTOK', 800),
  },

  /**
   * 默认用哪家出图 / 哪家写文本。都只是**兜底**：后台「设为默认」（app_settings）
   * 设过之后以库里的为准，这两个值只在全新部署、库里还没设过时起作用。
   */
  imageProvider: str('IMAGE_PROVIDER', 'gpt'),
  textProvider: str('TEXT_PROVIDER', 'deepseek'),

  /** gpt-image-2，经 12ai 中转，OpenAI images 接口形状 */
  gptImage: {
    apiKey: str('IMG_API_KEY'),
    // 注意这个地址本身已经带 /v1，代码里只拼 /images/generations。
    // 服务商文档写的是 POST /v1/images/generations，照抄会变成 /v1/v1/...
    baseURL: str('IMG_BASE_URL', 'https://cdn.12ai.org/v1'),
    model: str('IMG_MODEL', 'gpt-image-2'),
    quality: str('IMG_QUALITY', 'medium'),
    // 实测 medium + 1536×2048 要 71 秒，比 MiniMax 还慢。给到 150 秒，
    // 仍在前端轮询的 180 秒之内
    timeoutMs: num('IMG_TIMEOUT_MS', 150000),
    get configured() {
      return Boolean(this.apiKey);
    },
  },

  minimax: {
    apiKey: str('MINIMAX_API_KEY'),
    // 大陆走 api.minimaxi.com，海外是 api.minimax.io。老师都在大陆，默认前者。
    baseURL: str('MINIMAX_BASE_URL', 'https://api.minimaxi.com'),
    model: str('MINIMAX_MODEL', 'image-01'),
    // 60 秒不够。实测竖版记录表（1536×2048）出图要 49–71 秒，正好压在 60 上，
    // 同一个提示词三次里能超时两次 —— 老师看到的是「配图超时了」，而钱已经花了。
    // 前端轮询给到 180 秒，这里放到 120 仍在它里面。
    timeoutMs: num('MINIMAX_TIMEOUT_MS', 120000),
    dailyLimit: num('IMAGE_DAILY_LIMIT', 10),
    get configured() {
      return Boolean(this.apiKey);
    },
  },

  storage: {
    baseUrl: str('OBJECT_STORAGE_BASE_URL'),
    bucket: str('OBJECT_STORAGE_BUCKET'),
    region: str('OBJECT_STORAGE_REGION'),
    keyId: str('OBJECT_STORAGE_KEY_ID'),
    keySecret: str('OBJECT_STORAGE_KEY_SECRET'),
    get configured() {
      return Boolean(this.baseUrl && this.bucket);
    },
  },

  /* 🔴 假登录和「信任 X-WX-OPENID 请求头」两条后门 2026-09-22 整段删除。
     它们都是小程序时代的产物：一个是「没有 AppID 也能把后端跑通」，
     一个是微信云托管里由网关注入真 openid。
     转 web 之后两条的依据都没了 —— 而 80 是对公网开着的，
     留着就是「知道地址的人凭空拿到一个账号」。
     现在登录只有一条路：手机号 + 密码（routes/auth.js）。
     ⚠️ **删掉一个配置项之后要顺手清 .env 里那一行** ——
     我把 DEV_FAKE_LOGIN 删了，隔一版读 .env 的人会以为它还生效。 */

  taskConcurrency: num('TASK_CONCURRENCY', 2),

  // 管理后台。只有一个账号 —— 系统里不存在「园所管理员」这种角色，
  // 这是「园方看不到老师数据」那句承诺的技术兑现，不是省事。
  admin: {
    // 首个超管账号的初始密码。库里已经有账号之后，改密码在后台改，这个值就不再起作用。
    password: str('ADMIN_PASSWORD'),
    get configured() { return Boolean(this.password); },
    // 生产环境的密码门槛单独判：后台能看到全部老师的手机号和对话内容，
    // 弱密码在公网上等于没有密码。开发环境不拦，方便本地随便设。
    get weakInProduction() {
      return nodeEnv === 'production' && Boolean(this.password) && this.password.length < 12;
    },
  },

  // 没配对象存储时，图片存这个本地目录，由 server.js 挂静态路由提供访问。
  // 只在单机开发时成立，见 minimax.js 的 uploadImage 注释。
  localImageDir: str('LOCAL_IMAGE_DIR', './.local-images'),
  // 拼本地图片 URL 用。部署到公网后改成真实域名。
  publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${num('PORT', 3000)}`),
};

/**
 * 必填项清单。why 直接写给用户看：这一项是干什么的、去哪拿。
 */
const REQUIRED = [
  {
    name: 'ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET',
    ok: () => !config.contentSafety.enabled || config.contentSafety.configured,
    why: '已开启内容安全，请配置阿里云内容安全访问凭据。',
  },
  {
    name: 'DATABASE_URL',
    ok: () => Boolean(config.db.url),
    why: '数据库连接串。本地装完 PostgreSQL 后形如 postgres://postgres:密码@localhost:5432/stem_app；线上在云厂商的「云数据库 PostgreSQL」控制台复制。',
  },
  {
    name: 'JWT_SECRET',
    ok: () => Boolean(config.jwt.secret) && config.jwt.secret.length >= 32,
    why: '登录令牌的签名密钥，不用申请，自己生成一串 32 位以上的随机字符即可：node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
  },
  /* WECHAT_APPID / WECHAT_SECRET 从必填清单撤下了（2026-09-22）。
     微信那一整块（登录 + 内容安全）都已经走完了：登录 2026-09-20 改手机号+密码，
     内容安全 2026-09-22 改阿里云。**这两个变量现在没有任何代码在读**，
     `.env` 里那两行留着没删只是懒得动，下次清理 .env 时一起收。 */
  /* DEEPSEEK_API_KEY 从必填清单撤下了（2026-08-23）：文本模型播种进库之后，
     「有没有一个能用的文本模型」在 server.js 启动时查库判断 ——
     老库里模型早就在库里了，.env 空着也该能启动。全新部署缺 key 的中文提示在那边。 */
];

/**
 * 启动自检。缺东西就打印中文说明并退出，不抛栈。
 * 返回 true 表示可以继续启动。
 */
export function assertConfigOrExit() {
  const missing = REQUIRED.filter((item) => !item.ok());

  if (missing.length === 0) {
    if (!config.contentSafety.enabled) {
      const why = config.contentSafety.configured
        ? 'CONTENT_CHECK_ENABLED=false'
        : 'ALIBABA_CLOUD_ACCESS_KEY_ID / _SECRET 没配全';
      console.warn(
        `\n[提醒] 内容安全检查是关的（${why}）。` +
          '\n       老师输入和 AI 输出现在**一条都没在过审**。' +
          '\n       使用协议里对老师承诺过这一条，上线前必须开。\n'
      );
    }
    if (!config.admin.configured) {
      console.warn(
        '\n[提醒] 没设 ADMIN_PASSWORD，第一次启动建不出超级管理员账号。' +
          '\n       发兑换码、发额度、看反馈都在 /admin 里，正式运营前要配上。\n'
      );
    }
    if (config.admin.weakInProduction) {
      console.error(
        '\n[危险] 生产环境的 ADMIN_PASSWORD 短于 12 位。' +
          '\n       管理后台能看到全部老师的手机号和对话内容，弱密码在公网上等于没有密码。' +
          '\n       登录后台后立刻改掉，或者改 .env 重启。\n'
      );
    }
    return true;
  }

  const lines = [
    '',
    '════════════════════════════════════════════════════════',
    ' 启动失败：环境变量没配齐',
    '════════════════════════════════════════════════════════',
    '',
    `还差 ${missing.length} 项。请打开 backend 目录下的 .env 文件补上：`,
    '（如果还没有 .env，先把 .env.example 复制一份改名为 .env）',
    '',
  ];
  missing.forEach((item, i) => {
    lines.push(`  ${i + 1}. ${item.name}`);
    lines.push(`     ${item.why}`);
    lines.push('');
  });
  lines.push('填好后重新执行：npm start');
  lines.push('════════════════════════════════════════════════════════');
  lines.push('');

  console.error(lines.join('\n'));
  process.exit(1);
}
