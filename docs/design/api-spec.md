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

**响应里永远没有 phone 和 real_name**，包括老师自己的。手机号和姓名只活在服务端与管理后台。

### `POST /auth/redeem` · 兑换码激活

```json
{ "code": "stem 4k7p qx3m" }
// → { "ok": true, "data": { "teacher": {...}, "quota": {...}, "granted": { "text": 20, "image": 10 } } }
```

- 输入**宽容**：大小写、空格、下划线、各种横线都认。认不出来是我们的问题，不是老师的
- 码只用于**首次激活**；之后的任务奖励不发新码，后台按手机号直接加额度
- 一个手机号只能激活一个账号（换微信重登不能白拿一份额度）
- 激活是一个事务：绑身份 + 标记码已用 + 发首笔额度，三件事同生共死

### `POST /me/agree` · 同意协议

激活后、进主流程前必须调一次。协议内容见 operations.md 第 2 节，其中这句要加粗：
**「你的幼儿园和园长看不到这里的任何东西。」**

### `GET /me/quota` · 余额与台账

```json
// → { "quota": { "text": {"granted":20,"used":3,"left":17}, "image": {...} },
//     "grants": [ { "text": 20, "image": 10, "reason": "完成8月问卷·首次", "at": "..." } ],
//     "free_revisions": 2 }
```

`grants` 是给老师自己看的台账 —— 能对账，额度就不是黑箱。

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
    "materials": ["透明水盆", "塑料瓶盖", "..."],
    "flow": [ { "stage": "引起动机", "minutes": 5, "detail": "洗手时有小朋友发现…" } ],
    "steam": { "S": "…", "T": "…", "E": "…", "A": "…", "M": "…" },
    "indicators": ["…"], "safety": ["…"]
  },
  "content_md": "# 浮与沉…",
  "images": [ { "id": 3, "section_key": "flow.1", "url": "https://…", "status": "ready" } ]
}}
```

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
// → { "ok": true, "data": { "image_id": 3, "status": "pending", "purpose": "material" } }
```

- `purpose` 决定构图规则和画布比例，默认 `material`。不认识的值一律按 `material`
- `section_key` **可选**，形如 `material.<下标>`；老师自由描述时没有它
- `note` 是老师看到的那句话（材料名或她自己的描述），原样记进 `prompt_cn`，
  也是界面上这张图的标签。自由描述时**必填**
- **每份教案最多 3 张**（`IMAGE_LIMIT_EXCEEDED`，不可重试）。这是内容判断不是成本判断：
  三张以上老师就不看了，而且越多越像商品目录，离教案越远

### 尺寸：按打印来定，不是按屏幕

出图一律 2048 长边（约 A4 250 DPI）。屏幕上根本不需要这么大，但**这图的终点是打印机**，
1152×864 印出来在 A4 上只有约 140 DPI，线条发虚。代价是一张从 30 秒变成约 47 秒。

比例跟着 `purpose` 走：记录表竖版、头饰和背景墙横版、材料图方版。

### `GET /lesson-plans/:id/images/:image_id`
轮询取结果，`status` 转 `ready` 时带 `url`、`width`、`height`、`purpose`、`label`。

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
### `DELETE /memories/:id` · 删除

⚠️ 记忆的**写入是后端自动的**（教案生成后异步提取），但**删改权必须完全在老师手里**。这是隐私底线，也是信任基础。

---

## 9. 前端必须处理的状态

每个涉及网络的界面都要有这四态，设计稿需对应出图：

| 状态 | 场景 | 表现 |
|---|---|---|
| **加载中** | 首次进入、切筛选 | 骨架屏（不是转圈），保持布局稳定不跳动 |
| **空** | 教案库无教案、记忆为空 | 插画 + 一句引导 + 主行动按钮 |
| **错误** | 请求失败 | 错误文案（用后端返回的 message）+ 重试按钮 |
| **生成中** | 教案生成、配图生成 | 进度提示文案 + 可离开（后台继续，完成后可在教案库看到） |

**"生成中可离开"是必须的**——生成要 30 秒，老师在幼儿园随时会被叫走。不能要求他盯着屏幕等。

---

## 10. 安全与限流

- **所有 AI 调用在后端**。API key 绝不下发到小程序端
- 限流：单用户 `POST /conversations` 每小时 10 次、`generate` 每小时 20 次、配图每天 10 张
- 内容安全：老师输入和 AI 输出都要过微信内容安全接口（`security.msgSecCheck`）。小程序有 UGC 的必须做，否则审核不过
- 日志不记录完整对话正文，只记 id、耗时、token 数、错误码

---

**版本**：1.0 · 2026-08-16
**约定**：改接口先改本文档，再改代码。
