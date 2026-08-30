# 小程序那一路踩过的坑

2026-08-30 从主 `CLAUDE.md` 搬出来。**这些在 web 端一条都不适用**，
留着是因为它们每一条都花了一到三轮才查出来，而且大多属于同一类：
**源码看着没问题、构建也不报错、只有微信才出事。**

如果哪天又要做小程序，先读这份。

---

## 1. 编译产物才是真相

**遇到「点了没反应」，第一件事是读 `frontend/dist/dev/mp-weixin/` 下的编译产物，不是读源码猜。**

`npm run test:mp` 查的就是这一类：

- 自定义组件的事件名**不许叫 `tap`**
- `<block>` 上**不许有 `wx:key`**
- `v-for` 的 key **跨兄弟列表也要唯一**

⚠️ `test:mp` **默认查 `dist/dev/mp-weixin`**。刚跑完 `build` 就要显式
`node scripts/mp-lint.mjs dist/build/mp-weixin`，否则查的是旧产物、全绿也没意义（踩过）。

---

## 2. 事件处理器的 key 只有 256 个桶

uni 给事件处理器的缓存 key 是**按 handler 名算的 8 位哈希，只有 256 个桶** ——
页面一长就会撞（「我的」页一天撞了四次：`97` / `b1` / `c6` / `55`）。
撞了微信会把点击**派发错人**。

两条应对：

1. `v-if / v-else` 一对会让两个 handler 落在同一位置，**改用 `v-show`**
   （两块都真实在节点树里，才会分到不同 key）
2. 真撞了就**给其中一个 handler 改名**，哈希跟着变
   （实测 `askDeleteAccount` → `onDeleteDataTap`，key 从 `c6` 变 `00`）

⚠️ 这个 lint **一次只报一个重复 key**，改完要重跑 —— 第一处修完才露出第二处。
别看到「红 1 条」就以为只剩一处。

2026-08-25 `test:mp` 第一次全绿，靠的是 `me.vue` 里两对改名：
`goTasks` → `onTaskRowTap`（跟 `load` 都撞 `4c`）、
`onSuggestionInput` → `onSuggestionTyping`（跟 `onRedeemTap` 都撞 `48`）。

---

## 3. 样式隔离让类选择器进不了组件

🔴 **字号档必须内联在 `s-page` 根节点上，不能用类。**

微信自定义组件默认 `styleIsolation: 'isolated'`，`app.wxss` 里的**类选择器进不了组件内部**
（只有标签选择器能穿透，所以 `page {}` 那层可以），而 `s-page` 的根节点正在组件内部。

走类那条路会**静默失效**：编译不报错，H5 预览还是对的（H5 没有样式隔离），
只有微信里「调到特大什么都没变」。第一版就是这么写的，查编译产物才发现。

---

## 4. 小程序发不出 `PATCH` 请求

方案：后端**同一个 handler 挂两个方法**，`PATCH /memories/:id` ＝ `POST /memories/:id/update`。

三个 PATCH 接口都有了 POST 别名（`memories/:id`、`me`、`lesson-plans/:id`）。
**不要为小程序单写一份实现** —— 两份里总有一份没人测。

> web 端能发 PATCH，但那三个别名**留着不删**（无害，且已有回归覆盖）。

---

## 5. `.env.*.local` 是一个 gitignore 挡着的隐形开关

🔴 **`.env.development.local` 一直在悄悄改坏小程序包，而两处注释都写着「小程序不读这个文件」。**

Vite 对 `mode=development` **一律**加载 `.local` 且优先级最高，所以那句
`VITE_API_BASE=/v1`（本意只给 H5 走同源代理）把小程序那一侧也改成了相对路径，
而 `wx.request` **不接受相对路径** —— 编出来的包在微信里连不上后端。

更难查的是 `request.js` 那道 `if (!API_BASE)` 的友好提示**挡不住它**（`/v1` 不是空串），
老师看到的是一个原始的 `wx.request` 报错；而 `.env.*.local` 被 gitignore 挡着，
仓库里看不见它干了什么。

**最后的做法是按平台分流 + 条件编译**（项目里第一次用 `#ifdef`）：

```
.env.development:  VITE_API_BASE（绝对地址，给小程序）
                   VITE_H5_API_BASE=/v1（给 H5）
utils/env.js:      用 #ifdef H5 挑
```

实测编译产物：小程序包里那行被整行剔掉、只剩 `pick("VITE_API_BASE")`；
H5 包里 `_v=yv("VITE_H5_API_BASE")||_v` 保留。

🔴 **别改回「用 .local 覆盖 VITE_API_BASE」那种做法。**

---

## 6. 真机调试

- 🔴 `.env.development` 里要写**电脑的局域网 IP**，不写 `localhost` ——
  包是在手机上跑的，`localhost` 指的是手机自己。开发者工具里一切正常、
  一上真机就「网络好像断了」
- 🔴 **这个 IP 跟着网络走，换网必改。** 一天里撞了两次：先在手机热点下写成
  `172.20.10.4`，几分钟后切回 WiFi，那张网卡整个没了 —— 手机往一个不存在的地址
  发请求，没人拒绝也没人回应，表现是「等太久了」而不是「网断了」
- ⚠️ **改 `.env.*` 之后 watcher 不会自己重读**（实测：`manifest.json` 的 appid 它跟上了，
  env 没跟）。改环境变量一律 Ctrl+C 重启 `dev:mp-weixin`

---

## 7. AppID 与体验版

- 真 AppID 填在 `frontend/src/manifest.json` 的 **`mp-weixin.appid`**。
  顶层那个 `appid` 是 DCloud 的，**别往那里填微信的**
- ⚠️ 改它之后要重跑 `dev:mp-weixin` —— appid 是编译时写进
  `dist/.../project.config.json` 的
- 体验版曾因为 `.env.production` 是**空串**而「网络好像断了」——
  空地址的包一切正常地编译、上传、通过审核流程，**只在打开的那一刻连不上任何东西**
- 体验版默认**校验合法域名**，`http://` 裸 IP 过不了，体验者要在小程序里打开「开发调试」
- 上传时会被 flag `lazyCodeLoading is not turned on`

---

## 8. 微信云托管（免备案路线）

环境 id `cloud1-d2gq6r8wb670ae313`。选它的唯一理由：小程序经
`wx.cloud.callContainer` 走微信内部通道，**不需要 https 域名、不需要网站 ICP 备案**。

代码侧当时已就绪：

- `backend/Dockerfile` + `.dockerignore`
- 后端 `/auth/login`：`TRUST_WX_OPENID_HEADER=true` 时信 `X-WX-OPENID` 头。
  🔴 这个开关**只能在云托管环境里开** —— 别处这个头谁都能伪造，开了就是后门
- 前端 `request.js`：两个环境变量都非空时走 `callContainer`，否则照旧
- `App.vue`：小程序启动时 `wx.cloud.init({ env })`

三个跟 `wx.request` 不一样、写错了只在云上坏的地方：

1. **GET 的 query 要自己拼进 path**。`wx.request` 会把 data 转成 query，
   `callContainer` 文档只说「其余参数同 wx.request」—— 与其赌它的实现，不如自己拼
2. path 是相对容器根的（路由挂在 `/v1`），不走 `API_BASE`
3. 必须带 `X-WX-SERVICE` 头（环境里可以有多个服务，不带打不到人）

已知风险（当时排的）：

1. 🔴 **配图会丢**：容器磁盘是临时的，发版、重启、缩容都清盘
2. **任务队列是单实例假设**：实例数要固定最小 1 / 最大 1
3. **`callContainer` 请求限 100K**：名单 xlsx 导入（base64 约 27KB/50 人）几百人会顶到
4. **费用**：云托管按量 + PostgreSQL 包年包月，低流量下每月几十到一百多元

---

## 9. openid 那套身份模型

- **老师不登录，身份就是 openid。** `wx.login` 静默给 code → 后端换 openid →
  `teachers` 用 openid 做唯一键 upsert。没有账号密码，她自己也看不见
- **换手机 openid 不变；换微信号 = 一个全新账号**
- **openid 是随机串，微信不告诉我们它属于谁** —— 这是兑换码存在的全部理由
- **换微信了靠换绑码**（`account_rebinds`，014 迁移）：一次一码、7 天有效、只能用一次。
  它挪 openid、保留额度记忆和已同意的协议，并**返回新 token**
  （她手上那个 JWT 指向被删掉的行，不换就 401）
- 🔴 **换绑会让旧设备当场失去访问**（`token_version`，015 迁移）。这一条是做完之后
  测出来才补的：换绑把 openid 挪到**旧那一行**上，所以旧 token 指向的行还在、
  `status` 还是 active，`requireAuth` 拦不住它 —— 而换绑的常见起因就是手机丢了。
  **注销没有这个问题**（它把 status 改成 deleted，requireAuth 那道立刻生效）
- **老师端那个输入框不许把手机号设成必填**：换绑发生在全新微信上，
  她落在「首次激活」那一屏、手上却是换绑码。设成必填按钮永远是灰的，
  换绑在界面上直接被堵死（第一版就是这么错的）

> web 端：`token_version` 这条**保留**（重置密码、注销要用）。其余作废。

---

## 10. 内容安全 `msgSecCheck`

老师输入和 AI 输出都要过微信 `msgSecCheck` —— 小程序有 UGC 不做内容安全，审核过不了。

**一次都没真正调通过**（本地靠 `CONTENT_CHECK_ENABLED=false` 绕过）。

> web 端没有微信审核这个甲方，改用腾讯云文本内容安全（TMS）。

---

## 11. 杂项

- **H5 仲裁不了「只有微信才出错」那一类**：点了没反应（handler key 撞车）、
  字号档不生效（样式隔离）、WXML 编译错误、真机字体度量。
  顺序是「H5 里量准 → 编译产物核对 → 他在微信里确认一次」
- **`prototype/index.html` 不是第二个实现**，是讲设计方向用的。
  在它上面指元素改不到任何代码 —— 要指元素看，开 H5 dev server
