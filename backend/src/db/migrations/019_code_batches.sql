-- ============================================================
-- 019 · 兑换码按「一次操作」登记
--
-- 起因（2026-08-21 用户提）：兑换码那一页是**一个码一行**。
-- 而实际动作是「批量建 20 个灌进问卷星」——那一次操作在列表里摊成 20 行，
-- 几批混在一起按时间倒序排，分不出哪 20 个是刚才那一批的。
-- 用户要的是「按操作次数登记，每一次操作占一行」。
--
-- 【为什么必须建表，不能靠时间戳凑批】
-- 想过用 (created_at 到秒, grant_reason, init_text, init_image) 分组代替。
-- 不行：同一秒里可以有两次不同的操作，而两次参数完全相同的批量建码
-- （「批量发放 20/10」建两次）会被合成一批 —— 于是「重新抄录给没收到的人」
-- 抄出来的是 40 个码。而这个功能存在的全部理由就是那份**准确的**码单。
-- 凑批还有一个更糟的性质：它在大多数情况下看起来是对的。
--
-- 【删批次时已兑的码怎么办】
-- 用户定的是「删操作，已兑的码留在库里」。所以 batch_id 是
-- **ON DELETE SET NULL** —— 批次行删掉，已兑的码活下来变成一条无所属的历史，
-- 老师详情里「她兑的是哪个码」照样查得到（那是额度从哪来的唯一凭据）。
-- 未兑的码由应用层跟着批次一起删（见 POST /codes/batches/delete）：
-- 它们没发出去过，留着只是噪音。
--
-- 【为什么不给 code_batches 加「已用几张」这种计数列】
-- 跟额度台账、平台账同一条纪律：**汇总数是算出来的，不是存出来的**。
-- 存一列 used_count 就有了两份事实，而老师兑码的时候没人会记得去 +1。
-- 列表那个 3/20 是 COUNT 出来的。
-- ============================================================

CREATE TABLE IF NOT EXISTS code_batches (
  id              BIGSERIAL PRIMARY KEY,
  -- 'single' = 一次建一个（新建兑换码），'batch' = 一次建 N 个（批量建码）。
  -- 分开记是因为界面上要区分：单张显示 1/1，批量显示 3/20
  kind            VARCHAR(16)  NOT NULL DEFAULT 'batch',
  -- 这一次操作**要建**几个。跟实际建成的张数分开：撞码重试失败时可能少建，
  -- 两个数不一样本身就是要看见的信息
  requested       INTEGER      NOT NULL DEFAULT 1,
  init_text       INTEGER      NOT NULL DEFAULT 0,
  init_image      INTEGER      NOT NULL DEFAULT 0,
  grant_reason    VARCHAR(128),
  -- 单张建码可以指定园所（整批交给某个园时，「发了几个、兑了几个」是跟进合作的依据）。
  -- 批量建码**不绑园所**（2026-08-21 用户定：谁持有谁使用），所以这一列常常是空。
  -- 园所删掉不该连累这条操作记录，所以 SET NULL
  kindergarten_id BIGINT       REFERENCES kindergartens(id) ON DELETE SET NULL,
  created_by      BIGINT       REFERENCES admins(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE code_batches IS
  '一行 = 一次建码操作。兑换码列表按这张表列，不按 redemption_codes 列。
   「共几张 / 已用几张」一律 COUNT redemption_codes 算出来，不存计数列。';

ALTER TABLE redemption_codes
  ADD COLUMN IF NOT EXISTS batch_id BIGINT
    REFERENCES code_batches(id) ON DELETE SET NULL;

COMMENT ON COLUMN redemption_codes.batch_id IS
  '这个码是哪一次操作建出来的。**ON DELETE SET NULL**：删批次时已兑的码
   要留下来（老师详情里「她兑的码」是额度来源的唯一凭据），
   于是它变成一条 batch_id 为空的历史记录。为空也可能是 019 之前建的老码。';

-- 列表要按批次取「共几张 / 已用几张」，详情要取某一批的全部码
CREATE INDEX IF NOT EXISTS idx_redemption_codes_batch
  ON redemption_codes (batch_id);

-- ------------------------------------------------------------
-- 回填：把 019 之前的码归到批次里
--
-- 这里**可以**用时间戳凑批（上面说过它不可靠），因为对历史数据没有别的办法，
-- 而不回填的代价是那些码在新界面上一条都看不见。
-- 两点让它足够安全：
--   · 只动 batch_id IS NULL 的行，跑一次之后就没有可动的了
--   · 凑错了的后果是「历史上某两批显示成了一批」，不影响以后的操作 ——
--     新建的码从此都带着真实的 batch_id
--
-- 分组键取到**秒**加上三个参数：同一次批量建码是在一个循环里连续插入的。
-- ------------------------------------------------------------
WITH grouped AS (
  SELECT date_trunc('second', created_at) AS sec,
         COALESCE(grant_reason, '')       AS reason,
         init_text, init_image, kindergarten_id,
         COUNT(*)::int                    AS n,
         MIN(created_at)                  AS first_at
    FROM redemption_codes
   WHERE batch_id IS NULL
   GROUP BY 1,2,3,4,5
), made AS (
  INSERT INTO code_batches (kind, requested, init_text, init_image,
                            grant_reason, kindergarten_id, created_at)
  SELECT CASE WHEN n = 1 THEN 'single' ELSE 'batch' END,
         n, init_text, init_image,
         NULLIF(reason, ''), kindergarten_id, first_at
    FROM grouped
  RETURNING id, kind, requested, init_text, init_image, grant_reason,
            kindergarten_id, created_at
)
UPDATE redemption_codes c
   SET batch_id = m.id
  FROM made m
 WHERE c.batch_id IS NULL
   AND date_trunc('second', c.created_at) = date_trunc('second', m.created_at)
   AND COALESCE(c.grant_reason, '') = COALESCE(m.grant_reason, '')
   AND c.init_text = m.init_text
   AND c.init_image = m.init_image
   AND c.kindergarten_id IS NOT DISTINCT FROM m.kindergarten_id;
