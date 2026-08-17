-- ============================================================
-- 004 · 教案版本历史
--
-- 起因：改稿是覆盖式的（generate.js 那句 ON CONFLICT DO UPDATE ... version + 1），
-- 上一版内容直接没了。老师改完觉得还不如原来那版，没有退路 ——
-- 等于每次提意见都是赌一把，这会让她不敢提意见，而「改一改」正是这个产品的核心。
--
-- 做法：lesson_plans 那一行继续是「当前显示的内容」（前端 GET 不用改结构），
-- 每一版另外落一条快照到这张表。回退 = 把某一版的快照写回那一行，
-- 不新增版本号、不删任何版本，所以可以来回切。
--
-- **图片不在这里出现，也不许按版本清理**：lesson_images 挂在 lesson_plan_id 上，
-- 而那一行的 id 从不变，所以图天然跨版本保留。这是有意的 ——
-- 老师只在觉得某样材料值得画的时候才生成，那份判断不会因为教案改了一句话就失效。
-- ============================================================

CREATE TABLE IF NOT EXISTS lesson_plan_versions (
  id              BIGSERIAL PRIMARY KEY,
  lesson_plan_id  BIGINT NOT NULL REFERENCES lesson_plans(id) ON DELETE CASCADE,

  version         SMALLINT NOT NULL,

  title           VARCHAR(128) NOT NULL,
  age_group       VARCHAR(8)   NOT NULL,
  duration_min    SMALLINT,
  content_md      TEXT  NOT NULL,
  content_json    JSONB NOT NULL,
  quality_self    JSONB,

  -- 产生这一版的那句改稿意见。第 1 版没有（它不是改出来的）。
  -- 老师认版本靠的是「我当时说了什么」，不是版本号，所以这句必须存。
  revise_note     TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一份教案的同一个版本号只能有一条
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_ver_unique
  ON lesson_plan_versions (lesson_plan_id, version);

CREATE INDEX IF NOT EXISTS idx_plan_ver_plan
  ON lesson_plan_versions (lesson_plan_id, version DESC);

-- 当前显示的是第几版。
-- 跟 version 列的区别：version 是「一共出到第几版」的最大值，
-- current_version 是「现在屏幕上这份是哪一版」—— 回退之后两者会不一样。
ALTER TABLE lesson_plans
  ADD COLUMN IF NOT EXISTS current_version SMALLINT;

UPDATE lesson_plans SET current_version = version WHERE current_version IS NULL;

-- 把已经存在的教案补一条 v1 快照，否则它们的历史是空的、回退按钮点了没东西。
-- 补的是「当前内容」，标成它自己的 current_version —— 这是我们能拿到的唯一真相，
-- 之前被覆盖掉的版本是真的找不回来了，不假装有。
INSERT INTO lesson_plan_versions
  (lesson_plan_id, version, title, age_group, duration_min, content_md, content_json, quality_self, revise_note)
SELECT p.id, p.version, p.title, p.age_group, p.duration_min, p.content_md, p.content_json, p.quality_self,
       CASE WHEN p.version > 1 THEN '（这一版之前的历史没有留存）' ELSE NULL END
  FROM lesson_plans p
 WHERE NOT EXISTS (
   SELECT 1 FROM lesson_plan_versions v
    WHERE v.lesson_plan_id = p.id AND v.version = p.version
 );
