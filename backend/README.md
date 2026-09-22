# 后端运行说明

Express 4 + JavaScript ESM + PostgreSQL。以下命令除特别注明外都在 `backend/` 目录执行。项目与文档入口见 [根 README](../README.md) 和 [文档导航](../docs/README.md)。

## 首次配置

后端需要 Node.js 20+、PostgreSQL 14+；同时运行当前前端需 Node `^20.19.0 || >=22.12.0`（Vite 8.2.2 的 engines）。在本地硬盘安装依赖；若在 Google Drive 虚拟盘遇到 `EBADF` 或 `EPERM`，将项目放到本地硬盘。

```bash
npm install
createdb -U postgres stem_app
# 仅首次创建；已有 .env 时不要覆盖
cp .env.example .env
```

Windows CMD 可用 `copy .env.example .env`。填写环境文件时以 [.env.example](.env.example) 与 [配置实现](src/config.js) 为准：

| 配置 | 用途与条件 |
|---|---|
| `DATABASE_URL` | 必填，连接自己的 PostgreSQL 数据库 |
| `JWT_SECRET` | 必填，至少 32 字符的随机密钥 |
| `DEEPSEEK_API_KEY` | 新库模型的播种来源；已有模型配置以数据库为准，后续通过后台管理 |
| `ADMIN_PASSWORD` | 首个管理员的初始密码；已有账号后修改环境变量不会重置账号密码 |
| `CONTENT_CHECK_ENABLED` | 是否启用文本审核；对外服务应开启 |
| `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 开启审核时必填，缺失会导致启动失败 |
| `LOCAL_IMAGE_DIR` | 图片目录，默认 `./.local-images`，相对于进程工作目录 |
| `PUBLIC_BASE_URL` | 图片公开地址的基址，部署时使用实际 HTTPS 入口 |
| `IMAGE_DAILY_LIMIT` | 配图日限额，代码默认 10；实际值取环境配置 |

生成 JWT 密钥：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

无需配置微信变量。图片采用本地磁盘方案，保留的 `OBJECT_STORAGE_*` 不需要填写。文本与图片模型播种后通过管理后台修改，避免只改环境文件却误以为数据库模型也已更新。

```bash
npm run migrate
npm start
```

迁移执行器记录已执行文件，重复运行只执行新增迁移。当前仓库包含 001–025；已有数据库继续迁移，不重建空库。

## 启动与登录

后端默认端口 3000，管理后台为 `/admin/`。新开终端验证：

```bash
curl http://localhost:3000/healthz
```

响应 `ok: true`、`data.db: "up"` 表示服务与数据库连通，`data.queue` 提供当前队列情况。这不代表模型、审核或完整生成链路已验证。

教师前端在项目根目录另开终端运行：

```bash
cd frontend
npm install
npm run dev
```

在后台准备兑换码及名单／地区信息；教师打开 `/redeem`，选择名单身份或「不在名单之内」，设置手机号（输入两次）与密码，使用前同意协议。以后用 `/login` 登录。接口字段见 [API 约定](../docs/design/api-spec.md)。

Windows 可双击根目录 `admin.bat` / `teacher.bat`。Vite 代理固定连接 `localhost:3000`，端口被其他程序占用时先解决冲突。后端采用进程内队列，运行生成任务期间不要使用 `npm run dev` 的自动重启；改后端后手动重启并重新检查健康状态。

## 验证与测试

本节只说明操作条件；运行脚本前确认目标为测试环境。

| 类别 | 命令 | 条件与副作用 |
|---|---|---|
| 后端静态检查 | `npm run lint` | 不起服务、不调用模型 |
| 后端离线回归 | `npm run test:ageband`、`test:commentary`、`test:stream`、`test:context`、`test:contentsafety:unit` | 每项均用 `npm run` 执行；不连接业务库或真实审核服务 |
| 前端离线检查（在 `frontend/`） | `npm run lint`、`test:tokens`、`test:contrast`、`test:logout`，以及 `npm run build` | 不需要后端；构建会写入 `dist/` |
| 接口回归（在 `frontend/`） | `npm run test:api` | 需要后端、数据库和测试管理员，会创建测试数据；加 `-- --generate` 会调用模型 |
| 生成冒烟 | `npm run smoke -- 小班`（可换中班／大班） | 需要后端、数据库、用户名为 `admin` 的测试管理员及可用文本模型；会建账号、兑换码和教案并产生模型费用 |
| 真实内容审核 | `npm run test:contentsafety` | 读取 `.env`，调用真实阿里云审核；细节见审核文档 |

冒烟脚本可用 `BASE` 指定服务地址、`ADMIN_PASSWORD` 指定测试管理员密码、`SEED` 指定主题。其账号通过正式激活接口创建，不依赖假登录。其他接口测试的变量与用途以各脚本文件头为准，不将所有脚本视作离线测试。

`node scripts/cleanup-test-data.mjs` 默认预览候选数据，加 `--yes` 会删除数据；种子、清库与压缩历史图片脚本也会改数据或文件，不属于文档检查。

## 排错与部署参考

- 数据库连接失败：检查服务是否启动、连接地址和密码是否匹配；不要照旧交接直接重置密码。
- 服务启动但不能生成：核对后台是否有启用的文本模型、凭据和余额；健康检查不验证模型可用性。
- 审核暂不可用：会返回可重试的 `CONTENT_CHECK_UNAVAILABLE`（503），不能通过关闭审核来掩盖线上故障。
- Word 下载：接口直接返回文件，前端以 blob 下载；不是跳转到一个有时效的下载链接。
- 图片访问失败：核对磁盘文件、`LOCAL_IMAGE_DIR` 与 `PUBLIC_BASE_URL`，备份时保留业务图片。

当前功能待办与有日期的部署记录见 [开发约定](../CLAUDE.md)。审核配置见 [内容安全](../docs/design/content-safety.md)。本次文档整理不运行部署、迁移、重启或收费测试。
