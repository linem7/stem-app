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

  wechat: {
    appid: str('WECHAT_APPID'),
    secret: str('WECHAT_SECRET'),
    contentCheckEnabled: bool('CONTENT_CHECK_ENABLED', false),
  },

  deepseek: {
    apiKey: str('DEEPSEEK_API_KEY'),
    baseURL: str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    model: str('DEEPSEEK_MODEL', 'deepseek-chat'),
    timeoutMs: num('DEEPSEEK_TIMEOUT_MS', 60000),
    maxRetries: num('DEEPSEEK_MAX_RETRIES', 2),
  },

  doubao: {
    accessKeyId: str('DOUBAO_ACCESS_KEY_ID'),
    secretAccessKey: str('DOUBAO_SECRET_ACCESS_KEY'),
    region: str('DOUBAO_REGION', 'cn-beijing'),
    endpoint: str('DOUBAO_ENDPOINT', 'https://visual.volcengineapi.com'),
    model: str('DOUBAO_MODEL', 'high_aes_general_v21_L'),
    dailyLimit: num('IMAGE_DAILY_LIMIT', 10),
    get configured() {
      return Boolean(this.accessKeyId && this.secretAccessKey);
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

  // 开发期假登录：没有微信 AppID 也能拿到 token 把后端跑通。
  // 生产环境强制关闭 —— 这是一道防线，不依赖运维记得改 .env。
  devFakeLogin: nodeEnv !== 'production' && bool('DEV_FAKE_LOGIN', false),

  taskConcurrency: num('TASK_CONCURRENCY', 2),
};

/**
 * 必填项清单。why 直接写给用户看：这一项是干什么的、去哪拿。
 */
const REQUIRED = [
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
  {
    name: 'WECHAT_APPID',
    ok: () => Boolean(config.wechat.appid),
    why: '微信小程序 AppID。mp.weixin.qq.com → 开发管理 → 开发设置 → 开发者ID。（若只想先本地跑通，可临时填 wx_placeholder 并把 DEV_FAKE_LOGIN 设为 true）',
  },
  {
    name: 'WECHAT_SECRET',
    ok: () => Boolean(config.wechat.secret),
    why: '微信小程序 AppSecret，与 AppID 同一个页面，点「生成」后只显示一次。（同上，本地可临时填占位值）',
  },
  {
    name: 'DEEPSEEK_API_KEY',
    ok: () => Boolean(config.deepseek.apiKey),
    why: 'DeepSeek 文本模型密钥。platform.deepseek.com → 注册 → API keys → 创建，并先充值一点余额。',
  },
];

/**
 * 启动自检。缺东西就打印中文说明并退出，不抛栈。
 * 返回 true 表示可以继续启动。
 */
export function assertConfigOrExit() {
  const missing = REQUIRED.filter((item) => !item.ok());

  if (missing.length === 0) {
    if (!config.wechat.contentCheckEnabled) {
      console.warn(
        '\n[提醒] CONTENT_CHECK_ENABLED=false，微信内容安全检查已关闭。' +
          '\n       本地开发可以这样，但正式提交小程序审核前必须设为 true，否则审核会被打回。\n'
      );
    }
    if (config.devFakeLogin) {
      console.warn(
        '[提醒] DEV_FAKE_LOGIN=true，任何人用 code="dev:xxx" 都能登录。仅供本地联调，上线前请设为 false 或把 NODE_ENV 设为 production。\n'
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
