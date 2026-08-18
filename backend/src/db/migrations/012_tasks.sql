-- ============================================================
-- 012 · 发任务：告诉老师现在有什么活动可以换额度
--
-- 起因（2026-08-18 用户提）：额度只走兑换码一条路之后，
-- 老师怎么知道「现在有个问卷填了能拿 20 次教案」？以前没有任何渠道 ——
-- 只能靠微信群里喊一声，而喊了谁看到、谁没看到，我这边一无所知。
--
-- 任务**不自动发额度**（用户定的）。它只负责三件事：
-- 说清楚做什么（问卷链接）、给多少、什么时候截止。
-- 她填完问卷，我在问卷星那边核对，然后建码发给她，她自己兑。
-- 系统不去猜「她是不是真填了」—— 答卷在问卷星，我们库里没有。
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id           BIGSERIAL PRIMARY KEY,

  title        VARCHAR(64)  NOT NULL,
  body         TEXT,                             -- 做什么、注意什么
  survey_url   TEXT,                             -- 一般是问卷星链接

  -- 奖励写在任务上是**给老师看的承诺**，不是给系统执行的指令。
  -- 真正到账靠我事后发码（redemption_codes.init_text / init_image）
  reward_text  SMALLINT NOT NULL DEFAULT 0,
  reward_image SMALLINT NOT NULL DEFAULT 0,

  deadline     DATE,                             -- 空 = 不限时
  status       VARCHAR(8) NOT NULL DEFAULT 'draft',  -- draft | open | closed

  -- ----------------------------------------------------------
  -- 定向：发给谁。
  --
  -- 一列 JSONB 而不是四张关联表 —— 定向条件是「发的时候拍的快照」，
  -- 不需要被独立查询、不需要外键完整性。园所改了名、改了城乡分类，
  -- 已发出去的任务的定向意图不该跟着变。
  --
  -- 形状（六个维度，全部可选）：
  --   { "provinces": [], "cities": [], "area_types": [],
  --     "ownerships": [], "kindergarten_ids": [], "age_groups": [] }
  --
  -- **空数组 = 这一维不限**。规则是「每个非空维度都要命中」（AND 关系），
  -- 匹配逻辑只在 services/tasks.js 里写一次，管理端的「试算覆盖人数」
  -- 和老师端的「我能看到哪些任务」共用同一个函数 ——
  -- 写两份迟早分叉，而分叉的表现是「后台说发给 12 个人，实际只有 8 个人看到」。
  -- ----------------------------------------------------------
  target       JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_by   BIGINT,                           -- admins.id
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 老师端每次进首页都要查「有没有我能看的、还没过期的任务」，这是最热的一条查询
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks (status, deadline);

COMMENT ON TABLE tasks IS
  '发给老师的活动通知。只承诺奖励，不自动发额度 —— 到账靠事后建码，她自己兑';
COMMENT ON COLUMN tasks.target IS
  '定向条件。空数组 = 该维不限；非空维度之间是 AND。
   匹配逻辑只写在 services/tasks.js，管理端试算与老师端列表共用';
COMMENT ON COLUMN tasks.status IS
  'draft 还在编 | open 已发布 | closed 收了。draft 老师看不到 —— 编到一半不该让人看见';

-- ------------------------------------------------------------
-- 已读。有了它首页那条未读条带才知道该不该出现。
--
-- 没有 read 就是未读，所以不需要 unread 字段 —— 少一个会跟事实不一致的状态位。
-- 复合主键天然防重复：同一个人对同一个任务只可能有一条。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_reads (
  task_id    BIGINT NOT NULL REFERENCES tasks(id)    ON DELETE CASCADE,
  teacher_id BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS idx_task_reads_teacher ON task_reads (teacher_id);

COMMENT ON TABLE task_reads IS
  '谁看过哪个任务。没有记录就是未读 —— 不存 unread 字段，少一个会跟事实不一致的状态位';
