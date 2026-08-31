# 交接：数据库/部署问答 + teacher.bat（2026-08-31 晚）

**这是一轮很小的交接。** 同一天的 `2026-08-31-web-前端主体完成.md` 才是主线，
产品和代码状态看那一份，这里不重复。

这一轮只有三件事：查清了几个部署要用的事实、加了一个 `teacher.bat`、留下三个待用户拍板的决定。

---

## 一、查清的事实（问答，无代码改动）

用户问「数据库在哪、部署要上传什么」。答案在这儿，下次别再重新摸一遍。

### 数据库

| | 值 | 怎么核的 |
|---|---|---|
| 版本 | **PostgreSQL 17.11**（不是 16，也不是 MySQL） | `select version()` |
| 服务名 / 端口 | `postgresql-x64-17` / 5432 | — |
| 程序目录 | `C:\Program Files\PostgreSQL\17`（psql **不在 PATH**） | — |
| **数据目录** | `C:\Program Files\PostgreSQL\17\data` | `show data_directory` |
| `stem_app` 库本体 | `data\base\16387`（oid 16387） | `pg_database` |
| 当前规模 | 14 MB / 23 张表 | `pg_database_size` |

用之前先加 PATH：

```bash
export PATH="/c/Program Files/PostgreSQL/17/bin:$PATH"
PGPASSWORD=postgres psql -U postgres -h localhost -d stem_app
```

### 部署时上传什么

用户问过「要不要把数据库搬进项目文件夹」。**不要** —— 它是服务的运行时状态，不是源码；
而且仓库是**公开**的，`.gitignore` 现在没有挡 pg 数据目录，搬进来一次 `git add -A` 就把
对话正文和老师姓名传上去了。

| 要上去的东西 | 怎么上去 |
|---|---|
| 后端代码 `backend/`（不含 node_modules） | 服务器 `git pull`，然后 `npm ci --omit=dev --registry=https://registry.npmmirror.com` |
| 前端构建产物 `frontend/dist/` | 服务器上 `npm run build`，或本地 build 完只传 dist |
| 配置 `backend/.env` | **手工在服务器上新建**，不从 git 来 |
| 数据库 | ❌ 什么都不传。服务器装 PG → `createdb stem_app` → `npm run migrate`（21 个 migration） |
| `docs/` `research/` `prototype/` `design-demos/` | 不用传，服务器不读 |

新库只从旧库手抄 `ai_models` 的 key + 地址 + API key + 模型 id + 格式。
本机那些老师、教案、对话全是回归脚本和 seed 造的，一条都不带。

**体积**（量过的，印证「别传 node_modules」）：

| 目录 | 全部 | 去掉 node_modules |
|---|---|---|
| `backend` | 95M | 44M —— 其中 **42M 是 `.local-images/`**（开发期配图，gitignore 挡着）。真代码 `src` 904K + `admin` 196K + `scripts` 304K |
| `frontend` | 67M | 733K |

git 跟踪 264 个文件，要上去的代码合计不到 2M。

`.env` 里必须跟本机不一样的：`NODE_ENV=production`、`DEV_FAKE_LOGIN=false`、
`JWT_SECRET` 重新生成、`ADMIN_PASSWORD` 强密码（**必须改掉 `admin`/`123456`**）、
`DATABASE_URL` 换强密码、`PUBLIC_BASE_URL` 真实地址、
**`IMAGE_DAILY_LIMIT` 从 100 调回 10**、`OBJECT_STORAGE_*` 填 COS。

🔴 **`TZ=Asia/Shanghai` 必须显式设**（systemd 里写 `Environment=TZ=Asia/Shanghai`）。
Linux 默认 UTC，而「今天 14:05」这类展示、日志时间戳、`recoverStuckTasks` 的时间判断
全在后端算 —— 差 8 小时**不报错**，只是所有时间静静地错着。
这条经验来自 `backend/Dockerfile` 的文件头，那个文件本身已作废（见下面「挂着的决定」）。

---

## 二、新增 `teacher.bat`（根目录，跟 `admin.bat` 并排）

双击起教师端前端并开浏览器。行为模型照抄 `admin.bat`：依赖检查 → 端口探测 →
**已经在跑就只开浏览器** → 起服务并等它真活了再开浏览器 → **窗口即服务本体**。

它比 `admin.bat` 多守两件事，都是文档里 🔴 标过的坑：

1. **后端只认 3000，不做端口轮换。** 3000 空着就新开一个窗口起后端并等 `/healthz`；
   被别的程序占着就报错退出（原因见下）
2. **检查本地开发账号。** `.env.development.local` 里没有 `VITE_DEV_OPENID` 时警告一句 ——
   缺它首页会跳还没做的 `/redeem`

> 上一份交接里「开发要两个 cmd 窗口」那一段（`admin.bat` + 手敲 `npm run dev` + `dev:account`）
> **前两条已被两个 bat 取代**，第三条 `npm run dev:account` 照旧要手动跑一次。

### 验证到哪一步

| 路径 | 验证 |
|---|---|
| 复用分支（前后端都在跑） | ✅ 真跑了，退出码 0，浏览器打开 5175 |
| `npm run dev -- --port X --strictPort` | ✅ 单独在 5173 起了一次，vite 8.2.2，端口被遵守，`#FFFDF8` 探活标记能匹配。测完已 taskkill |
| 冷启动时自动起后端那一支 | ❌ **没验** —— 当时后端已在 3000 |
| 两条报错分支（3000 被占、后端 40 秒没起来） | ❌ 没验 |

---

## 三、这一轮踩到的两个坑

### 1. 🔴 `.bat` 必须是 CRLF 换行

第一版用 Write 工具写出来是 LF，cmd.exe 逐行解析时把中文注释切错位，报出一串

```
'---' is not recognized as an internal or external command
'�时好时坏）。' is not recognized as an internal or external command
```

**报错内容跟真正的原因（换行符）毫无关系**，很容易去改注释里的中文。
`admin.bat` 一直是 CRLF 所以它没事。已写进 `CLAUDE.md` 的「容易犯的错」。
改完 `file *.bat` 看一眼有没有 `with CRLF line terminators`。

⚠️ **这个坑有可能复发。** 这台机器 `core.autocrlf=true` 且仓库没有 `.gitattributes`，
所以 git **仓库里存的是 LF**，靠 checkout 时转成 CRLF —— 在这台机器上正常，
但换一台 `core.autocrlf=false` 的机器克隆就会拿到 LF 的 bat，双击直接报那串错。
根治只要一行 `.gitattributes`：`*.bat text eol=crlf`。**没加**，因为超出这一轮的请求范围，
留给用户定。

### 2. 🔴 vite 的 proxy 把 3000 写死了

`vite.config.js` 里 `'/v1': 'http://localhost:3000'`。后端跑在 3100 时前端页面
**照样打开**，只是每个接口都 404 —— 看起来像前端坏了。
而 `admin.bat` 是会轮换到 3100/3200 的，两个 bat 一起用就可能撞上。
`teacher.bat` 因此只认 3000。已写进 `CLAUDE.md` 的「开发约定」。

---

## 四、挂着的三个决定（只有用户能定）

1. **`backend/Dockerfile` 要不要归档进 `Archive/mini-program/`。**
   它是 2026-08-25 为**微信云托管**写的，随小程序那条路作废了 ——
   现在方案是腾讯云轻量服务器 + 直接 `node src/server.js`。
   留在 `backend/` 顶层容易让人以为部署方式是 Docker。
   ⚠️ 归档时**别丢掉文件头那两条经验**：`TZ=Asia/Shanghai`、npmmirror 源
   （前一条已经抄进这份交接的第一节）
2. **`backend/.env.example` 要不要清理。** 它还是小程序时代的版本，里面有
   `WECHAT_APPID` / `WECHAT_SECRET` / `CONTENT_CHECK_ENABLED`，说明文字写着「小程序审核」。
   它正是部署时照着填的那张清单，留着会让人填一堆已经作废的项。
   ⚠️ 改它要跟新身份模型（手机号 + 密码）一起改，否则改完还得再改一遍
3. **根目录 `sh.exe.stackdump`**（还有 `backend/`、`frontend/` 各一个）是 Git Bash 崩溃留下的垃圾，
   已被 `*.stackdump` 挡在 git 外。要不要删随时可以，跟代码无关

---

## 五、接着做什么

**跟上一份交接完全一样，这一轮没有推进主线。** 照 `2026-08-31-web-前端主体完成.md` 那份走：

- 前端只剩兑换页（卡在后端身份模型）和侧边栏删除教案
- 卡住整条路的是后端：去 `wechat.js`、写手机号 + 密码身份、接 TMS、接 COS、改 `api-spec.md`
- 只能用户做的：域名 + 个人 ICP 备案 + HTTPS（**上线闸门**）、云资源开通、
  **找真实幼儿园老师复核教案**（产品最大的未知数，至今零复核）
