# 数据库设计

PostgreSQL 14+。选 PostgreSQL 而非 MySQL 的理由：原生 JSONB（存教案结构化内容和模型返回最省事）、日后要上向量检索可直接加 pgvector 扩展、云厂商 RDS 都支持。

---

## 表关系总览

```
teachers (老师)
  ├─< conversations (对话/教案会话)  ──1:1──  lesson_plans (教案成稿)
  │      └─< messages (对话消息)                    └─< lesson_images (配图)
  └─< teacher_memories (用户记忆)
```

一次教案创作 = 一个 `conversation`。它从首页输入想法时创建，状态为 `draft`；生成成稿后产生一条 `lesson_plans`，状态转 `completed`。**教案库读的就是 conversations 表**，草稿和已完成都在这里。

---

## 1. teachers · 老师

```sql
CREATE TABLE teachers (
  id                BIGSERIAL PRIMARY KEY,
  openid            VARCHAR(64)  NOT NULL UNIQUE,   -- 微信小程序 openid
  unionid           VARCHAR(64),                    -- 预留，日后有公众号/APP 时打通
  nickname          VARCHAR(64),
  avatar_url        TEXT,

  -- 档案（首次登录引导填写，可随时改）
  kindergarten_name VARCHAR(128),
  age_group         VARCHAR(8),                     -- '小班' | '中班' | '大班'
  teaching_years    SMALLINT,

  -- 显式偏好（与自动提取的 memories 并存，显式优先）
  preferences       JSONB NOT NULL DEFAULT '{}',
  -- 形如 {"template_format":"表格式","default_age_group":"中班","auto_image":false}

  status            VARCHAR(16) NOT NULL DEFAULT 'active',  -- active | disabled
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at     TIMESTAMPTZ
);

CREATE INDEX idx_teachers_last_login ON teachers (last_login_at DESC);
```

⚠️ **不存手机号、不存真实姓名、不存所带幼儿的任何信息。** 幼儿数据一旦入库，合规复杂度会指数上升。这条要写进后端的 code review 清单。

---

## 2. conversations · 教案会话（教案库的数据源）

```sql
CREATE TABLE conversations (
  id             BIGSERIAL PRIMARY KEY,
  teacher_id     BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,

  title          VARCHAR(128),           -- 初始为用户输入的想法，成稿后替换为教案标题
  seed_input     TEXT NOT NULL,          -- 首页那句话，原样保留

  status         VARCHAR(16) NOT NULL DEFAULT 'draft',
  -- draft(草稿·引导中) | generating(生成中) | completed(已完成) | failed(生成失败)

  -- 引导进度（用于教案库显示「进行到第 1 轮第 2 题」+ 断点续写）
  round_index    SMALLINT NOT NULL DEFAULT 1,
  question_index SMALLINT NOT NULL DEFAULT 1,
  total_rounds   SMALLINT NOT NULL DEFAULT 3,

  -- 引导过程中逐题收集的结构化答案，前端渲染和后端生成都读它
  collected      JSONB NOT NULL DEFAULT '{}',
  -- 形如 {"age_group":"中班","goal":["感受到沉和浮的差别"],"duration":30,
  --       "materials":[...],"safety":[...],"skipped":false}

  age_group      VARCHAR(8),             -- 从 collected 提升为列，供教案库按年龄班筛选
  has_image      BOOLEAN NOT NULL DEFAULT false,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  deleted_at     TIMESTAMPTZ             -- 软删除，30 天后物理清理
);

CREATE INDEX idx_conv_teacher_updated ON conversations (teacher_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_conv_teacher_status  ON conversations (teacher_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_conv_teacher_age     ON conversations (teacher_id, age_group)
  WHERE deleted_at IS NULL;
```

**为什么把 `age_group` 从 JSONB 里提出来单独建列**：教案库的年龄班筛选是高频操作，JSONB 内字段建索引可行但查询写法笨重，提列更直接。`collected` 里仍保留一份，两者以列为准。

**为什么进度用 `round_index` + `question_index` 两个整数而不是存一个 step 字符串**：PRD 要求"每答一题即写库"，用整数最省写入成本，且教案库要显示"第 1 轮第 2 题"可直接读。

---

## 3. messages · 对话消息

```sql
CREATE TABLE messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

  role            VARCHAR(16) NOT NULL,   -- system | assistant | user
  content         TEXT NOT NULL,

  -- assistant 提问时的结构化载荷：题号、题干、推荐答案卡片、是否可多选
  payload         JSONB,
  -- 形如 {"question_id":"q2","multi":true,
  --       "options":[{"key":"A","label":"感受到沉和浮的差别","hint":"偏体验与感知"}]}

  round_index     SMALLINT,
  question_index  SMALLINT,

  token_in        INTEGER,                -- 成本核算用
  token_out       INTEGER,
  model           VARCHAR(32),            -- 'deepseek-chat' 等

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_msg_conv ON messages (conversation_id, id);
```

**system 消息不入库**：它由后端每次实时拼装（框架 + 年龄班规则 + 用户档案 + 记忆），存了会大量重复且改提示词后旧记录失真。只在 `messages` 里记 assistant/user 的真实往返。

---

## 4. lesson_plans · 教案成稿

```sql
CREATE TABLE lesson_plans (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  teacher_id      BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,

  title           VARCHAR(128) NOT NULL,
  age_group       VARCHAR(8)   NOT NULL,
  duration_min    SMALLINT,

  content_md      TEXT  NOT NULL,         -- Markdown 全文，导出和展示用
  content_json    JSONB NOT NULL,         -- 结构化，便于分节渲染与后续编辑
  -- 形如 {"materials":[...],
  --       "flow":[{"stage":"引起动机","minutes":5,"detail":"..."}],
  --       "steam":{"S":"...","T":"...","E":"...","A":"...","M":"..."},
  --       "indicators":[...], "safety":[...], "extension":"..."}

  version         SMALLINT NOT NULL DEFAULT 1,  -- 重新生成则 +1，旧版保留在 history 表或直接覆盖
  quality_self    JSONB,                        -- 模型自检结果，8 维度打分，用于内测分析

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_plan_teacher ON lesson_plans (teacher_id, created_at DESC);
```

**为什么同时存 md 和 json**：md 是导出 Word / 分享 / 阅读的可靠来源；json 让"只重新生成延伸活动这一段"成为可能，不必整篇重来。两份由同一次生成产出，不允许分别编辑造成漂移——编辑时以 json 为准，md 由 json 渲染。

---

## 5. lesson_images · 配图

```sql
CREATE TABLE lesson_images (
  id             BIGSERIAL PRIMARY KEY,
  lesson_plan_id BIGINT NOT NULL REFERENCES lesson_plans(id) ON DELETE CASCADE,

  section_key    VARCHAR(32),             -- 配到哪一节，如 'flow.1'
  prompt_cn      TEXT,                    -- 老师看到的中文描述
  prompt_sent    TEXT,                    -- 实际发给豆包的提示词
  object_key     TEXT NOT NULL,           -- 对象存储 key，不存完整 URL（换域名不用改库）
  width          SMALLINT,
  height         SMALLINT,
  bytes          INTEGER,

  status         VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending|ready|failed
  error_msg      TEXT,
  cost_cents     INTEGER,                 -- 成本追踪，图片是最大开销

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_img_plan ON lesson_images (lesson_plan_id);
```

---

## 6. teacher_memories · 用户记忆

```sql
CREATE TABLE teacher_memories (
  id          BIGSERIAL PRIMARY KEY,
  teacher_id  BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,

  fact        VARCHAR(200) NOT NULL,      -- 一句话事实
  mem_type    VARCHAR(24)  NOT NULL,
  -- 教学信息 | 教学风格 | 约束条件 | 材料偏好 | 年龄班专长

  confidence  NUMERIC(3,2) NOT NULL DEFAULT 0.80,
  frequency   SMALLINT     NOT NULL DEFAULT 1,   -- 被几次对话印证
  source_conv BIGINT REFERENCES conversations(id) ON DELETE SET NULL,

  is_pinned   BOOLEAN NOT NULL DEFAULT false,    -- 老师手动添加/置顶的，永不自动淘汰
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_mem_teacher ON teacher_memories (teacher_id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_mem_dedupe ON teacher_memories (teacher_id, md5(fact))
  WHERE deleted_at IS NULL;
```

**去重靠 `md5(fact)` 唯一索引**：新提取的记忆若与已有完全相同，插入冲突时改为 `frequency + 1`。语义相近但文字不同的（"我带中班" vs "我的班级是中班"）靠提取时把已有记忆一并喂给模型、要求它合并而非新增来解决——**这比上向量检索便宜得多，MVP 阶段够用**。

**上限策略**：单个老师最多 10 条，超了就淘汰 `is_pinned = false` 里排最后的（排序见 `memoryExtractor.js` 的 `MEMORY_ORDER`：置顶 → 所带班级 → 频次 → 置信度 → 更新时间）。

原先定的是 60 条、且只淘汰 `frequency = 1` 的，2026-08-16 改成现在这样，原因是产品定位：**这个工具不贯穿老师整个学期**，她只在需要时打开找协助。记录这些是好事，但不该把她的画像绑得太死——10 条足够撑起「写教案时自动带上」，多了是噪声。另外只淘汰 `frequency = 1` 的条件在 10 条上限下会让上限彻底失效（被反复印证的记忆永远删不掉，条数一路涨），所以一并去掉了。

排序里把「年龄班专长」提到仅次于置顶的位置：老师所带班级决定了整套适龄规则怎么应用，是最不能丢的一条。

---

## 7. 存储估算复核

早前按经验值估算，现在按表结构复算（活跃老师：每周 2 份教案，每份 15–20 轮对话，一年约 100 份）：

| 数据 | 单条 | 每人每年 | 说明 |
|---|---|---|---|
| teachers | ~1 KB | 1 KB | 一次性 |
| conversations | ~3 KB | 300 KB | collected JSONB 是主要体积 |
| messages | ~0.6 KB | 100 份 × 35 条 × 0.6 KB ≈ **2 MB** | |
| lesson_plans | ~12 KB | 100 × 12 KB ≈ **1.2 MB** | md + json 两份 |
| teacher_memories | ~0.3 KB | 20 KB | |
| **数据库合计** | | **≈ 3.5 MB / 人 / 年** | |
| lesson_images | 压缩后 ~400 KB/张 | 假设 30% 教案配 2 张 ≈ **24 MB** | 对象存储，非数据库 |

**结论**：数据库部分比早前估的 10 MB 更省（约 3.5 MB/人/年），1000 个活跃老师一年约 **3.5 GB**，最小规格的云数据库绰绰有余。

图片这次估得比早前保守——早前假设每份教案都配 2 张（100–200 MB/人/年），实际上配图是可选项且要花钱，按 30% 采用率算约 **24 MB/人/年**，1000 人约 24 GB。对象存储成本每月十几元。

**真正的成本变量是配图采用率**，不是存储单价。上线后要监控这个数，它直接决定图片开销。

---

## 8. 数据保留与清理

| 数据 | 策略 |
|---|---|
| 软删除的 conversations / memories | 30 天后物理删除 |
| 失败的 lesson_images | 7 天后清理记录与对象 |
| 90 天未推进的 draft 会话 | 提醒老师，再 90 天后归档 |
| 注销账号 | 级联删除全部数据，对象存储同步清理，7 天内完成 |

---

## 9. 迁移管理

用 migration 工具（Node 用 `node-pg-migrate`，Python 用 `alembic`），**禁止手工改线上库结构**。每个迁移文件必须可回滚。

---

**版本**：1.0 · 2026-08-16
