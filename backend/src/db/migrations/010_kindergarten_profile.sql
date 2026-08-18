-- ============================================================
-- 010 · 园所档案：从「一个名字」变成「一个可定向的对象」
--
-- 起因（2026-08-18 用户提）：园所页原来只有名字、备注、老师数，
-- 而管理端真正要回答的是「哪个园在用、这个园什么情况、我该给谁派任务」。
-- 名字回答不了任何一个。
--
-- 更硬的理由是**任务定向**（012 迁移）：用户要向「特定地区或特殊群体」发任务 ——
-- 只发给农村园、只发给某个省、只发给公办园。这几个条件必须先在这张表里存在，
-- 否则定向就无从下手。所以这一版加的不是装饰字段，是定向的依据。
--
-- 不做行政区划表、不做级联下拉：合作园有几个就有几行，一份维护不动的
-- 省市县全量表带来的错误（漏更新、名称不一致）比手填多。填错了在详情里改。
-- ============================================================

ALTER TABLE kindergartens
  ADD COLUMN IF NOT EXISTS province      VARCHAR(16),   -- 如「广东」，不带「省」字后缀，统计时好分组
  ADD COLUMN IF NOT EXISTS city          VARCHAR(32),   -- 如「广州」
  ADD COLUMN IF NOT EXISTS area_type     VARCHAR(8),    -- city | county | rural
  ADD COLUMN IF NOT EXISTS ownership     VARCHAR(8),    -- public | private
  ADD COLUMN IF NOT EXISTS teacher_count SMALLINT,      -- 在园教师总数（不是在这个平台注册的人数）
  ADD COLUMN IF NOT EXISTS child_count   SMALLINT,      -- 在园幼儿总数 —— 见下面那条注释
  ADD COLUMN IF NOT EXISTS contact_name  VARCHAR(32),   -- 通常是园长
  ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(20);

-- 定向要按这三个维度筛老师，都会进 WHERE
CREATE INDEX IF NOT EXISTS idx_kg_region ON kindergartens (province, city);
CREATE INDEX IF NOT EXISTS idx_kg_type   ON kindergartens (area_type, ownership);

COMMENT ON COLUMN kindergartens.area_type IS
  'city 城市 | county 县镇 | rural 农村。农村园和城市园的材料条件、班额、家长参与度差很多，
   适龄规则的验证要分开看，任务也常常只发给其中一类';

COMMENT ON COLUMN kindergartens.ownership IS 'public 公办 | private 民办';

-- ============================================================
-- 这条注释是这次迁移里最重要的一行，**不要删**。
--
-- CLAUDE.md 有一条永不变的红线：「不存幼儿的任何信息」。
-- child_count 看起来撞线，其实没有 —— 2026-08-18 用户明确确认过界线：
--
--   禁的是**个体信息**（某个孩子的姓名、生日、照片、家长联系方式、
--   能力评价、行为记录）。child_count 是一个**机构规模数字**，
--   不指向任何一个孩子，跟 teacher_count 同类。
--
-- 界线只到这儿：**不许出现按班级、按年龄段、按任何维度拆到能定位到人的幼儿数据**。
-- 下一个想加「小班有几个孩子」「哪几个孩子过敏」的人，看到这里请停下。
-- ============================================================
COMMENT ON COLUMN kindergartens.child_count IS
  '在园幼儿总数。机构规模，不指向任何一个孩子 —— 与「不存幼儿的任何信息」不冲突。
   不许再往下拆（按班、按年龄段、按个体一律不存）';

-- 园长的联系方式，不是老师的。但同样的纪律：永不下发前端、永不进模型提示词、永不进日志。
-- 它跟「幼儿园管理者看不到任何老师数据」不矛盾 —— 这是我们联系他，不是他登录进来看东西。
-- 仍然**没有**「园所管理员」这种角色。
COMMENT ON COLUMN kindergartens.contact_phone IS
  '园长/联系人的电话。永不下发前端、永不进日志。有它不等于给园方开账号 —— 没有园所管理员这种角色';
