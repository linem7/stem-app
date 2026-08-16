-- 001_init.sql
-- 建全部 6 张表 + 索引。字段与 docs/design/db-schema.md 逐条对应。
--
-- 合规红线（db-schema.md 第 1 节）：
--   不存手机号、不存真实姓名、不存所带幼儿的任何信息。
--   任何新增字段前先问一句：这条数据是关于老师的，还是关于孩子的？关于孩子的一律不存。

-- ============================================================
-- 1. teachers · 老师
-- ============================================================
CREATE TABLE IF NOT EXISTS teachers (
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

CREATE INDEX IF NOT EXISTS idx_teachers_last_login ON teachers (last_login_at DESC);

-- ============================================================
-- 2. conversations · 教案会话（教案库的数据源）
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
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

  age_group      VARCHAR(8),             -- 从 collected 提升为列，供教案库按年龄班筛选
  has_image      BOOLEAN NOT NULL DEFAULT false,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  deleted_at     TIMESTAMPTZ             -- 软删除，30 天后物理清理
);

-- 三个索引都带 WHERE deleted_at IS NULL：软删除的行永远不会被列表查到，
-- 部分索引比全表索引小得多，也更快。
CREATE INDEX IF NOT EXISTS idx_conv_teacher_updated ON conversations (teacher_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conv_teacher_status  ON conversations (teacher_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conv_teacher_age     ON conversations (teacher_id, age_group)
  WHERE deleted_at IS NULL;

-- ============================================================
-- 3. messages · 对话消息
-- system 消息不入库：它由后端每次实时拼装（框架 + 年龄班规则 + 档案 + 记忆），
-- 存了会大量重复，且改了提示词后旧记录会失真。
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

  role            VARCHAR(16) NOT NULL,   -- system | assistant | user
  content         TEXT NOT NULL,

  -- assistant 提问时的结构化载荷：题号、题干、推荐答案卡片、是否可多选
  payload         JSONB,

  round_index     SMALLINT,
  question_index  SMALLINT,

  token_in        INTEGER,                -- 成本核算用
  token_out       INTEGER,
  model           VARCHAR(32),            -- 'deepseek-chat' 等

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages (conversation_id, id);

-- ============================================================
-- 4. lesson_plans · 教案成稿
-- md 与 json 由同一次生成产出：md 供导出/阅读，json 供分节编辑。
-- 编辑时以 json 为准，md 由 json 重新渲染，禁止两份各自漂移。
-- ============================================================
CREATE TABLE IF NOT EXISTS lesson_plans (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  teacher_id      BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,

  title           VARCHAR(128) NOT NULL,
  age_group       VARCHAR(8)   NOT NULL,
  duration_min    SMALLINT,

  content_md      TEXT  NOT NULL,         -- Markdown 全文，导出和展示用
  content_json    JSONB NOT NULL,         -- 结构化，便于分节渲染与后续编辑

  version         SMALLINT NOT NULL DEFAULT 1,  -- 重新生成则 +1
  quality_self    JSONB,                        -- 模型自检结果，8 维度打分，用于内测分析

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plan_teacher ON lesson_plans (teacher_id, created_at DESC);

-- ============================================================
-- 5. lesson_images · 配图
-- object_key 存对象存储的 key 而不是完整 URL：日后换域名/换云厂商不用改库。
-- ============================================================
CREATE TABLE IF NOT EXISTS lesson_images (
  id             BIGSERIAL PRIMARY KEY,
  lesson_plan_id BIGINT NOT NULL REFERENCES lesson_plans(id) ON DELETE CASCADE,

  section_key    VARCHAR(32),             -- 配到哪一节，如 'flow.1'
  prompt_cn      TEXT,                    -- 老师看到的中文描述
  prompt_sent    TEXT,                    -- 实际发给豆包的提示词
  object_key     TEXT NOT NULL,           -- 对象存储 key，不存完整 URL
  width          SMALLINT,
  height         SMALLINT,
  bytes          INTEGER,

  status         VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending|ready|failed
  error_msg      TEXT,
  cost_cents     INTEGER,                 -- 成本追踪，图片是最大开销

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_img_plan ON lesson_images (lesson_plan_id);

-- 每日配图上限要按老师统计，而配图表上只有 lesson_plan_id。
-- 这个索引让「今天这位老师生成了几张」的计数查询走索引而不是全表扫。
CREATE INDEX IF NOT EXISTS idx_img_created ON lesson_images (created_at DESC);

-- ============================================================
-- 6. teacher_memories · 用户记忆
-- ============================================================
CREATE TABLE IF NOT EXISTS teacher_memories (
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

CREATE INDEX IF NOT EXISTS idx_mem_teacher ON teacher_memories (teacher_id)
  WHERE deleted_at IS NULL;

-- 去重靠 md5(fact) 唯一索引：完全相同的事实插不进来，
-- 代码里用 ON CONFLICT 改成 frequency + 1（见 services/memoryExtractor.js）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_dedupe ON teacher_memories (teacher_id, md5(fact))
  WHERE deleted_at IS NULL;
