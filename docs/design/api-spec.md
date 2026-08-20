# 接口约定 · API Spec

前后端并行开发的契约。**改接口必须先改这份文档**，否则前后端会各写各的。

- Base URL：`https://api.<你的域名>/v1`（必须 HTTPS + 已备案域名，微信小程序强制）
- 认证：除登录外，所有请求带 `Authorization: Bearer <token>`
- 编码：请求与响应一律 UTF-8 JSON
- 时间：ISO 8601 带时区，如 `2026-08-16T14:30:00+08:00`

---

## 0. 统一响应格式

**成功**
```json
{ "ok": true, "data": { ... } }
```

**失败**
```json
{ "ok": false, "error": { "code": "RATE_LIMITED", "message": "请稍后再试", "retryable": true } }
```

`message` 是**可直接展示给老师的中文文案**，前端不要自己拼错误话术——话术统一在后端，方便日后调整措辞。

### 错误码表

| code | HTTP | 展示文案 | 可重试 |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | 登录已过期，请重新进入 | 否 |
| `NOT_FOUND` | 404 | 没有找到这份教案 | 否 |
| `VALIDATION_FAILED` | 400 | 提交的内容有点问题 | 否 |
| `RATE_LIMITED` | 429 | 有点忙，请稍等一下再试 | 是 |
| `MODEL_TIMEOUT` | 504 | 生成超时了，再试一次通常就好 | 是 |
| `MODEL_FAILED` | 502 | 生成没成功，换个说法再试试 | 是 |
| `IMAGE_FAILED` | 502 | 配图没生成出来，可以重试 | 是 |
| `NOT_IMPLEMENTED` | 501 | 这个功能还在做，先用别的方式吧 | 否 |
| `QUOTA_EXCEEDED` | 403 | 这个月的额度用完了，完成任务可以再拿一些 | 否 |
| `NOT_ACTIVATED` | 403 | 需要兑换码才能使用 | 否 |
| `IMAGE_LIMIT_EXCEEDED` | 403 | 一份教案最多配 3 张材料图 | 否 |
| `INTERNAL` | 500 | 出了点问题，我们已经记录下来了 | 是 |

`NOT_IMPLEMENTED` 与 `INTERNAL` 的区别在 `retryable`：功能没做完的接口重试多少次都不会成功，
必须标成不可重试，否则前端的自动重试会变成死循环。目前只有导出 docx 和配图（未配豆包 key 时）用它。

---

## 1. 登录

### `POST /auth/login`

```json
// 请求
{ "code": "微信 wx.login 返回的 code" }

// 响应
{ "ok": true, "data": {
  "token": "jwt...",
  "expires_in": 2592000,
  "teacher": {
    "id": 1, "nickname": "李老师", "avatar_url": "...",
    "kindergarten_name": "阳光幼儿园", "age_group": "中班", "teaching_years": 5,
    "profile_completed": true
  }
}}
```

后端拿 code 去微信换 openid。`profile_completed` 为 false 时前端跳档案引导页。

---

## 1.5 激活与额度

> 完整运营模型见 `operations.md`。这不是公开产品：**没有兑换码进不来，没有任务没有额度**。

### `POST /auth/login` 响应新增两个状态位

```json
{ "teacher": { "activated": false, "agreed": false, "...": "" } }
```

前端据此决定落在哪个页：`activated=false` → 待激活页；`agreed=false` → 协议页；都为 true 才进主流程。

**响应里永远没有 real_name**，包括老师自己的 —— 姓名只活在服务端与管理后台。
**手机号根本不存**（2026-08-19 起那一列从库里删掉了）。

### `POST /auth/redeem` · 一个输入框，三件事

```json
{ "code": "stem 4k7p qx3m", "roster_entry_id": 42 }   // roster_entry_id 只有首次激活才要
// → { "ok": true, "data": { "teacher": {...}, "quota": {...},
//      "granted": { "text": 20, "image": 10 },
//      "kind": "activate" | "topup" | "rebind",
//      "token": "…" } }                                // 只有 rebind 会回 token
```

**库里没有老师的手机号**（2026-08-19 起彻底删掉了那一列）。
她的手机号只在问卷星那边 —— 要联系她、要发奖励，去那边看答卷。

老师端只有一个输入框，她分不出也不需要分。后端按码的类型决定做哪件事：

| `kind` | 什么时候 | 做什么 |
|---|---|---|
| `activate` | `activated_at` 为空 | **首次激活**：要**码 + 手机号**，见下 |
| `topup` | 已经激活过 | **续兑**：只要码，只加额度，**身份一个字段都不动** |
| `rebind` | 输的是换绑码 | **挪 openid**，不发额度，**响应带新 token** |

#### 首次激活：码 + **从名单里选自己是谁**（2026-08-19 定稿）

老师**不登录** —— 微信静默给一个 openid，那是一串随机字符，
微信不告诉我们它属于哪个自然人。所以「她是谁」必须由别的东西建立：

| | 证明什么 | 怎么给 |
|---|---|---|
| **兑换码** | 你是这批人里的 | 问卷星在她提交答卷后当场发（不用人工私发） |
| **从名单里选** | 你是**哪一个** | 园所 → 班级 → 岗位·姓氏，四级选下来 |

**为什么是「选」而不是「填手机号」**（这一版换掉了前一版）：

- **手机号是 11 位手打，打错一位是常事**，而她分不清是「码坏了」还是「我打错了」。
  从列表里认自己，出错概率低一个数量级
- 手机号本来也不是秘密（微信群、报名表上都有），当第二把钥匙其实不硬
- 她要证明的事情本来就只是「我是阳光幼儿园小一班的主班」，
  这句话里**没有手机号**。库里少一样可识别到人的东西，就少一整套合规义务

**要认下来的代价**：从列表里选是一个**表单字段，不是钥匙**。谁有码都能滚到任何一行。
所以真正的门槛只剩码那一把。可以接受，因为：

- 同事之间冒领**没有收益** —— 她自己填问卷也能拿到同样的额度
- 真会发生的是**认错**（手滑选了同班另一位），而那件事**可查可改**：
  名单那一行记着 `claimed_openid`，我看得到是谁认领的、什么时候，解绑重指就行

⚠️ **拉名单必须先有一个有效的码**（见 `POST /auth/roster/options`）。
不设这道门，任何人打开小程序就能看到一整个园的老师名单。

⚠️ **姓名只给姓氏**（`王**`）。她要认出自己够了，而把同事全名摊给
任何拿到码的人是没必要的暴露。

流程：码存在且 `unused` → 名单那一行存在且 `pending` → **两个都对**才在一个事务里
标记码已用、名单 `claimed`、把名单那行的身份写进 `teachers`、发首笔额度、置 `activated_at`。

🔴 **校验失败绝不能消耗那个码。** 顺序是**先全部校验，再全部落库**。

错误文案要分得清，这是她唯一的线索：

| 情况 | 文案 |
|---|---|
| 码不对 | 这个兑换码不存在，检查一下有没有敲错 |
| 那一行已被认领 | 这个位置已经有人认领了。要是被同事选错了，跟我们说一声 |
| 那一行作废了 | 名单上这一条已经作废了，找园长确认一下 |

#### 三层身份：人 / 位置 / 账号

长期研究里「追踪对象是这位老师，还是这个班」会变，所以身份分三层：

| 层 | 是什么 | 什么时候变 |
|---|---|---|
| `teacher_roster.teacher_ref` | **人**。我在录名单时分配的编号 | 永不变，跨班跨园跟着她 |
| `teacher_roster.id` | **位置**（class_teacher_id）：人 × 园 × 班 × 岗位 | 她换班就新开一行，`teacher_ref` 不变 |
| `teachers.id` | **账号** | 换微信靠换绑码保住 |

`teachers.roster_entry_id` 指向她认领的那个位置。于是：
**想追人就按 `teacher_ref` 归组，想追班就按（园所 + 班级）归组。**

她换班时由我在后台挪（新开一行、同一个 `teacher_ref`、把她的账号指过去），
**她什么都不用做**。

#### 续兑（任务奖励）

**只要码，不用再选身份** —— 她已经被识别过了。**身份一个字段都不动**。

#### 换绑（她换了微信）

见下一节。同一个输入框，但它不发额度，而是把旧账号挪到新 openid 上。

#### 通用

- 输入**宽容**：大小写、空格、下划线、各种横线都认。认不出来是我们的问题，不是老师的
- **一个码只能兑一次**（`status = 'used'` + `FOR UPDATE` 挡并发）
- **保留「绑定码」路径**（码上直接带手机号姓名）：它自带身份、不查名单，
  留作名单外的个别情况（临时给某位老师开通）。不是主路径

### `POST /auth/redeem` 的换绑分支 · 她换了微信号

老师的身份就是 openid。换手机 openid 不变，但**换微信号 = 一个全新账号** ——
她的教案、额度、记忆全在那个进不去的旧账号里。

**为什么不是「把名单那行改回 pending 让她重新领」**：那样会新建一个账号，
**教案拿不回来**，而教案是这个产品全部的价值。换绑保留教案、额度台账、记忆，
以及她**已经同意过的协议**（所以换绑成功后她直接进主流程，不再走一遍协议页）。

事务：

1. 锁 `account_rebinds` 那一行，校验 `pending` 且没过期
2. 目标账号不能是 `status='deleted'` —— 换绑回一个注销过的账号等于绕过注销
3. **当前这一行（新微信刚建的）必须是空的**：没有教案、没有额度台账。
   不空就拒绝 —— 她在新微信上已经写了东西，换绑会把那些孤立掉
4. 先删当前那一空行（释放 openid 唯一约束），再把目标行的 openid / unionid
   换成新的，顺带更新昵称头像
5. 标记码已用，记 `old_openid` / `new_openid`
6. `teachers.token_version + 1`，然后**返回新 token**。这一步不是可选的，有两个原因：
   她手上的 JWT 指向刚被删掉的那一空行，而且目标账号的 token_version 变了。
   **前端必须保存它**（`session.js` 的 `redeem()`）

**旧设备当场失去访问**（`token_version`，015 迁移）。这一条是做完之后测出来才补的：
换绑是把 openid 挪到**旧那一行**上，所以旧 token（payload 里只有 teacher_id）
指向的行还在、`status` 还是 `active` —— `requireAuth` 那道「非 active 就拒」拦不住它，
旧设备本来能再用满一个 JWT 周期。而**换绑的常见起因之一就是手机丢了**，
「换绑」这个词让任何人都以为旧设备当场失效 —— 假设错一个安全属性比没有它更糟。

做法：`signToken` 把 `tv` 写进 payload，`requireAuth` 逐个请求跟库里的
`token_version` 比对（那一行本来就每次都查，成本是零）。老 token 里没有 `tv`，
读出来 undefined 当 0 看，跟列默认值一致 —— **现有登录不会被强制退出**。

注：**注销没有这个问题**。它把 `status` 改成 `deleted`，
而 `requireAuth` 拒绝一切非 `active`，所以那一刻已签发的 token 全部立刻作废。

**不做「输手机号自动换绑」**：那等于「知道她手机号 + 有任意一个码 = 接管她账号」，
正是名单那套设计要避开的弱点。换绑必须由管理员发起。

**换绑要求新微信上是空的**（没有教案、没有额度台账）。不空就拒绝：
她在新微信上已经写过东西，换绑会把那些孤立掉。宁可让她先清空。

⚠️ **老师端那个输入框不能把手机号设成必填。** 换绑发生在一个**全新的微信**上，
她那时落在「首次激活」那一屏、手上却是换绑码 —— 没有手机号要填。
第一版就是这么错的：按钮永远是灰的，换绑在界面上被堵死。
现在是「有码就能点」，缺手机号由后端那句话来说。

### `POST /auth/roster/options` · 让她从名单里找到自己

激活那一屏的三级选择器。**必须带一个有效的码才给数据** ——
不设这道门，任何人打开小程序就能看到一整个园的老师名单。

```jsonc
// 第一步：有哪些园（只列还有未认领位置的）
{ "code": "stem 4k7p qx3m" }
// → { "kindergartens": [ { "id": 1, "name": "阳光幼儿园", "open": 6 } ] }

// 第二步：这个园里有哪些位置
{ "code": "stem 4k7p qx3m", "kindergarten_id": 1 }
// → { "entries": [
//      { "id": 42, "class_name": "小一班", "position": "主班",
//        "age_group": "小班", "surname": "王" } ] }
```

- 只回 **`pending`** 的位置。已经被认领的不出现 —— 她看到一个选不了的选项只会困惑
- **姓名只给姓氏**。她认自己够了，把同事全名摊给任何拿到码的人是没必要的暴露
- 码无效 / 已用 / 作废 → 直接报错，**不回任何名单数据**
- 这个接口挂在 `requireAuth` 后面但**不要求已激活**（否则就是「要激活才能激活」的死循环）

一个班有两个配班时，`surname` 就是区分它们的那一项。
两个配班同姓的话再加 `note`（后台录名单时可以填「配班（靠窗）」这种）。

### `POST /me/agree` · 同意协议

激活后、进主流程前必须调一次。协议内容见 operations.md 第 2 节，其中这句要加粗：
**「你的幼儿园和园长看不到这里的任何东西。」**

### `DELETE /me` · 注销：删掉我的全部数据

不可逆。语义是**留壳去身份**，不是 `DELETE FROM teachers`：

| 删 | 留 |
|---|---|
| 对话、教案、版本、配图（连磁盘文件）、记忆 | 那一行的 id 和 openid |
| 手机号、姓名、昵称、头像、园所班级岗位 | 额度台账、已提交的建议与评价 |

留 openid 是为了认出「这个人注销过」并**拒绝她再次登录** ——
真删行的话她再登录就是个全新账号，等于「删完还能接着用」，与承诺相反。
留下的那些记录从此不再关联到任何姓名手机号。

注意：拦「不能再用」靠的是 openid（同一个微信）。手机号是真删的，
所以**换一个微信 + 同一个手机号可以重新报名** —— 要堵死这条得留手机号哈希，
那就跟「删除全部数据」自相矛盾了。

### `GET /me/quota` · 余额

```json
// → { "quota": { "text": {"granted":20,"used":3,"left":17}, "image": {...} },
//     "grants": [ { "text": 20, "image": 10, "reason": "完成8月问卷·首次", "at": "..." } ],
//     "free_revisions": 2 }
```

**「我的」页不再展开台账**（2026-08-18 用户定）。原来那块可展开的发放明细
换成了**兑换入口** —— 老师在这一屏真正要做的是「我拿到码了，兑进来」，
而不是核对历史。对账用一个 **`n/m`** 就够（用了 n，一共 m）：
数字本身就是台账的结论，展开一列明细是把我的对账需求摊给她看。

`grants` **仍然在响应里**（不删接口字段），只是界面不用了。
真要查某一笔的来历，后台的老师详情页有完整台账。

### 额度闸门装在哪

| 接口 | 查什么 | 为什么在这 |
|---|---|---|
| `POST /conversations` | 文案 ≥ 1 | **在最前面**。让老师答完 4 题、等 20 秒生成，最后才说额度不够，是最糟的时机 |
| `POST /lesson-plans/:id/revise` | version ≥ 3 时查文案 | 前两次改稿免费。查在提问之前 —— 问完三个问题再说没额度等于白问 |
| `POST /lesson-plans/:id/images` | 配图 ≥ 1 | 与每日 10 张的防刷上限**并存**，两道闸管的是两件事 |

额度不足返回 `QUOTA_EXCEEDED`，文案里**必须带出路**（怎么才能再拿到），只说"用完了"是死胡同。

---

## 1.6 反馈

### `POST /lesson-plans/:id/rate` · 教案评价

```json
{ "rating": "usable | needs_edit | unusable", "text": "材料太多了" }
```

**绑 lesson_plan_id + version**。后台看到的是「大班搭高塔的 v2 被标了用不了，原文在这」，
而不是一句无从查起的抱怨。同一份教案同一版本重复提交是**覆盖**（老师改主意很正常）。

这是「教案是否真的适龄可用」这个最大未知数的持续数据源。

### `POST /feedback` · 产品建议

```json
{ "category": "quality | feature | usability | other", "text": "…" }
```

两者的正文都过 `msgSecCheck`，都不进日志（只记分类和长度）。

---

## 2. 老师档案

### `GET /me`
返回同上 `teacher` 对象。

### `PATCH /me`
```json
{ "kindergarten_name": "阳光幼儿园", "age_group": "中班", "teaching_years": 5,
  "preferences": { "template_format": "表格式" } }
```
只传要改的字段。

---

## 3. 教案会话（核心）

### `POST /conversations` · 从首页那句话开新会话

```json
// 请求
{ "seed_input": "我想做个浮与沉的活动" }

// 响应 —— 一次把全部问题都给出来
{ "ok": true, "data": {
  "conversation_id": 1024,
  "status": "draft",
  "progress": { "answered": 0, "total": 4, "required_left": 1 },
  "questions": [
    { "id": "q1", "key": "age_group", "title": "这次活动是给哪个年龄班的？", "hint": "选一个",
      "multi": false, "required": true, "allow_custom": false,
      "options": [
        { "key": "A", "label": "小班", "sub": "3-4 岁" },
        { "key": "B", "label": "中班", "sub": "4-5 岁", "recommended": true },
        { "key": "C", "label": "大班", "sub": "5-6 岁" }
      ] },
    { "id": "q2", "key": "focus",   "title": "你希望孩子主要收获什么？",   "multi": true,  "...": "" },
    { "id": "q3", "key": "venue",   "title": "打算在哪里做？",           "multi": false, "...": "" },
    { "id": "q4", "key": "constraints", "title": "班上有什么情况要我考虑？", "multi": true, "...": "" }
  ]
}}
```

**为什么一次给全，而不是一题一题喂**：老师看不到总量时，答完一题不知道还剩几题，
心里没底就容易中途退出。一屏摊开、顶部一条进度、随时看得到「还差一题」，比逐题揭晓好。

**只有 4 题，而且都是模型猜不到的**：

| 问 | 为什么非问不可 |
|---|---|
| 年龄班 | 决定整套适龄规则。**唯一必答项** |
| 教学重点 | 老师的教学意图，同一个主题不同老师侧重完全不同 |
| 场地 | 户外空地搭跷跷板，还是教室区角做桌面游戏，活动形态完全是两回事 |
| 班上的情况 | 人数、材料、人手，每个园都不一样 |

**不问时长** —— 年龄班一确定时长就定了（取该班最常用值），再问一遍是让老师替代码做算术。
她要改，成稿页直接改。

其余全部由模型按教学框架和年龄班规则自己产出：材料、流程、要问孩子什么、安全事项、
评估方式、延伸活动。判断标准只有一条 —— **只问模型猜不到的，不问模型本来就该会的**。

推荐答案基于老师档案里的年龄班生成（她只带一个班，档案稳定）。
她要是在 q1 选了跟档案不同的班，前端可以调 `GET /conversations/:id/questions?age_group=大班` 重拉一次。

### `POST /conversations/:id/answer` · 答一题，即时落库

```json
// 请求
{ "question_id": "q3", "selected": ["A"], "custom_text": null }

// 响应
{ "ok": true, "data": {
  "progress": { "answered": 3, "total": 4, "required_left": 0 },
  "ack": "户外场地够大，跷跷板可以真的搭起来。",
  "can_finish": true,
  "ready_to_generate": false
}}
```

- **每次调用即落库**（PRD 要求：老师被打断退出后进度不丢）。
  一次性出题不等于一次性提交 —— 前端每选一项就调一次，她中途被叫走也不丢
- **不限顺序**：想先答哪题就先答哪题，跳着答也行
- 同一题重复提交是覆盖，不是报错 —— 她改主意很正常
- `ack` 是对这一题的一句话回应，前端显示在该题下方
- `can_finish` 只看年龄班答没答：没有年龄班，生成出来的一定是错的

### `GET /conversations/:id/questions` · 换了年龄班时重拉推荐答案

```json
// GET /conversations/1024/questions?age_group=大班
// → { "ok": true, "data": { "questions": [ ...除年龄班外的三题，推荐答案按大班重新生成... ] } }
```

老师已经答过的内容不会被清空，只换推荐答案。

⚠️ **推荐答案必须由后端生成**，因为它要综合年龄班规则、老师档案和记忆。前端不许硬编码任何推荐项。

### `GET /conversations/:id` · 断点续写时拉取

返回会话全量：已答题目、当前进度、当前待答题目。

---

## 4. 生成教案

### `POST /conversations/:id/generate`

生成耗时 15–30 秒，**必须异步**，否则微信小程序请求会超时。

```json
// 响应（立即返回）
{ "ok": true, "data": { "task_id": "gen_88", "status": "generating" } }
```

### `GET /conversations/:id/generate/status` · 轮询

```json
{ "ok": true, "data": {
  "status": "generating",           // generating | completed | failed
  "progress_hint": "正在设计教学流程…",
  "lesson_plan_id": null
}}
```

前端每 2 秒轮一次，显示 `progress_hint`（后端按生成阶段推进文案，让等待有反馈）。

> **为什么不用 WebSocket**：小程序里长连接的断线重连和后台挂起处理成本高，而这里只需要一个 30 秒内的结果。轮询更简单可靠。若日后要做流式逐段显示，再换 SSE。

---

## 5. 教案

### `GET /lesson-plans/:id`

```json
{ "ok": true, "data": {
  "id": 77, "title": "浮与沉：谁能浮在水面上",
  "age_group": "中班", "duration_min": 30,
  "content_json": {
    "intent": "设计意图，两三句",
    "objectives": [
      { "dimension": "认知", "text": "…" },
      { "dimension": "能力", "text": "…" },
      { "dimension": "情感", "text": "…" }
    ],
    "key_points": { "focus": "活动重点", "difficulty": "活动难点" },
    "preparation": {
      "experience": ["经验准备：孩子之前得有什么经验"],
      "material": ["物质准备：透明水盆 4 个", "塑料瓶盖 20 个"]
    },
    "flow": [ { "stage": "导入", "minutes": 5, "detail": "洗手时有小朋友发现…" } ],
    "extension": "活动延伸，一段话",
    "safety": ["…"],
    "steam": { "S": "…", "T": "…", "E": "…", "A": "…", "M": "…" },
    "indicators": ["《指南》领域指标"],
    "dialogue": [ { "speaker": "T", "text": "…" } ]
  },
  "content_md": "# 浮与沉…",
  "images": [ { "id": 3, "section_key": "preparation.material.1", "url": "https://…", "status": "ready" } ]
}}
```

### `content_json` 的结构（2026-08-20 改版）

板块顺序 = **中国大陆幼儿园常见的教案格式**，分三层：

| 层 | 板块 | 字段 |
|---|---|---|
| **教案正文**（她打印出来交给园里的） | 设计意图 / 活动目标 / 活动重点与难点 / 活动准备 / 活动过程 / 活动延伸 / 安全提示 | `intent` `objectives` `key_points` `preparation` `flow` `extension` `safety` |
| **特征标注**（帮她理解这个活动，不是正文） | STEAM 五域 / 《指南》领域指标 | `steam` `indicators` |
| **教学实例** | 师生对话 | `dialogue` |

改版的理由和取舍见 `docs/design/lesson-structure-and-modes.md`。要点：

- **`objectives` 正好 3 条**，`dimension` 只能是 `认知` / `能力` / `情感`，
  后端硬校验（`enforceAgeBand`）会查「三个维度各一条」——
  模型天然会写出三条其实都是认知的目标，那是大陆教案评审最先挑的毛病
- **已删除的字段**：`features`（拆进 `intent` / `objectives`）、
  `reflection`（教学省思 —— 活动还没做，写不出「预期与实际的差异」）、
  `materials`（搬进 `preparation.material`）
- **`section_key` 有两种前缀**：改版前的图写 `material.N`，之后写 `preparation.material.N`。
  后端两种都认。**旧图的 section_key 一律不动** ——「图片永不跟着版本走」是定死的规则，
  所以两种前缀会长期并存
- **旧格式教案不做兼容渲染**（用户 2026-08-20 定）。前端认出没有 `objectives`
  就退回显示 `content_md` 原文 + 一句说明。不做双套渲染、不重新生成

### `PATCH /lesson-plans/:id`
局部编辑，传 `content_json` 的某个路径。后端据此重渲染 `content_md`，两份不允许各自漂移。

### `POST /lesson-plans/:id/export`
```json
{ "format": "docx" }
// → { "ok": true, "data": { "url": "https://…", "expires_at": "…" } }
```
导出链接有效期 1 小时。

### `POST /lesson-plans/:id/revise` · 老师说哪里不对，拿到追问

```json
{ "feedback": "孩子人数写多了，我们班只有 15 个；而且没有那么多水盆" }
// → {
//   "ok": true,
//   "data": {
//     "revise_round": 1,
//     "ack": "明白，15 个孩子、水盆不够，我重新安排分组。",
//     "questions": [ { "id":"r1_1", "title":"…", "options":[…], "multi":false, "allow_custom":true }, … ]
//   }
// }
```

固定返回 **3 道**追问，且**必须是引导阶段没问过的**——老师已经答过一遍的问题再问一遍，
是在惩罚她提意见。唯一的例外是她的反馈明确指向之前某个答案（"时长还是改成 20 分钟吧"），
这时才允许重新问那一题。

`feedback` 上限 300 字，走 `msgSecCheck`。

### `POST /lesson-plans/:id/revise/answer` · 答完追问，重新生成

```json
{ "revise_round": 1, "answers": [ { "question_id":"r1_1", "selected":["A"], "custom_text":null }, … ] }
// → { "ok": true, "data": { "task_id": "gen_1024", "status": "generating" } }
```

之后仍然轮询 `GET /conversations/:id/generate/status`——改稿和首次生成走同一条异步链路，
前端不用写两套轮询。重新生成会覆盖原教案并把 `version + 1`，历史反馈全部保留在
`conversations.collected.revisions` 里，下次改稿时一并喂给模型，避免它把上次已经改好的地方又改回去。

---

## 6. 配图（2026-08-17 改：画的是**材料**，不是活动场景）

老师要的不是"一张示意插画"，是**照着能去准备东西**。所以配图对象从活动场景改成
材料清单里的具体材料，一份教案最多 3 张，集中放在教案最后的「活动材料」一节，
不再穿插进教学流程。

顺带解决一个风险：画材料实物就不该出现儿童，**儿童面孔这个最麻烦的问题直接不存在了**。

### 图是**要打印出来在活动里用的**（2026-08-17 补，这条决定了一切）

老师不是拿它看，是拿它印。所以「画成什么形状」取决于**印出来干什么**：

| `purpose` | 中文 | 印出来干什么 | 因此构图必须 |
|---|---|---|---|
| `material` | 材料图 | 认材料、照着去备料 | 单件占满画面、纯色底、无场景 |
| `worksheet` | 记录表 | 发给孩子写画 | 粗线大格子、格内**留白**、竖版、白底省墨 |
| `headwear` | 头饰 | 剪下来戴头上 | 中间图案 + **左右两条水平长带**，横版 |
| `display` | 展示图 | 贴在展示板上介绍材料 | 网格分隔，一格一样东西 |
| `backdrop` | 环创背景 | 贴墙做主题墙 | 横向通景，**中间留白**给孩子作品 |

**所有用途都禁止画文字**：模型写出来的中文一定是乱码，印出来是废纸。
需要表头、标签的地方用简笔图标代替。

### `POST /lesson-plans/:id/images`
```json
// 从材料清单里选
{ "purpose": "material", "section_key": "material.3", "note": "塑料小碗" }
// 老师自己说要什么（没有 section_key）
{ "purpose": "backdrop", "note": "海洋主题的背景墙，中间留白贴孩子的画" }
// 指定用哪个模型（可选，来自设置页）
{ "purpose": "worksheet", "note": "记录浮沉结果", "provider": "gpt" }
// → { "ok": true, "data": { "image_id": 3, "status": "pending", "purpose": "material", "provider": "gpt" } }
```

- `purpose` 决定构图规则和画布比例，默认 `material`。不认识的值一律按 `material`
- **`provider` 不接受客户端指定**（2026-08-18）。用哪个模型由管理后台定，
  请求里传了也不看 —— 客户端是可以被改的，技术选型的开关不该交出去。
  响应里仍会回 `provider`，那是**告诉你实际用了哪家**，不是回显你传的值。
  为什么老师不选：用哪家是技术判断（哪家把记录表画对了、哪家快、哪家便宜），
  她既没有判断依据，选错了还会怪自己

### ~~`GET /me/image-models`~~ · **已下线**（2026-08-18）

老师端不再有任何跟模型有关的接口。曾经有过一个给设置页用的列表，
在「老师不选模型」这条定下来之后一并删掉了 —— 留着它等于留一个没人用、
却会泄露我们在用哪几家的出口。

### 管理后台：`/admin/api/image-models`（**超管专属**）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/image-models` | 列表。`api_key` 一律遮成 `sk-abcd…wxyz` |
| POST | `/image-models` | 加一个。`format` 必须是已知的三种之一 |
| POST | `/image-models/:key/update` | 改。**`api_key` 留空 = 不改** |
| POST | `/image-models/:key/delete` | 删。已经画出来的图不受影响 |
| POST | `/image-models/:key/test` | 试画一张，直接看效果 |
| POST | `/image-models/:key/default` | **设为默认**（老师配图用的就是这一个） |

「设为默认」存进 `app_settings` 表而不是 `.env`，所以**改完立刻生效、不用重启**。
取值顺序：`app_settings` > `.env` 的 `IMAGE_PROVIDER` > 列表第一个 ——
全新部署时数据库里什么都没有，靠 `.env` 兜底照样能跑。

`format` 决定怎么拼请求、怎么解返回，目前三种：
`openai_images`（Bearer，size 用「宽x高」）、`gemini`（key 走 URL，尺寸用
`aspectRatio` + `imageSize`）、`minimax`（Bearer，自带润色开关）。
**同格式加新模型 = 填一行配置，不用改代码**；只有出现第四种格式时才需要写适配器。

为什么加模型在后台而不是小程序设置页：填一个模型要给接口地址和 API key，
而「API key 只在服务端、任何情况不下发到小程序」是这个项目的铁律。
让老师在手机上敲 key，等于把钥匙串挂在门上，而且任何一个老师都能改所有人用的模型。
- `section_key` **可选**，形如 `material.<下标>`；老师自由描述时没有它
- `note` 是老师看到的那句话（材料名或她自己的描述），原样记进 `prompt_cn`，
  也是界面上这张图的标签。自由描述时**必填**
- **一句话里说了好几样**（「我需要准备小狗、小猫和兔子的头饰」）：后端数出几样，
  头饰**画在同一张纸上、上下排开**，条与条之间留白好下剪刀；画布相应变高
  （1 条 2048×1024，3 条 2048×1536），最多 4 条。
  **不拆成几张**：一份教案总共才 3 张配额，一句话吃光配额是另一种糟糕。
  修的是一个实测到的静默 bug —— 原来构图规则里写死「中间一个图案」，
  模型只能挑一个，小猫和兔子被悄悄丢掉，而图片标签上还写着完整那句话
- **每份教案最多 3 张**（`IMAGE_LIMIT_EXCEEDED`，不可重试）。这是内容判断不是成本判断：
  三张以上老师就不看了，而且越多越像商品目录，离教案越远

### 尺寸：按打印来定，不是按屏幕

出图一律 2048 长边（约 A4 250 DPI）。屏幕上根本不需要这么大，但**这图的终点是打印机**，
1152×864 印出来在 A4 上只有约 140 DPI，线条发虚。代价是一张从 30 秒变成约 47 秒。

比例跟着 `purpose` 走：记录表竖版、头饰和背景墙横版、材料图方版。

### `GET /lesson-plans/:id/images/:image_id`
轮询取结果，`status` 转 `ready` 时带 `url`、`width`、`height`、`purpose`、`provider`、`label`。

### 下载

前端用 `uni.downloadFile` + `uni.saveImageToPhotosAlbum` 存到相册，老师再从相册发到
电脑或直接连打印机。`url` 给的就是原图（2048 长边），**不做缩略图** ——
屏幕上 `<image mode="widthFix">` 自己缩，而她要的恰恰是那个大的。

小程序要在 `manifest.json` 里声明 `scope.writePhotosAlbum`，第一次保存会弹授权。
她拒绝了要给一句话说明怎么在设置里打开，不能静默失败。

### 图片与版本的关系：**图永远不跟着版本走**

改稿、回退都不动图片。理由是老师的行为本身：她只在觉得这样材料值得画的时候才点生成，
那份判断不会因为教案改了一句话就失效。

技术上这件事是天然成立的 —— `lesson_images` 挂在 `lesson_plan_id` 上，
而改稿是覆盖同一行、只把 `version + 1`，行 id 从不变。**任何地方都不许按版本清理图片。**

代价是材料清单改了以后，图可能对不上现在的清单。所以每张图必须带着 `note`（材料名）显示，
让老师自己判断这张还用不用得上，而不是我们替她删掉。

⚠️ 后端仍要做**每日配图次数上限**（每人每天 10 张）。跟上面那个 3 张管的是两件事：
每份 3 张管的是这份教案里多少图才有用，每天 10 张管的是防刷。

---

## 6.5 版本与回退（2026-08-17 新增）

老师改完可能觉得还不如上一版。改稿是覆盖式的，不留退路等于逼她赌一把。

### `GET /lesson-plans/:id/versions`

```json
{ "ok": true, "data": { "versions": [
  { "version": 1, "title": "小水滴的沉浮游戏", "is_current": false,
    "duration_min": 20, "created_at": "…", "note": null },
  { "version": 2, "title": "小水滴的沉浮游戏", "is_current": true,
    "duration_min": 20, "created_at": "…", "note": "孩子人数写多了，我们班只有 15 个" }
], "current_version": 2 }}
```

`note` 是**产生这一版的那句改稿意见**（第 1 版没有）。列表里只给这一句，
老师认版本靠的是"我当时说了什么"，不是版本号。

### `POST /lesson-plans/:id/rollback`

```json
{ "version": 1 }
// → { "ok": true, "data": { "version": 1, "title": "…", "content_json": {…} } }
```

- 把那一版的内容写回当前教案，`current_version` 指过去。**不新增版本号，也不删任何版本** ——
  她可以来回切
- **不消耗额度**：回退不调模型，本来就是我们没给她退路造成的
- **不动图片**（见上一节）
- 之后再改稿，是从当前指向的这一版出发生成 `max(version) + 1`

---

## 7. 教案库

### `GET /conversations`

```
?status=all|draft|completed
&age_group=all|小班|中班|大班
&cursor=<上一页最后一条的 id>
&limit=20
```

```json
{ "ok": true, "data": {
  "items": [
    { "id": 1024, "title": "浮与沉：谁能浮在水面上", "status": "draft",
      "age_group": "中班", "progress_text": "进行到第 1 轮第 2 题，还剩 1 题",
      "has_image": false, "updated_at": "2026-08-16T14:30:00+08:00" },
    { "id": 1011, "title": "跷跷板为什么会翘起来", "status": "completed",
      "age_group": "大班", "lesson_plan_id": 76,
      "has_image": true, "updated_at": "2026-08-12T09:00:00+08:00" }
  ],
  "next_cursor": null,
  "counts": { "all": 4, "draft": 1, "completed": 3 }
}}
```

`counts` 供筛选器显示数量，避免前端再请求一次。

用 **cursor 分页而非 offset**：老师边用边新增，offset 分页会重复或漏条。

### `DELETE /conversations/:id`
软删除。

---

## 8. 用户记忆

### `GET /memories`
```json
{ "ok": true, "data": { "items": [
  { "id": 5, "fact": "主要带中班，孩子 4-5 岁", "mem_type": "教学信息", "is_pinned": false }
]}}
```

### `POST /memories` · 老师手动加一条
```json
{ "fact": "园里没有投影仪" }
```
手动添加的自动 `is_pinned = true`，不参与自动淘汰。

### `PATCH /memories/:id` · 编辑
### `PATCH /memories/:id` · 改一条 ＝ `POST /memories/:id/update`

**两个方法指向同一个 handler**（2026-08-18）。`PATCH` 是语义正确的那个，
但**微信小程序的 `wx.request` 发不出 PATCH**，所以加了 POST 别名给小程序用。

这不是洁癖：记忆会被喂进每次生成，「只能删不能改」逼老师删掉重打一遍，
而她要改的往往只是一个数字（「12 个孩子」→「15 个」）。

同一个缺口还卡着 `PATCH /me`（档案编辑）和 `PATCH /lesson-plans/:id`（成稿编辑），
要做的时候照这个模式加 `POST .../update` 别名。

### `DELETE /memories/:id` · 删除

⚠️ 记忆的**写入是后端自动的**（教案生成后异步提取），但**删改权必须完全在老师手里**。这是隐私底线，也是信任基础。

---

## 9. 前端必须处理的状态

每个涉及网络的界面都要有这四态：

| 状态 | 场景 | 表现 | 实现 |
|---|---|---|---|
| **加载中** | 首次进入、切筛选 | 骨架屏（不是转圈），保持布局稳定不跳动 | `<s-skel>` |
| **空** | 教案库无教案、任务为空 | 虚线框 + 一句引导 + **一条出路**（主行动按钮） | `<s-state kind="empty">` |
| **失败** | 请求失败 | 后端返回的 message + 重试按钮 | `<s-state kind="error">` |
| **无网** | 请求没到后端，且系统报告断网 | 同上，多一行「还是没有网络」；**网一回来自动重来** | `<s-state kind="offline">` |

另有一个跨屏的**生成中**态（不属于这四态，它是一条流程）：进度提示文案 + 可离开
（后台继续，完成后在教案库看得到）。**「可离开」是必须的** —— 生成要 30 秒，
老师在幼儿园随时被叫走，不能要求她盯着屏幕等。

### 收口时定下来的四条（2026-08-20）

1. **失败绝不能画成空。** 任务页原来把「拉失败」渲染成「现在没有可以做的事」，
   「我的」原来把失败渲染成 `0/0 次教案`。这两句都是假话，而假话的代价是
   **她不会重试，她会走**。判据：这一屏上的数字和列表，有任何一个是「没拿到」而不是
   「真的没有」，就必须整屏换成失败态。

2. **`kind` 由 `stateKind(err)` 算，不要手写。** 「无网」要两个条件同时成立：
   请求根本没发出去（`err.code === 'NETWORK'`）**而且**系统确实报告了断网。
   少了后半个条件就会把「wifi 好得很、是后端连不上」画成无网 ——
   让她去检查一件本来没问题的事，而真正的问题一个字没说。

3. **无网态里只说否定的那一面。** 网通着的时候一个字都不说。
   第一版写的是「网回来了 / 还是没有网络」，那句「网回来了」是编的
   （`net.online` 默认 true，而且实测 uni 的 H5 实现不烧 window 的 offline 事件）。
   这一屏正是她最需要准确信息的时候，宁可少说一句。

4. **自动重来只能挂在幂等且不花钱的动作上。** `<s-state>` 默认在断→通那一下
   自己触发一次 `action`，因为那几个 action 全都是「重新拉一次」。
   **提交类动作绝不能挂**（会重复提交），生成类更不能 ——
   生成页因此把失败分成两种：断网走「接着等」（只重新轮询，后端还在写，不花钱、可自动），
   真的没写成走「再试一次」（一次真的模型调用，只能她自己按）。
   原来这两条走的是同一个按钮，等于每次弱网抖一下就白花一次钱重写一遍。

**三屏走 toast 而不是整屏换掉**（豁免名单和理由在 `frontend/scripts/tokens-test.mjs` 第 5 条里）：
协议页是静态文字；兑换页和生成页的失败都发生在**她手上还握着的表单/流程上**，
整屏换掉会把她刚打的码扔了。`npm run test:tokens` 第 5 条查「打网络的页面有没有处理失败」，
豁免必须带理由 —— 一个没有理由的豁免过两个月就分不清是「想过了」还是「忘了」。

---

## 10. 安全与限流

- **所有 AI 调用在后端**。API key 绝不下发到小程序端
- 限流：单用户 `POST /conversations` 每小时 10 次、`generate` 每小时 20 次、配图每天 10 张
- 内容安全：老师输入和 AI 输出都要过微信内容安全接口（`security.msgSecCheck`）。小程序有 UGC 的必须做，否则审核不过
- 日志不记录完整对话正文，只记 id、耗时、token 数、错误码

---

## 11. 管理后台（`/admin/api`）

和小程序**完全隔离**：老师的 token 打不开这里，管理员的 token 也调不了 `/v1`。
标 **超** 的只有超级管理员能调（`requireSuper`）——判据只有一条：
**这个接口能不能读到老师写的东西或她的手机号全号**。能读到就锁。
新增接口时默认加 `requireSuper`，想开给一般管理员要先说清为什么运营工作需要它。

| 方法 | 路径 | 作用 | 超 |
|---|---|---|---|
| POST | `/login` | 用户名密码换 token（12 小时） | |
| GET | `/overview` | 概览：钱、谁在用、按园所消耗、等我处理。见下 | |
| GET | `/topups` | 充值台账 | |
| POST | `/topups` | 记一笔充值 | |
| GET | `/kindergartens` | 园所列表：**特征 ＋ 用量汇总**，见下 | |
| POST | `/kindergartens` | 建园所（重名拒绝） | |
| POST | `/kindergartens/:id/update` | 改名字 / 备注 / **全部特征字段** | |
| GET | `/roster` | 名单列表。手机号对一般管理员**打码** | |
| POST | `/roster/import` | 粘贴一段文本导入。`dry_run=true` 只预览不写库 | |
| POST | `/roster/:id/void` | 作废一行（填错了、人不来了） | |
| POST | `/roster/:id/reassign` | **她换班了**：新开一行、同一个 `teacher_ref` | |
| GET | `/teachers` | 列表。`q` 搜姓名/班级/**兑换码**/`teacher_ref`，`kindergarten_id` 筛园所 | |
| GET | `/teachers/:id` | 详情，见下 | |
| POST | `/teachers/:id/grant` | 发额度。**界面上已经没有入口了**，见下 | |
| POST | `/teachers/:id/status` | 停用 / 恢复 | |
| POST | `/teachers/:id/rebind-code` | **她换微信了**：生成换绑码，见下 | ✓ |
| POST | `/rebind-codes/:id/void` | 作废换绑码 | ✓ |
| GET | `/codes` | 兑换码列表，`status=all\|unused\|used\|void` | |
| POST | `/codes` | 建一个码。手机号姓名可留空 = 匿名码 | |
| POST | `/codes/batch` | 批量建 N 个匿名码（最多 200），返回**整批的码** | |
| POST | `/codes/:id/void` | 作废（只能作废还没被用的） | |
| GET | `/codes/export` | 导出 CSV（可能带手机号全号，所以锁超管） | ✓ |
| GET | `/plans/:id` | **教案正文 + 对话记录**，`?version=` 看历史版本 | ✓ |
| GET | `/feedback` | 反馈，`kind=all\|lesson_rating\|suggestion` | |
| POST | `/feedback/:id/handled` | 标已处理 / 未处理 | |
| GET | `/tasks` | 任务列表（带覆盖人数、已读数） | |
| POST | `/tasks` | 建任务（草稿） | |
| POST | `/tasks/:id/update` | 改 | |
| POST | `/tasks/:id/publish` | 发布（draft → open） | |
| POST | `/tasks/:id/close` | 收（→ closed） | |
| POST | `/tasks/preview` | **试算覆盖人数**：传 target，回会发给几位老师 | |
| GET/POST | `/admins`、`/admins/:id/*` | 管理员账号 | ✓ |
| POST | `/me/password` | 改自己的密码（一般管理员也能改自己的） | |
| GET | `/logs` | 操作审计，带筛选与分页，见下 | ✓ |
| — | `/image-models*` | 见第 6 节 | ✓ |

### `GET /teachers/:id` · 老师详情

一个老师页要回答四件事：**她是谁**（匿名码激活的老师没有手机号，只有码）、
**额度用到哪了**、**她用得怎么样**、**她说了什么**。

**不再回答「给她加点额度」**（2026-08-18 用户定）：额度只走兑换码一条路 ——
我建码，通过别的渠道发给她，她自己兑。所以这一页没有发放表单。
`POST /teachers/:id/grant` 这个接口**保留**，作为出错时的应急通道（回归脚本也在测它），
但界面上不给入口 —— 能力留着不等于要摆在最常用的那一页上。

```jsonc
{
  "teacher": {
    "id": 12,                    // 账号
    "teacher_ref": 1042,         // **人**。换班也不变，研究追人就按它归组
    "roster_entry_id": 7,        // **位置**（class_teacher_id）：人 × 园 × 班 × 岗位
    "real_name": "王小美",        // 一般管理员只看到姓氏
    "name_masked": false,
    "redeem_code": "STEM-A3F9-K7QD",   // 她兑的是哪个码
    "kindergarten": "阳光幼儿园", "class_name": "小一班",
    "position": "主班", "age_group": "小班",
    "status": "active",
    "activated_at": "...", "agreed_at": "...", "last_login_at": "..."
  },
  // **没有 phone**。2026-08-19 起那一列从库里删掉了 ——
  // 她的手机号只在问卷星那边，要联系她去那边看答卷
  "quota":  { "text": {...}, "image": {...} },
  "grants": [ { "delta_text": 20, "delta_image": 10, "reason": "完成9月问卷", "created_at": "..." } ],

  // **只有写完的教案**（conversations.status = 'completed'）。
  // 答题中的草稿不列 —— 那是她被打断留下的半截，不是「她写过的教案」。
  // 注意：库里那些 draft 一行都不动，只是这个视图不显示（断点续写依赖它们）
  "plans": [
    { "conversation_id": 1, "plan_id": 8, "title": "浮与沉",   // title / plan_id 只给超管
      "age_group": "小班", "created_at": "...",
      "version": 3,            // 一共出到第几版
      "current_version": 2,    // 现在她屏幕上是哪一版（回退过就不一样）
      "versions": [            // 全部版本，超管才有
        { "version": 1, "revise_note": null,             "created_at": "..." },
        { "version": 2, "revise_note": "材料太多了",       "created_at": "..." },
        { "version": 3, "revise_note": "加一次户外参观",   "created_at": "..." }
      ] }
  ],
  "drafts": 4,                 // 还在答题中的有几个。只给个数，不列内容

  "images": {                      // 配图统计。**数量和成本给所有管理员**，
    "total": 5, "ready": 4, "failed": 1,   // 因为它是用量与成本，不是老师写的内容
    "cost_cents": 12,
    "by_purpose": [ { "purpose": "worksheet", "n": 2 } ]
  },
  "feedback": [ { "kind": "lesson_rating", "rating": "needs_edit", "text": "...",
                  "lesson_plan_id": 8, "plan_version": 2, "plan_title": "浮与沉" } ],
  "can_view_content": true
}
```

一般管理员那边：`plans` 的每一项**去掉 `title`、`plan_id` 和 `versions`**
（不是置空，是这个字段不存在——前端据此显示「超管可见」而不是显示一个空标题），
`feedback[].plan_title` 同理。她写完几份、什么时候写的、出到第几版仍然给，
那是判断使用情况必需的，且不含她写的内容。
**`plan_id` 必须一起拿掉**：给了它，一般管理员就能自己去敲 `/plans/:id`。

`plans` 最多 50 条，超过时带 `plans_truncated: true` ——
界面必须说出「只显示了最近 50 份」，否则那个数字会被当成总数。

### `GET /plans/:id` · 教案正文（超管）

`?version=2` 从 `lesson_plan_versions` 取那一版的快照；不传就是当前内容。
响应里带 `versions`（全部版本号 + 改稿意见），界面据此给一条版本切换。

**对话记录直接给结构化数组**，界面上以 JSON 呈现（2026-08-18 用户定）：
这一屏的用处是拿去做研究分析，一个能整块选中复制的 JSON 比一张排好的表更有用。
`system` 那条不在库里（每次实时拼装，见 `001_init.sql` 的注释），所以本来就不会出现。

### `GET /logs` · 操作审计（超管）

`?admin_id=&action=&from=&to=&page=`，每页 100 条，响应带 `total` / `page` / `pages`。
**保留这一页**（2026-08-18 用户定：不是删掉，是加筛选和翻页）——
攒到几百条之后一张倒序裸表翻不动，而「这 20 次额度是谁发的」要查得到才算数。

### `GET /kindergartens` · 园所：特征 + 用量

园所在信息架构里**排在老师前面**（2026-08-18 用户定，紧跟概览）：
合作是按园谈的，老师是园带进来的。

这一页的重心是**园所特征**，不是用量。特征不只是档案，它是**任务定向的依据**——
「只发给农村园」「只发给广东的公办园」这些条件全部落在这几个字段上。

```jsonc
{ "items": [ {
  "id": 1, "name": "阳光幼儿园", "note": "9 月起合作",

  // ---- 特征（010 迁移）----
  "province": "广东", "city": "广州",
  "area_type": "rural",        // city 城市 | county 县镇 | rural 农村
  "ownership": "public",       // public 公办 | private 民办
  "teacher_count": 24,         // 在园教师总数（不是在本平台注册的人数）
  "child_count": 210,          // 在园幼儿总数 —— 机构规模，不是幼儿个体信息，见 CLAUDE.md
  "contact_name": "李园长",
  "contact_phone": "138****1234",   // **一般管理员看到打码的，全号只给超管**

  // ---- 用量汇总 ----
  "teachers": 6,          // 在本平台已激活的
  "active_7d": 2,         // 近 7 天登录过
  "codes_unused": 4,      // 还没被兑的码 —— 配上 teachers 就知道发出去的码有没有人用
  "plans": 23, "images": 9,
  "granted_text": 120, "used_text": 23,     // 台账 Σ发放 − 事实表数消耗，跟老师页同一套算法
  "cost_cents": 210,
  "last_active_at": "..."  // 这个园最近一次有人登录
} ] }
```

`contact_phone` 打码的规则跟老师手机号一致：**一般管理员只看打码**。
它是园长的号，不是老师的，但同一条纪律——永不下发老师端、永不进日志。
**有联系人不等于给园方开账号**：仍然没有「园所管理员」这种角色。

点园所跳「老师」页并预设园所筛选 —— 不为「这个园的老师列表」再做一份界面。

### `POST /kindergartens/:id/update`

`{ name, note, province, city, area_type, ownership, teacher_count, child_count, contact_name, contact_phone }`
全部可选，只传哪项改哪项（`undefined` = 不动，空字符串 = 清空）。
改名字会查重；进 `admin_logs`。

省市**不做级联下拉**：合作园有几个就有几行，一份维护不动的行政区划全量表
带来的错误（漏更新、名称不一致）比手填多。填错了在详情里改。

（用 `POST .../update` 而不是 `PATCH`：后台自己不受小程序那条限制，
但整个项目统一走这一种形状，省得两套约定并存。）

### 名单 · `/roster*`

**一份岗位清单，不是一份手机号清单。** 合作园给名单，我录进来；
老师激活时从里面选自己那一行（见第 1.5 节）。

```jsonc
// GET /roster?status=pending|claimed|void|all&kindergarten_id=&q=
{ "items": [ {
  "id": 7,                     // = class_teacher_id：人 × 园 × 班 × 岗位
  "teacher_ref": 1042,         // = 人。换班时新开一行，这个数不变
  "real_name": "王小美",        // 一般管理员只看到姓氏
  "name_masked": false,
  "kindergarten": "阳光幼儿园",
  "class_name": "小一班", "position": "主班", "age_group": "小班",
  "note": null,                // 两个同姓配班时用它区分
  "status": "claimed",
  "claimed_at": "...", "claimed_teacher_id": 12,
  "claimed_openid": "o_xxx"    // **超管才有** —— 「谁顶了谁的名额」要查得到
} ],
  "counts": { "pending": 18, "claimed": 6, "void": 1 } }
```

**没有 `phone`。** 2026-08-19 起 `teachers` 和 `teacher_roster` 的手机号列都删掉了：
她要证明的事情是「我是阳光幼儿园小一班的主班」，那句话里没有手机号。

#### `POST /roster/import` · 粘贴一段文本导入

```jsonc
{ "text": "王小美, 小一班, 主班, 小班\n李红, 中二班, 配班, 中班",
  "kindergarten_id": 1,
  "dry_run": true }
// → { "rows": [ { "line": 1, "real_name": "王小美", "class_name": "小一班",
//                 "position": "主班", "age_group": "小班",
//                 "ok": true, "reason": null } ],
//     "summary": { "total": 2, "ok": 2, "duplicate": 0, "invalid": 0 },
//     "imported": 0 }        // dry_run 时永远是 0
```

**`dry_run` 先预览，确认后再真写**。不给预览就是让人闭眼提交一份从微信里
复制来的名单 —— 里面必然有全角逗号、多余空格、少一列的行、连表头一起复制进来。

- 分隔符认**逗号（含全角）、制表符、多个空格**：从 Excel 复制过来是制表符，
  从微信复制过来是各种逗号。认不出来是我们的问题，不是使用者的
- **只有姓名是必需的**。班级/岗位/年龄班按**内容**认而不按位置认
  （名单里这几列的顺序每个园都不一样）
- **年级 == `age_group`**（小班/中班/大班），不另开一列
- 重复判定是（园所 + 班级 + 岗位 + 姓名）四项全同 → `duplicate`，**跳过不覆盖**
  （覆盖会悄悄改掉一个人的身份，而名单是激活的依据）
- 每一行导入时分配一个新的 `teacher_ref`
- 整批一个事务：要么全写进去，要么一行都不写

#### `POST /roster/:id/reassign` · 她换班了

```jsonc
{ "class_name": "中二班", "age_group": "中班", "position": "主班" }
// → { "entry": { "id": 88, "teacher_ref": 1042, ... } }
```

**新开一行、同一个 `teacher_ref`**，并把她账号的 `roster_entry_id` 指过去。
旧那一行留着不动（标 `moved`）—— 那是历史，研究要用它区分「她在小一班那半年」
和「她在中二班这半年」。**她自己什么都不用做。**

### `POST /teachers/:id/rebind-code` · 她换微信了（超管）

```jsonc
// → { "code": "STEM-A3F9-K7QD", "expires_at": "...", "reused": false }
```

- 默认 **7 天**有效
- **已有 pending 的就直接返回那一个**（`reused: true`），**不重复生成** ——
  否则外面同时有两把能接管她账号的钥匙
- 锁超管：它能把一个账号交给另一个微信，比发额度敏感得多
- 进 `admin_logs`

**怎么确认打微信来的这个人真是她**（不收手机号，只能线下核）：
问她**兑的哪个码**（后台记着）或**最近写的教案标题**。
这条是操作纪律，写在 `operations.md`，**不写在界面上**。

### `GET /overview` · 概览

原来是「今天写了几份 / 累计多少老师 / 最近写的六份」。全删了（2026-08-18 用户定）：
**累计数看一眼就没用了，最近写的没有实际意义**。这一屏改成回答四句话：

```jsonc
{
  // 1. 我的钱。账面剩余 = Σ充值 − (配图成本 + 文本成本)
  "money": {
    "topup_cents": 50000,
    "spent_image_cents": 210, "spent_text_cents": 1840,
    "left_cents": 47950,
    "month_image_cents": 72, "month_text_cents": 640,
    // 成本数据从哪天起才完整。**必须显示出来** ——
    // 早期 12 张图没有成本记录、文本成本是 011 迁移之后才开始记的，
    // 不说的话这个「花了多少」会被当成全部历史
    "text_tracked_since": "2026-08-18",
    "images_missing_cost": 12
  },

  // 2. 谁在用
  "usage": { "kindergartens": 2, "kindergartens_active_7d": 1,
             "teachers": 23, "teachers_active_7d": 6 },

  // 3. 哪个园用了多少（复用 /kindergartens 的聚合，只取要用的列）
  "by_kindergarten": [
    { "id": 1, "name": "童心幼儿园", "teachers": 19,
      "granted_text": 680, "used_text": 16, "images": 31, "cost_cents": 72 }
  ],

  // 4. 等我处理
  "todo": { "feedback_new": 8, "gen_failed_7d": 0, "images_failed_7d": 1,
            "codes_unused": 4, "low_quota": [ { "id": 12, "name": "王老师", "text_left": 1 } ] },

  // 教案能不能直接用 —— 这个产品最大未知数的唯一持续数据源，留着
  "quality": { "usable": 1, "needs_edit": 2, "unusable": 0 }
}
```

⚠️ **`quality` 那一段以前永远是零**，因为查的是 `kind = 'rating'` 而真实值是 `'lesson_rating'`
（2026-08-18 查出来的 typo）。库里其实一直有数据。修好了。

### `GET /topups`、`POST /topups` · 充值台账

```jsonc
// POST  { "amount_cents": 20000, "channel": "12ai", "note": "8月充值", "occurred_on": "2026-08-10" }
```

只追加，不修改：记错了记一笔**负数**冲账，不改历史 —— 跟额度台账同一个纪律。
`occurred_on` 由人填而不是用 `created_at`：常常隔几天才补录，按月对账要按实际发生的日子算。
账面余额**是算出来的**，不存字段。

### 任务 · `/tasks*`

```jsonc
// POST /tasks
{
  "title": "9 月教研问卷",
  "body": "填完这份问卷，我会给你发一个兑换码。",
  "survey_url": "https://www.wjx.cn/vm/xxxx.aspx",
  "reward_text": 20, "reward_image": 10,
  "deadline": "2026-09-30",
  "target": {
    "provinces": ["广东"], "cities": [],
    "area_types": ["rural"], "ownerships": [],
    "kindergarten_ids": [], "age_groups": ["小班"]
  }
}
```

**`target` 的规则只有两条**：空数组 = 这一维不限；非空维度之间是 **AND**（都要命中）。
上面这个例子 = 广东 + 农村园 + 带小班的老师。

- **没有园所的老师**（匿名码激活、没填园所）只匹配「园所相关维度全空」的任务。
  否则她会永远收不到任何定向任务，而我们不知道
- `POST /tasks/preview` 传一个 `target` 回 `{ "teachers": 12 }`。
  **不是锦上添花**：条件叠到六层之后不试算没法确认筛对了，而发错是发给真人的
- 匹配逻辑写在 `backend/src/services/tasks.js`，做成一个 SQL 谓词构造器，
  `/preview` 和老师端 `GET /tasks` **共用同一个函数**。写两份迟早分叉，
  分叉的表现是「后台说发给 12 个人，实际只有 8 个人看到」
- `draft` 老师看不到（编到一半不该让人看见）。**建出来就是草稿**，发布是另一个动作 ——
  中间那一步就是给我机会先试算一遍
- `deadline` 过了自动不出现。查询里是 **`deadline >= current_date`**：
  写成 `>` 会让「今天截止」的任务当天就消失
- **过了截止日期的任务不许发布**。否则是「发布成功了但一个人都收不到」，最难查的一种
- `normalizeTarget` 会**丢掉不认识的键和值**。要注意它的后果：
  一个拼错的维度名（`province` 少个 s）让那一维变成空数组 = **不限**，
  于是「本来只想发给农村园」悄悄变成「发给所有人」。
  所以 `/preview` 回一个 **`unrestricted`** 位，界面据此显眼地警告

**落地时定下来的几处**（`services/tasks.js`）：

- 老师端那一侧**不拼大 SQL**，而是把 open 任务逐个跑一遍谓词判断。
  任务是个位数（一个人发的），逐个判断无所谓；
  换成一条 SQL 就要在里面把 JSONB 拆开比，那才是会写错的地方
- 只发给**已激活且没注销**的老师。名单里躺着但还没进来的人收不到 ——
  她连小程序都没打开过，任务给她也看不见
- `days_left` 由后端算好给前端。她要判断的是「今天还来不来得及」，不是一个日期

### 老师端：`GET /tasks`、`POST /tasks/:id/read`

```jsonc
// GET /tasks → 我能看到的、还没过期的
{ "items": [ { "id": 3, "title": "9 月教研问卷", "body": "...",
               "survey_url": "https://...", "reward_text": 20, "reward_image": 10,
               "deadline": "2026-09-30", "days_left": 12, "unread": true } ],
  "unread": 1 }
```

`unread` 那个数是首页那条条带的开关：**为 0 就不显示条带**，不占地方。
`POST /tasks/:id/read` 标已读（没有记录就是未读，不存 unread 字段）。

**任务和奖励是断开的**：任务只承诺，到账靠我事后建码、她自己兑。
系统不去猜「她是不是真填了问卷」—— 答卷在问卷星，我们库里没有。
小程序里打不开外部网页，所以问卷链接要**给复制按钮**，不是一个点不动的链接。

---

**版本**：1.0 · 2026-08-16
**约定**：改接口先改本文档，再改代码。
