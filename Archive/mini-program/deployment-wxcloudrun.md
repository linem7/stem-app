# 部署：微信云托管

> 2026-08-25 定的方向。环境 id：`cloud1-d2gq6r8wb670ae313`（用户开通）。
> 为什么选它：小程序经 `wx.cloud.callContainer` 调云托管走微信内部通道，
> **不需要 https 域名、不需要网站 ICP 备案** —— 这是体验版能给远处的人用的唯一近路。
> （小程序本体 2023 年起要做「小程序备案」，在微信公众平台里办，跟网站 ICP 是两回事、容易得多。）

## 架构（跟本地的差别只有三处）

```
小程序 ── wx.cloud.callContainer ──→ 云托管容器（Express 原样跑，端口 3000）
   （微信内部通道，免域名免备案）        │
                                    云上 PostgreSQL（要买）
浏览器 ── 公网访问（限 /admin）──→ 同一个容器
```

| 本地 | 云上 |
|---|---|
| `wx.request` 打局域网 IP | `callContainer`（`request.js` 里按环境变量分流，21 个 api 文件不知情） |
| code 换 openid（假登录 / AppSecret） | 微信网关注入 `X-WX-OPENID` 头，**不再需要 AppSecret** |
| 图片存 `.local-images/` | 🔴 **容器磁盘是临时的，这条必须尽快换**，见「已知风险」 |

## 代码侧已就绪（2026-08-25）

- `backend/Dockerfile` + `.dockerignore`（`.env` 绝不进镜像；TZ=Asia/Shanghai）
- 后端 `/auth/login`：`TRUST_WX_OPENID_HEADER=true` 时信 `X-WX-OPENID` 头。
  🔴 这个开关**只能在云托管环境里开** —— 别处这个头谁都能伪造，开了就是后门
- 前端 `request.js`：`VITE_WX_CLOUD_ENV` + `VITE_WX_CLOUD_SERVICE` 都非空时走
  `callContainer`，否则照旧。没配时行为一丝不变（已验证编译产物）
- `App.vue`：小程序启动时 `wx.cloud.init({ env })`

## 用户要在控制台做的（按顺序）

1. **建服务**：微信开发者工具 → 云开发 → 环境 `cloud1-d2gq6r8wb670ae313` →
   云托管 → 新建服务（名字建议 `stem-backend`，这个名字就是前端要填的
   `VITE_WX_CLOUD_SERVICE`）。
2. **数据库**：控制台里开通/购买 **PostgreSQL**（云托管资源侧若只给 MySQL，
   就去腾讯云买「云数据库 PostgreSQL」最低档并打通内网——界面以控制台实际为准，
   目标只有一个：拿到一条容器内可达的 `DATABASE_URL`）。
   ⚠️ 不换 MySQL——21 个迁移和全部手写 SQL 是 PostgreSQL 的（ADR-001）。
3. **上传代码**：云托管支持直接上传代码包（它用仓库里的 `Dockerfile` 构建），
   上传 `backend/` 目录。端口填 **3000**。
4. **环境变量**（服务设置里配，这是 `.env` 的线上替身）：

   | 变量 | 值 | 说明 |
   |---|---|---|
   | `DATABASE_URL` | 第 2 步拿到的连接串 | 必填 |
   | `JWT_SECRET` | 48 位随机串（别用本地那个） | 必填 |
   | `WECHAT_APPID` | `wxd7ae717c264d181e` | 必填 |
   | `WECHAT_SECRET` | 占位值即可 | 必填项但云托管模式下不再被用到（openid 走头） |
   | `TRUST_WX_OPENID_HEADER` | `true` | 云托管专属，见上 |
   | `ADMIN_PASSWORD` | ≥12 位强口令 | 🔴 后台能看到全部老师数据，**不许再用 123456** |
   | `DEEPSEEK_API_KEY` | 本地 `.env` 里那把 | 新库首次启动播种模型用 |
   | `CONTENT_CHECK_ENABLED` | 上线前 `true` | 体验阶段可先 false |
   | `NODE_ENV` | `production` | |

5. **跑迁移 + 搬数据**：新库要建表。两条路选一：
   - 干净开始：容器控制台里执行 `npm run migrate`，然后后台里重新建码、导名单；
   - 带着本地数据搬：本地 `pg_dump stem_app` → 恢复进云库（模型表里的 key 也跟着过去）。
6. **公网访问**：服务设置里打开，**触发路径限定为 `/admin`** ——
   业务接口只走 callContainer 内网通道，公网只留管理后台一扇门。
7. **小程序后台**：mp.weixin.qq.com → 设置 → 功能设置 → 基础库最低版本设为
   **2.23.0**（callContainer 的最低要求，不设老客户端会白屏）。
8. **前端切换**：`.env.production` 里
   `VITE_WX_CLOUD_ENV=cloud1-d2gq6r8wb670ae313`、`VITE_WX_CLOUD_SERVICE=服务名`，
   `VITE_API_BASE` 清空、`VITE_DEV_FAKE_LOGIN=false`。
   重跑 `npm run build:mp-weixin`，从 `dist/build/mp-weixin` 上传。

## 已知风险（按急迫排）

1. 🔴 **配图会丢**。容器磁盘是临时的：发版、重启、缩容都清盘，
   而图片现在存 `.local-images/`。老师生成的图**熬不过下一次发版**。
   必须接对象存储（环境自带的云存储或 COS）——`imageStore.js` 一处改造，
   顺带把「云对象存储」那个老 TODO 消掉。**接好之前别把配图功能开给真老师。**
2. **任务队列是单实例假设**。云托管的「实例数」要固定 **最小 1 / 最大 1**：
   多实例各跑各的内存队列和流式进度，轮询会问到没有进度的那个实例
   （taskQueue.js 文件头写过这个取舍）。流量真上来了再改成数据库领取任务。
3. **callContainer 请求限 100K**。业务请求都远小于这个数；
   唯一沾边的是名单 xlsx 导入（base64 约 27KB/50 人），几百人的园所会顶到 ——
   到时候分批传即可，不用现在改。
4. **费用**：云托管按量 + PostgreSQL 包年包月，低流量下合计约每月几十到一百多元。
   非商用项目自己掂量周期。
