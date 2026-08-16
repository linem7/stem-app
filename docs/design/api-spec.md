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

// 响应 —— 直接返回第一轮的第一题，前端不用再请求一次
{ "ok": true, "data": {
  "conversation_id": 1024,
  "status": "draft",
  "progress": { "round": 1, "question": 1, "total_rounds": 3, "questions_in_round": 4 },
  "question": {
    "id": "q1",
    "title": "这次活动是给哪个年龄班的？",
    "hint": "选一个最接近的就好",
    "multi": false,
    "options": [
      { "key": "A", "label": "小班", "sub": "3-4 岁" },
      { "key": "B", "label": "中班", "sub": "4-5 岁" },
      { "key": "C", "label": "大班", "sub": "5-6 岁" }
    ],
    "allow_custom": true,
    "custom_placeholder": "我自己说 —— 点这里打字"
  }
}}
```

### `POST /conversations/:id/answer` · 答一题，拿下一题

```json
// 请求
{ "question_id": "q2", "selected": ["A", "B"], "custom_text": null }

// 响应
{ "ok": true, "data": {
  "progress": { "round": 1, "question": 3, "total_rounds": 3, "questions_in_round": 4 },
  "ack": "好的，那我们把重点放在动手体验上。",
  "question": { ... 下一题，结构同上 ... },
  "can_finish": true
}}
```

- **每次调用即落库**（PRD 要求：老师被打断退出后进度不丢）
- `ack` 是 AI 对上一题的一句话回应，前端显示在已答题目下方，增强对话感
- `can_finish` 为 true 时，前端显示「跳过引导，直接生成」
- 若本轮已答完且无下一题，`question` 为 `null`、`ready_to_generate` 为 true

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

---

## 6. 配图

### `POST /lesson-plans/:id/images`
```json
{ "section_key": "flow.1", "note": "孩子围在水盆边试材料" }
// → { "ok": true, "data": { "image_id": 3, "status": "pending" } }
```

### `GET /lesson-plans/:id/images/:image_id`
轮询取结果，`status` 转 `ready` 时带 `url`。

⚠️ 后端必须做**每日配图次数上限**（建议每人每天 10 张）。图片是主要成本项，没有闸门会被刷。

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
