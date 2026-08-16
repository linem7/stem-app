# 后端服务 · 怎么跑起来

这份文档假设你不是专业后端工程师。**照着从上往下做一遍就能跑通**，每一步都写了「做完应该看到什么」，看到的和写的不一样就停下来问 AI。

技术栈（已定，见 `docs/adr/ADR-001-technology-stack.md`）：Node.js 20 + Express 4 + 原生 JavaScript + PostgreSQL（手写 SQL，不用 ORM）。

---

## 零、需要装的两样东西

### 1. Node.js（20 或更高）

去 https://nodejs.org 下载 LTS 版本，一路下一步装完。

验证：打开终端（Windows 用 PowerShell 或 Git Bash），输入

```bash
node -v
```

看到 `v20.x.x` 或更高就对了。

### 2. PostgreSQL（14 或更高）

去 https://www.postgresql.org/download/ 下载对应系统的安装包。

**安装时它会让你设一个 postgres 用户的密码，记下来**，等一下要填进 `.env`。

验证：

```bash
psql --version
```

看到 `psql (PostgreSQL) 14.x` 或更高就对了。
（Windows 上如果提示"不是内部或外部命令"，说明安装目录没进 PATH，把 `C:\Program Files\PostgreSQL\16\bin` 加到系统环境变量 Path 里，重开终端。）

---

## 一、建数据库

只需要建一个空数据库，表由迁移脚本自动建。

```bash
# 方式 A：命令行
createdb -U postgres stem_app

# 方式 B：如果 A 报错，用 psql 进去建
psql -U postgres
# 进去后输入下面这行（分号不能少），然后 \q 退出
CREATE DATABASE stem_app;
```

**做完应该看到什么**：没有任何报错就是成功了（Unix 哲学，成功时不说话）。

---

## 二、装依赖

> ⚠️ **先看这条，不然会卡住**
>
> 这个项目现在放在 **Google Drive 同步目录（`G:\My Drive\...`）里**。
> Google Drive 是虚拟盘，`npm install` 要往里写几万个小文件，会失败并报
> `EBADF: bad file descriptor` 或 `EPERM: operation not permitted`。这不是代码问题，是盘的问题。
>
> **解决办法（二选一，推荐第一个）**：
>
> 1. 把 `backend` 这个文件夹**复制到本地硬盘**再开发，比如 `C:\dev\stem-app-backend`。
>    代码照常用 Git 或手动同步回 Drive 备份。`node_modules` 本来也不该进网盘。
> 2. 或者在 Google Drive 客户端里把这个目录设为"可离线使用"，并在装依赖期间暂停同步。
>
> 后面所有命令都在你实际开发的那个目录里跑。

在 `backend` 目录下：

```bash
npm install
```

**做完应该看到什么**：`added 119 packages` 之类的一行，并且目录下多了 `node_modules` 文件夹。

---

## 三、填 .env

```bash
# Mac / Linux / Git Bash
cp .env.example .env

# Windows CMD
copy .env.example .env
```

然后用记事本或 VS Code 打开 `.env`，**每一项上面都写了这个东西去哪申请**。

最少要填这五项才能启动：

| 变量 | 现在就能填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | 把 `你的密码` 换成第零步设的 postgres 密码 |
| `JWT_SECRET` | ✅ | 自己生成，见下面 |
| `WECHAT_APPID` | ⚠️ | 还没申请小程序的话，先随便填 `wx_placeholder` |
| `WECHAT_SECRET` | ⚠️ | 同上，先随便填 `placeholder` |
| `DEEPSEEK_API_KEY` | ⚠️ | 去 platform.deepseek.com 申请，**必须充值一点钱**，不然调用报余额不足 |

生成 `JWT_SECRET`：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

把输出那一长串粘到 `JWT_SECRET=` 后面。

> **先跑通再接模型**：微信和 DeepSeek 的 key 都还没有也没关系。
> 把 `WECHAT_*` 填占位值、`DEV_FAKE_LOGIN=true`，就能用假登录把整条链路跑通，
> 只是引导出题会退化成兜底选项、生成教案会报错。

---

## 四、建表（跑迁移）

```bash
npm run migrate
```

**做完应该看到什么**：

```
准备迁移数据库：postgres://postgres:****@localhost:5432/stem_app

  执行 001_init.sql ...
  完成 001_init.sql

迁移完成：本次执行了 1 个文件，共 1 个。
```

再跑一次会说「数据库已经是最新的」——这是对的，跑过的迁移不会重复执行。

**如果报错**：错误信息里会直接写是哪一步的问题（连不上 / 密码不对 / 库不存在），照着改就行。

---

## 五、启动

```bash
npm start
```

**做完应该看到什么**：

```
════════════════════════════════════════════════════════
 后端启动成功
════════════════════════════════════════════════════════
  地址：      http://localhost:3000
  环境：      development
  文本模型：  deepseek-chat
  配图：      未配置（不影响其他功能）
  内容安全：  关（上线前必须开）

  验证一下：
      curl http://localhost:3000/healthz
════════════════════════════════════════════════════════
```

开发时用 `npm run dev`，改完代码自动重启。

---

## 六、验证跑通了

### 6.1 服务活着吗

新开一个终端：

```bash
curl http://localhost:3000/healthz
```

**期望看到**：

```json
{"ok":true,"data":{"service":"stem-lesson-backend","db":"up","queue":{"queued":0,"running":0,"concurrency":2},"time":"..."}}
```

`"db":"up"` 是关键——它说明服务和数据库都通了。

### 6.2 完整走一遍（假登录）

确认 `.env` 里 `DEV_FAKE_LOGIN=true`，然后：

```bash
# 1) 登录，拿 token
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"code":"dev:test001"}'
```

**期望看到**：`{"ok":true,"data":{"token":"eyJ...","expires_in":2592000,"teacher":{...}}}`

把 `token` 的值复制下来，下面每一条都要用：

```bash
TOKEN=把上面那串token粘这里

# 2) 看自己的档案
curl http://localhost:3000/v1/me -H "Authorization: Bearer $TOKEN"

# 3) 填档案
curl -X PATCH http://localhost:3000/v1/me \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kindergarten_name":"阳光幼儿园","age_group":"中班","teaching_years":5}'

# 4) 开一个教案会话 —— 这一步会真的调 DeepSeek
curl -X POST http://localhost:3000/v1/conversations \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"seed_input":"我想做个浮与沉的活动"}'
```

**期望看到**：返回里有 `conversation_id` 和第一题（问年龄班，三个选项：小班/中班/大班）。

```bash
# 5) 答第一题（选 A = 小班），拿下一题
curl -X POST http://localhost:3000/v1/conversations/1/answer \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"question_id":"q1","selected":["A"]}'
```

**这一步是验证「年龄班规则生效」的关键**：接着答到第三题（时长），你会看到选项是
**15 / 20 / 25 分钟**。如果第一题选的是大班（C），同一道题的选项会变成 **30 / 40 / 45 分钟**。
这不是模型随便给的，是代码从 `age-band-adaptation.md` 的参数表里算出来的。

```bash
# 6) 直接生成教案（不用把 11 题答完）
curl -X POST http://localhost:3000/v1/conversations/1/generate \
  -H "Authorization: Bearer $TOKEN"

# 7) 每 2 秒查一次进度（真实前端也是这么做的）
curl http://localhost:3000/v1/conversations/1/generate/status \
  -H "Authorization: Bearer $TOKEN"

# 8) status 变成 completed 后，用返回的 lesson_plan_id 取教案
curl http://localhost:3000/v1/lesson-plans/1 -H "Authorization: Bearer $TOKEN"
```

走到这里，**后端主链路就算跑通了**。

---

## 七、常见问题

| 现象 | 原因和解决 |
|---|---|
| `npm install` 报 `EBADF` / `EPERM` | 项目在 Google Drive 虚拟盘上，见第二步开头的提醒，复制到本地硬盘再装 |
| 启动时列出一堆「还差 N 项」 | `.env` 没填全，照着提示补 |
| `连不上数据库` | PostgreSQL 服务没启动，或 `.env` 里密码写错 |
| `数据库连上了，但表还没建` | 先 `npm run migrate` |
| 生成教案返回 `生成没成功` | 多半是 DeepSeek 的 key 无效或余额不足，去 platform.deepseek.com 看 |
| `配图没生成出来` | 正常，豆包接入还没做完，见 `src/services/doubao.js` 顶部注释 |
| `导出 Word 还在做` | 正常，见 `src/routes/lessonPlans.js` 的 TODO |

---

## 八、目录结构

```
src/
  server.js              入口：启动自检 + 挂路由
  config.js              读环境变量，缺什么明确报错
  db/
    pool.js              连接池 + query 封装
    migrate.js           迁移执行器（npm run migrate）
    migrations/001_init.sql   6 张表 + 索引
  middleware/
    auth.js              JWT 签发与校验
    errorHandler.js      统一错误响应
    rateLimit.js         限流
  routes/                一个文件对应 api-spec 的一节
  services/
    promptBuilder.js     ★ 拼系统提示词（年龄班规则在这里）
    guideFlow.js         ★ 三轮引导的流程控制
    lessonGenerator.js   ★ 生成教案 + 自检 + Markdown 渲染
    memoryExtractor.js   ★ 提取记忆并去重合并
    deepseek.js          文本模型
    doubao.js            图片模型（部分 TODO）
    wechat.js            登录 + 内容安全
    taskQueue.js         进程内异步队列
  utils/
    errors.js            错误码 + 统一响应
    logger.js            结构化日志（不记对话正文）
```

---

## 九、上线前必须做的事

这几条不做会出事，按顺序检查：

1. **`.env` 里 `CONTENT_CHECK_ENABLED=true`**
   微信规定小程序有用户内容就必须过 `msgSecCheck`，不做审核不通过。
2. **`NODE_ENV=production`**（假登录会被强制关掉）
3. **`.env` 绝不能提交到 Git**，也不能出现在前端代码里。所有 API key 只在服务器上。
4. **域名要 HTTPS + 已备案**，小程序强制要求。备案流程见 ADR-001。
5. 用 PM2 守护进程：`npm i -g pm2 && pm2 start src/server.js --name stem-api`
6. 定期跑清理（db-schema.md 第 8 节）：软删除 30 天后物理删、失败的配图 7 天后清。
   这个清理脚本还没写，上线前补一个 `node scripts/cleanup.js` + cron 即可。

---

## 十、还没做完的（有意留的 TODO）

| 位置 | 内容 | 什么时候做 |
|---|---|---|
| `src/services/doubao.js` | 火山引擎签名 + 图片接口请求体 | 拿到火山引擎 AK/SK 之后。注释里写了去哪查文档 |
| `src/services/doubao.js` | 对象存储上传 | 选定腾讯云 COS 或阿里云 OSS 之后 |
| `src/routes/lessonPlans.js` | 导出 docx | 上线前。用 `docx` npm 包，注释里写了步骤 |
| （未建） | 数据清理定时脚本 | 上线一个月内 |

除这四项外，其余功能都是**真实现**，不是占位。
