-- ============================================================
-- 011 · 平台自己的账：我充了多少钱，花了多少，还剩多少
--
-- 起因（2026-08-18 用户提）：概览要回答「我账面上还剩多少钱」。
-- 这个数以前根本算不出来，因为库里缺两头：
--
--   · **收**：没有任何充值记录。我在 DeepSeek / 12ai 充了多少钱，库里一无所知
--   · **支**：只有配图成本（lesson_images.cost_cents），**文本成本一分钱都没记**。
--     deepseek.js 每次调用都拿到了 token 数，但 generate.js 只把它写进日志
--     （messages 表那两个 token 列存在却从来没被写过：240 行里 0 行有值）。
--     而生成一份教案是最贵的一次调用 —— 漏掉它，那个「花了多少」是错的
--
-- 所以这张迁移一张表管收、一张表管支。
--
-- 跟额度台账（quota_grants）同一个思路：**余额是算出来的，不是存出来的**。
--   账面剩余 = Σ充值 − (Σ配图成本 + Σ文本成本)
-- 不存 balance 字段的理由一样实际：那样就有两份事实，迟早对不上，
-- 而这是要拿去跟真金白银对账的数。
-- ============================================================

-- ------------------------------------------------------------
-- 收：充值台账。只追加，不修改 —— 记错了就冲一笔负数，不改历史
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_topups (
  id           BIGSERIAL PRIMARY KEY,

  amount_cents INTEGER      NOT NULL,          -- 整数分。允许负数（记错了冲账、退款）
  channel      VARCHAR(16)  NOT NULL,          -- deepseek | 12ai | minimax | other
  note         VARCHAR(128),                   -- 「8月充值」「12ai 补 200」之类

  -- 充值发生的日期由人填，不用 created_at：常常是过了几天才想起来补录，
  -- 而按月对账要按实际发生的日子算
  occurred_on  DATE         NOT NULL DEFAULT current_date,

  created_by   BIGINT,                         -- admins.id
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_topup_on ON platform_topups (occurred_on DESC);

COMMENT ON TABLE platform_topups IS
  '我在各家模型厂商充了多少钱。只追加：记错了冲一笔负数，不改历史';
COMMENT ON COLUMN platform_topups.amount_cents IS '整数分。负数 = 冲账或退款';
COMMENT ON COLUMN platform_topups.occurred_on IS
  '充值实际发生的日期，人填。常常隔几天才补录，而按月对账要按实际日子算';

-- ------------------------------------------------------------
-- 支（文本那一半）：每次模型调用一行
--
-- 为什么不复用 messages.token_in 那两列：
--   **生成教案那次调用根本没有对应的 message 行** —— 成稿进的是 lesson_plans，
--   而它恰好是最贵的一次。挂在 messages 上就一定漏掉它。
--
-- 单独一张表还顺带能回答「这个园/这位老师花了多少文本钱」，
-- 而这正是概览「哪个园用了多少」要的东西。
--
-- teacher_id 可空：有些调用不属于某位老师（比如后台试跑）。
-- ON DELETE SET NULL 而不是 CASCADE —— 老师注销了，那笔钱是真花掉的，
-- 不能跟着消失，只是从此不再关联到任何人（跟注销「留壳去身份」同一个道理）。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_calls (
  id          BIGSERIAL PRIMARY KEY,

  teacher_id  BIGINT REFERENCES teachers(id) ON DELETE SET NULL,
  purpose     VARCHAR(32),                     -- questions | generate | revise | memory | ...
  provider    VARCHAR(16)  NOT NULL,           -- deepseek
  model       VARCHAR(32),

  token_in    INTEGER,
  token_out   INTEGER,
  -- 按 config.js 里的单价算出来的钱，落库时就算好。
  -- 为什么不等查询时再乘：**单价会变**，去年的调用要按去年的价算。
  -- 存当时算出的结果，历史才不会因为改了一个常量而集体漂移
  cost_cents  INTEGER,

  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mc_created ON model_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mc_teacher ON model_calls (teacher_id, created_at DESC);

COMMENT ON TABLE model_calls IS
  '每次文本模型调用一行。填掉「文本成本一分钱没记」这个洞 ——
   在此之前只有配图成本，而生成教案那次调用是最贵的';
COMMENT ON COLUMN model_calls.cost_cents IS
  '落库时按当时的单价算好。不留到查询时再乘：单价会变，历史不该跟着漂移';
