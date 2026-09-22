# 内容安全：怎么接的、怎么用、出问题怎么查

**这一份是操作手册，不是设计文档。** 想改代码先看 `backend/src/services/contentSafety.js`
的文件头（那里写了每一处容易写错的地方和为什么）。

---

## 一、它管什么

老师**输入**和 AI **输出**都要过一遍阿里云内容安全（Green 的 `TextModerationPlus`）。

这不是可选项：**使用协议里对老师承诺过这一条**，而且它是「不存幼儿信息」之外
另一条合规底线。上线前不开，协议里那句就是假话。

两个调用点用**两个不同的 service**，是阿里云专门给大模型场景准备的：

| 谁的内容 | service | 单次上限 |
|---|---|---|
| 老师输入（提问、改稿意见、反馈、档案、记忆、配图描述） | `llm_query_moderation` | **2000 字** |
| AI 输出（教案正文、生成的题目） | `llm_response_moderation` | **5000 字** |

**超长会自动分段送审，不会截断。** 截断 = 后半截没审，而它看起来跟审过完全一样 ——
这是这条链路上最危险的一种「看起来正常」。

---

## 二、怎么开（三步）

### 1. 确认商品开通了

阿里云控制台 → 内容安全 → 确认 `lvwang_cip_public_cn` 已开通。

🔴 **权限给了不等于能调。** 商品要单独开通，没开通时报的是
`Code=408 · you haven't activated the commodity:lvwang_cip_public_cn`。
**这句话跟 RAM 权限无关，别去 RAM 里找问题。**

### 2. 确认 key 在

内容安全**不用单独申请第二把 key**，它走的就是部署用的那对 RAM AccessKey：

```
ALIBABA_CLOUD_ACCESS_KEY_ID=...
ALIBABA_CLOUD_ACCESS_KEY_SECRET=...
```

⚠️ 变量名是阿里云 SDK 默认读的那两个，**别改名**。

### 3. 打开开关

```
CONTENT_CHECK_ENABLED=true
# 可选，默认 cn-hangzhou（服务器在杭州）
CONTENT_SAFETY_REGION=cn-hangzhou
```

开关为 true 时必须配齐凭据，否则启动失败；运行中审核超时、异常或结果不明确时，暂停此次提交并提示重试。

改完 `.env` **必须重启后端**才生效（`admin.bat` 那个窗口就是后端本体，
先 Ctrl+C 再双击；后端没开 `--watch`）。

---

## 三、怎么验它真的在工作

### 跑回归脚本（打真接口，会花一点点钱）

```bash
cd backend
node --env-file=.env scripts/content-safety-test.mjs
```

真实接口用例覆盖放行、拦截、长文本和假凭据；缺少凭据会失败退出。另运行 `npm run test:contentsafety:unit`，覆盖异常响应、超时、分段边界、启动校验和未审正文不可见。

### 🔴 为什么必须有这个脚本

**一个空转的检查和严格的检查，在正常输入下输出一模一样** —— 都是 pass。
所以「跑了一遍没报错」不能证明它在工作。这个脚本里每一条「该拦」的用例
都配了一条**真会命中的样本**（「代开发票 联系微信 低价办理各种证件」）。

这个项目已经踩过两次同类坑（`enforceAgeBand` 的反向测试、
`normalizeCommentary` 的白名单），所以这条纪律是硬的：
**写一道过滤，就得同时写一条「喂它过滤不掉的东西」的断言。**

脚本里最值得看的两条：

| 断言 | 它防的是什么 |
|---|---|
| 违规藏在 2000 字之后仍然被拦 | 分段是不是真的「每段都查」，而不是只查第一段 |
| 假 key 会抛错，不是静默返回 pass | 配置错了会不会被「接口抖动放行」那个兜底吃掉 |

### 手工验一条（起服务）

```bash
# 拿一个已激活账号的 token
TOKEN=$(curl -sS -X POST http://localhost:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"phone":"你的手机号","password":"你的密码"}' | jq -r .data.token)

# ① 正常内容 —— 该过
curl -sS -X POST http://localhost:3000/v1/feedback \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"category":"usability","text":"希望能加一个按班级筛选的功能"}'
# → {"ok":true,...}

# ② 违禁内容 —— 该被拦
curl -sS -X POST http://localhost:3000/v1/feedback \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"category":"other","text":"代开发票 联系微信 低价办理各种证件"}'
# → {"ok":false,"error":{"code":"VALIDATION_FAILED",
#     "message":"这段内容没通过安全检查，换个说法试试"}}
```

**两条都要跑。** 只跑①看着也对，但那是「没在工作」和「在工作」共有的表现。

---

## 四、九个调用点在哪

改了内容安全之后，**这九处不用动**（它们只调 `checkText`）：

| 文件 | 管什么 |
|---|---|
| `routes/conversations.js` | 老师开场那句话；AI 生成的题目和推荐答案 |
| `routes/generate.js` | AI 写出来的教案正文 |
| `routes/revise.js` | 改稿意见；AI 生成的追问 |
| `routes/feedback.js` | 产品建议 |
| `routes/memories.js` | 老师手写的记忆 |
| `routes/images.js` | 配图的描述文字 |
| `routes/me.js` | 昵称、园所名 |
| `routes/lessonPlans.js` | 教案的局部编辑 |

统一走 `checkText({ content, stage })`：
- `stage: 'teacher_input'`（老师写的）
- `stage: 'ai_output'`（AI 写的）
- `stage: 'profile'`（档案，也算老师输入）

不通过时抛 `contentBlockedError(stage)` —— **两种 stage 的文案不一样**，
因为 AI 写砸了不是老师的错。

**加新的调用点就用这两个函数，别自己拼 service 名。**

---

## 五、出问题怎么查

### 报错对照表（2026-09-22 实测，不是照文档抄的）

| 现象 | 真正的原因 | 怎么办 |
|---|---|---|
| `Code=408` / 消息里有 `haven't activated the commodity` | **商品没开通** | 控制台开通 `lvwang_cip_public_cn`。**跟 RAM 权限无关** |
| `InvalidAccessKeyId.NotFound` | key 写错了，或者建在了**别的阿里云账号**下 | 核对 `.env`。核对凭据所属账号是否已开通所需审核商品并具有调用权限；对象存储不属于当前部署必需项 |
| `SignatureDoesNotMatch` | 签名算错了 | 见下面「签名三处易错」 |
| `UnsupportedHTTPMethod` | 用 GET 调了 | **必须 POST**。这个报错跟权限、跟开通都无关，2026-09-01 被它误导过一次 |
| `content is too long(>2,000)` | 送审的单段超了上限 | 不该出现（代码会自动分段）。出现说明 `LIMITS` 那个表和实际不符 |
| `content is blank` | 送审了空字符串 | 不该出现（空文本不送审）。出现说明调用点没过滤 |
| `service is invalid` | service 名写错了 | 只能 `llm_query_moderation` / `llm_response_moderation` |

### 🔴 签名三处易错

POP 的百分号编码**跟 `encodeURIComponent` 有三处不一样**，
照抄会得到 `SignatureDoesNotMatch`，而那个报错会把「服务端算的串」打出来，
看起来像别的问题：

1. 空格编成 `%20`，**不是 `+`**
2. 星号 `*` 要编成 `%2A`（`encodeURIComponent` 不编它）
3. 波浪号 `~` **不编**

还有一个：HMAC 的密钥是 **`secret + '&'`**（最后那个 `&` 不能少）。

### 「检查全过」但你不信

如果怀疑它空转了，**先跑 `scripts/content-safety-test.mjs`** ——
它有一条真会命中的样本。这是唯一能区分「在工作」和「没在工作」的办法。

### 有一条错误是**故意让请求失败**的

配置类错误（key 不对、商品没开通）会**抛出去打断请求**。
这是故意的：配置错了会一直是错的，而它看起来跟「所有内容都很干净」一样。

超时、接口抖动、错误或不明确结果均返回 `CONTENT_CHECK_UNAVAILABLE`（HTTP 503，可重试）。不记录供应商错误原文，避免回显待审文本或签名串。

启用审核时不提前流出教案正文，标题、正文和结构化内容通过审核后才展示。长文本重叠分段送审；局部编辑审核合并后的完整内容。配图描述接受文本审核，图片本身的审核尚未接入。

---

## 六、花钱

**不是成本大头，不要为省它做取舍。**

| 项 | 单价 |
|---|---|
| 配图 | 约 **2.5 分/张** |
| 文本模型单次调用 | 约 0.1 分 |
| 内容安全单次 | 约 **0.15 分**（按 AI 安全护栏高级版估） |

一张配图 ≈ 17 次内容安全调用。所以**别做「只审老师输入不审 AI 输出」这种事** ——
省下的钱可以忽略，而漏审是合规问题。

⚠️ 计费口径有一处没定死：开通的商品是 `lvwang_cip_public_cn`，
而阿里云这条线上有两套价目（内容安全 1.0 新用户每日 3000 条免费 /
AI 安全护栏约 15 元/万次）。**从 API 侧确认不了落在哪一套**，
要看控制台费用中心的实际出账。

---

## 七、历史（为什么要换掉微信那套）

| 时间 | 发生了什么 |
|---|---|
| 小程序时代 | 走微信 `msgSecCheck`。理由是「小程序有 UGC 就必须做，不做审核不通过」 |
| 2026-08-30 | 转 web（ADR-002）。**那条理由没了** —— 不是小程序就不归微信管 |
| 2026-09-01 | 换阿里云（ADR-003），服务开通、实测调通 |
| **2026-09-22** | **代码真的换过来了**：`services/wechat.js` 删除，九个调用点切到 `contentSafety.js` |

⚠️ 微信那个接口要求传 `openid`，而 web 端没有它（022 迁移之后新账号一律 NULL）——
所以旧代码里那九个调用点一直在传 `null`。**换完之后这个参数整个消失了**，
这是这次切换顺带清掉的一处别扭。
