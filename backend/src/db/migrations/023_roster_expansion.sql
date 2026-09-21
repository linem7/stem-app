-- ============================================================
-- 023 · 名单扩展 + 「不在名单」入口 + 完善信息领额度
--
-- 起因（2026-09-21 用户定）：原来「兑换码 = 你是这批人里的」，
-- 名单是一个园一个园录的。现在要**扩展用户**：
--
--   · 码不限定园所、也不限定「这批人」—— 门还在，门后面的白名单变大
--   · 白名单：2 地区（北京、广州）× 5 园 = 10 园 × 10 老师
--   · 下拉框四级：省 → 市 → 园所 → 班/岗位/人
--   · **始终有一个「不在名单之内」** —— 她找不到自己也能进，自己填信息
--   · 完善信息（学历/出生年/教龄/任教年级）送 10 教案 + 5 配图
--
-- ⚠️ **这次只加三列，而且全是可空的。**
-- 大部分要用的字段库里早就有了，查过再改，别重复建：
--   teachers.education          018 迁移建的
--   teachers.teaching_years     早就有（smallint）
--   teachers.age_group / professional_title
--   teachers.kindergarten_name  「不在名单」的人存园所名靠它
--   kindergartens.province / city / ownership（公办/普惠民办/民办）
-- ============================================================

-- ------------------------------------------------------------
-- 1. 出生年份 —— 完善信息要收的四项之一
--
-- 🔴 **存年份不存年龄。** 年龄这个数会过期：三年后那份数据就变成
-- 「当时 35 岁」，而研究要回答的是「她多大」。
-- 界面显示时用当前年份减它算年龄，数据本身不过期。
--
-- 用 SMALLINT 不用 DATE：只需要年到年，存完整日期是多出来的精度，
-- 而且会让人误以为「生日」这个信息被收上来了 —— 那是不必要的合规义务。
-- ------------------------------------------------------------
ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS birth_year SMALLINT;

COMMENT ON COLUMN teachers.birth_year IS
  '出生年份，不是年龄。**她主动填的**（完善信息那一步），不是 AI 推断的 ——
   这跟记忆抽取那条「不提取年龄」的红线不冲突，那条管的是从对话里自动抽取。
   存年份的理由：年龄会过期，年份不会。';

-- ------------------------------------------------------------
-- 2. 地区三级要的「区」
--
-- kindergartens 已经有 province 和 city 了（010 建的），只差一级。
-- ⚠️ 已有的 area_type 不是这个 —— 它是「城市/县城/乡镇」那种分类，
-- 跟行政区划的「区」不是一回事，别混用。
-- ------------------------------------------------------------
ALTER TABLE kindergartens
  ADD COLUMN IF NOT EXISTS district VARCHAR(32);

COMMENT ON COLUMN kindergartens.district IS
  '行政区划的「区」（朝阳区、天河区）。⚠️ 跟 area_type 不是一回事 ——
   那个是「城市/县城/乡镇」的分类。用户 2026-09-21 定：白名单老师不用填到区，
   但「不在名单」的人要选省-市；区留着给以后用。';

-- ------------------------------------------------------------
-- 3. 她是怎么进来的
--
-- 'roster' = 从四级下拉里认领了一个位置
-- 'self'   = 点了「不在名单之内」，自己填的
--
-- 【为什么要有这一列，而不是靠 roster_entry_id 是不是 NULL 判断】
-- 两条路**都会插一行 teacher_roster**（见下面第 4 节），所以
-- roster_entry_id 两边都不是 NULL，分辨不出来。
--
-- ⚠️ 研究上这一列是**自变量**：白名单老师（有园所、有岗位）
-- 和自填老师（地区靠她自己说）是两个不同的总体，
-- 「AI 写的教案对这两群人的帮助是不是同一回事」正要用它回答。
-- ------------------------------------------------------------
ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS entry_source VARCHAR(16);

COMMENT ON COLUMN teachers.entry_source IS
  'roster = 从名单认领；self = 不在名单、自己填的。研究自变量，别用它做鉴权判断。';

-- 已有账号都是 roster 那条路来的（022 之前只有那一条）
UPDATE teachers SET entry_source = 'roster' WHERE entry_source IS NULL;

-- 加约束放在 UPDATE 之后 —— 先填历史行再加，否则老行过不了校验
ALTER TABLE teachers
  DROP CONSTRAINT IF EXISTS teachers_entry_source_check;
ALTER TABLE teachers
  ADD CONSTRAINT teachers_entry_source_check
  CHECK (entry_source IN ('roster', 'self'));

-- ------------------------------------------------------------
-- 4. 「不在名单」的人也要有 teacher_ref
--
-- 🔴 **为什么不直接建 teachers 行**：`teacher_ref` 是「人」这一层的身份
-- （见 api-spec 的「三层身份」）。研究上要按它归组 ——
-- 「追踪对象是这位老师还是这个班」会变，而自填的人也得能被追踪。
--
-- 所以 self 那条路也**插一行 teacher_roster**，只是：
--   kindergarten_id = NULL   不属于任何园所
--   class_name / position / age_group = NULL   她没提供，也不该编
--   status = 'claimed'       跳过「待认领」，因为不存在「谁去认领它」
--
-- ✅ **这一列不用改**：teacher_roster.status 是 NOT NULL 但没有 CHECK 约束，
-- 而 POSITIONS / AGE_GROUPS 那两套白名单是**代码层**的（roster.js），
-- 不是数据库约束。所以插 NULL 的位置不会被数据库挡住。
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 5. 园所类型改成中文三项
--
-- 原来是 `['public', 'private']`（英文两项，见 admin/kindergartens.js）。
-- 用户 2026-09-21 定：要**中文三项**「公办 / 普惠民办 / 民办」。
--
-- 【为什么「普惠民办」必须单独一档】
-- 它在政策上是独立的一类 —— 收费受政府指导价约束、有生均补助，
-- 跟纯民办在师资和生源上都不是一回事。合成一档之后研究上分不开。
--
-- 【为什么改成中文】
-- 跟已有的白名单风格一致：EDUCATIONS / TITLES / AGE_GROUPS 全是中文。
-- 混着英文码的代价是**每次导出研究数据都要再翻译一次**，
-- 而那种翻译迟早在某一版脚本里漏掉一个值。
--
-- ⚠️ 库里现在两行园所的 ownership 都是 NULL（还没填过），
-- 但映射照写 —— **迁移要在有数据的库上也成立**，
-- 不能因为「现在恰好是空的」就省掉。
-- ------------------------------------------------------------
UPDATE kindergartens SET ownership = '公办' WHERE ownership IN ('public', '公立');
UPDATE kindergartens SET ownership = '民办' WHERE ownership IN ('private', '私立');

COMMENT ON COLUMN kindergartens.ownership IS
  '园所类型：公办 / 普惠民办 / 民办（2026-09-21 从英文 public/private 改成中文三项）。
   ⚠️ 白名单在 services/roster.js 的 OWNERSHIPS —— **只写一份**。
   原来 tasks.js 和 admin/kindergartens.js 各写了一份，三份迟早分叉。';

-- ------------------------------------------------------------
-- 6. 完善信息领额度 —— 防重复领靠 quota_grants.reason
--
-- 判据：查 `reason = '完善信息'` 有没有记录。
-- 🔴 **不能用「四个字段填全了没有」判断** —— 她把学历从大专改成本科
-- 就会再领一次。领过就是领过，跟填得全不全无关。
--
-- ⚠️ quota_grants.reason 是 VARCHAR(64)，够用，不用改。
-- ⚠️ 不需要索引：老师数量是「几十到几百」，而这条查询只在她提交时跑一次。
-- ------------------------------------------------------------
