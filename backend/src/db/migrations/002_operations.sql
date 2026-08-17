-- 002_operations.sql
-- 运营体系：兑换码身份、额度台账、反馈、园所。字段与 docs/design/operations.md 逐条对应。
--
-- 合规变化（重要，与 001 的注释相反）：
--   001 写的是「不存手机号、不存真实姓名」。2026-08-17 用户明确反转了这条 ——
--   这是合作研究项目，老师填问卷换使用权，手机号是对账问卷与小程序账号的业务锚点。
--   但三条铁律不变：
--     1. 手机号 / 姓名永不下发到小程序前端、永不进模型提示词、永不进日志
--     2. 幼儿园管理者看不到任何老师数据（后台只有开发者一个账号，没有园所管理员这种角色）
--     3. **不存幼儿的任何信息** —— 这条永远不变
--   任何新增字段前仍然先问一句：这条数据是关于老师的，还是关于孩子的？关于孩子的一律不存。

-- ============================================================
-- 7. kindergartens · 园所
-- 做成固定列表而不是自由文本：问卷里老师手填「阳光幼儿园」和「阳光园」
-- 会变成两个园，按园统计用量和发额度时就对不上了。
-- ============================================================
CREATE TABLE IF NOT EXISTS kindergartens (
  id         BIGSERIAL PRIMARY KEY,
  name       VARCHAR(128) NOT NULL UNIQUE,
  note       TEXT,                                   -- 备注：合作起止、联系人等
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- teachers 增列 · 身份信息全部来自问卷，经兑换码带进来
-- ============================================================
ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS phone           VARCHAR(20),      -- 业务锚点。后台列表打码显示，详情页才看全号
  ADD COLUMN IF NOT EXISTS real_name       VARCHAR(32),      -- 积分要发给具体的人，得知道是谁
  ADD COLUMN IF NOT EXISTS position         VARCHAR(16),     -- 主班 | 配班 | 保育员 | 园长 | 其他
  ADD COLUMN IF NOT EXISTS class_name      VARCHAR(32),      -- 如「中二班」。age_group 另有列
  ADD COLUMN IF NOT EXISTS kindergarten_id BIGINT REFERENCES kindergartens(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS activated_at    TIMESTAMPTZ,      -- 兑换码激活时间。为空 = 还没激活，进不了主流程
  ADD COLUMN IF NOT EXISTS agreed_at       TIMESTAMPTZ;      -- 协议同意时间。为空 = 还没同意

-- 手机号唯一：一个人换了微信号重新登录，不能靠新 openid 白拿一份额度。
-- 部分索引跳过 NULL —— 还没激活的账号没有手机号，它们之间不该互相冲突。
CREATE UNIQUE INDEX IF NOT EXISTS idx_teachers_phone ON teachers (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teachers_kg ON teachers (kindergarten_id);

-- ============================================================
-- 8. redemption_codes · 兑换码
--
-- 为什么要有这张表：个人主体小程序用不了微信「手机号快速验证」组件，
-- 而手机号本来就在问卷里 —— 缺的只是「问卷里这个人」和「小程序里这个 openid」的连接。
-- 兑换码就是这根线，顺便天然成了权限门槛：没有码就进不来。
--
-- 码只用于**首次激活**。之后的任务奖励不发新码，后台按手机号找到人直接加一行额度。
-- ============================================================
CREATE TABLE IF NOT EXISTS redemption_codes (
  id              BIGSERIAL PRIMARY KEY,
  code            VARCHAR(32) NOT NULL UNIQUE,   -- 人可读、可微信转发，避免易混字符（见 utils/code.js）

  -- 身份信息，生成码时从问卷答卷录入
  phone           VARCHAR(20)  NOT NULL,
  real_name       VARCHAR(32)  NOT NULL,
  kindergarten_id BIGINT REFERENCES kindergartens(id) ON DELETE SET NULL,
  class_name      VARCHAR(32),
  position        VARCHAR(16),
  age_group       VARCHAR(8),                    -- 小班 | 中班 | 大班，作为她档案的默认年龄班

  -- 首笔额度，激活时一并入账
  init_text       SMALLINT NOT NULL DEFAULT 20,
  init_image      SMALLINT NOT NULL DEFAULT 10,
  grant_reason    VARCHAR(64) NOT NULL DEFAULT '首次激活',

  status          VARCHAR(16) NOT NULL DEFAULT 'unused',  -- unused | used | void
  used_by         BIGINT REFERENCES teachers(id) ON DELETE SET NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_code_status ON redemption_codes (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_phone  ON redemption_codes (phone);

-- ============================================================
-- 9. quota_grants · 额度发放台账
--
-- 只插入、不修改、不删除。余额是算出来的，不是存出来的：
--     余额 = Σ(本表的发放) − 消耗(从 lesson_plans / lesson_images 数出来)
--
-- 为什么不存一个 balance 字段：那样就有了两份事实，而它们迟早对不上
-- （某次生成失败后忘了退、某次并发扣了两次），到时候谁都说不清哪个是对的。
-- 台账加事实表，任何时刻都能重算，也能回答「她为什么有 40 次额度」。
--
-- reason 必填：这既是对账依据，也是研究记录（哪期问卷换来了多少使用量）。
-- ============================================================
CREATE TABLE IF NOT EXISTS quota_grants (
  id           BIGSERIAL PRIMARY KEY,
  teacher_id   BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  delta_text   SMALLINT NOT NULL DEFAULT 0,   -- 文案额度增减，允许负数（发错了就冲一笔，不改历史）
  delta_image  SMALLINT NOT NULL DEFAULT 0,
  reason       VARCHAR(64) NOT NULL,          -- 「完成8月问卷」「首次激活」「反馈奖励」…
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grant_teacher ON quota_grants (teacher_id, created_at DESC);

-- ============================================================
-- 10. feedback · 反馈
--
-- 两类合一张表，靠 kind 区分：
--   lesson_rating —— 成稿页的一次点击评价，**绑 lesson_plan_id + plan_version**。
--                    绑版本是关键：后台看到的是「大班搭高塔的 v2 被标了用不了，原文在这」，
--                    而不是一句无从查起的抱怨。这是「教案是否真的适龄可用」
--                    这个最大未知数的持续数据源。
--   suggestion    —— 「我的」页的产品建议。
-- ============================================================
CREATE TABLE IF NOT EXISTS feedback (
  id             BIGSERIAL PRIMARY KEY,
  teacher_id     BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  kind           VARCHAR(16) NOT NULL,          -- lesson_rating | suggestion

  -- kind = lesson_rating 时用
  lesson_plan_id BIGINT REFERENCES lesson_plans(id) ON DELETE SET NULL,
  plan_version   SMALLINT,
  rating         VARCHAR(16),                   -- usable | needs_edit | unusable

  -- kind = suggestion 时用
  category       VARCHAR(16),                   -- quality | feature | usability | other

  text           TEXT,                          -- 两类都可选填
  handled        BOOLEAN NOT NULL DEFAULT false, -- 开发者看过并处理了（奖励额度时勾上，防重复发）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fb_teacher ON feedback (teacher_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fb_kind    ON feedback (kind, created_at DESC);
-- 同一份教案的同一个版本只留最新一条评价，老师改主意是覆盖不是叠加
CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_plan_version
  ON feedback (lesson_plan_id, plan_version) WHERE kind = 'lesson_rating';
