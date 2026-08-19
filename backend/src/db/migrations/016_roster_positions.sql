-- ============================================================
-- 016 · 名单从「一份手机号清单」变成「一份岗位清单」，手机号彻底删掉
--
-- 013 的模型是「码 + 手机号」：她手打手机号，跟名单核对。
-- 2026-08-19 用户重新想了一遍，改成「码 + 从名单里选自己是谁」：
-- 园所 → 班级 → 岗位·姓氏，四级选下来。
--
-- 【为什么这样更好】
--   1. **手机号是 11 位手打，打错一位是常事**，而她分不清是「码坏了」
--      还是「我打错了」。从列表里认自己，出错概率低一个数量级
--   2. 手机号本来也不是秘密（微信群、报名表上都有），当第二把钥匙其实不硬
--   3. 她要证明的事情本来就只是「我是阳光幼儿园小一班的主班」——
--      那句话里没有手机号。库里少一样可识别到人的东西，就少一整套合规义务
--
-- 【要认下来的代价】
-- 从列表里选是一个**表单字段，不是钥匙**：谁有码都能滚到任何一行。
-- 所以真正的门槛只剩码那一把。可以接受，因为同事之间冒领没有收益
-- （她自己填问卷也能拿到同样额度），而真会发生的「手滑选错同班另一位」
-- 是可查可改的 —— claimed_openid 记着是谁认领的。
--
-- 【三层身份：人 / 位置 / 账号】
-- 长期研究里「追踪对象是这位老师，还是这个班」会变，所以分三层：
--   teacher_ref            人。永不变，跨班跨园跟着她
--   teacher_roster.id      位置（class_teacher_id）：人 × 园 × 班 × 岗位
--   teachers.id            账号。换微信靠换绑码保住
-- 想追人按 teacher_ref 归组，想追班按（园所 + 班级）归组。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 人的稳定编号
--
-- 从 1001 起：一眼能看出这是我分配的编号，而不是某张表的自增主键。
-- 她换班时新开一行、沿用同一个 teacher_ref，所以这一列**不唯一**。
-- ------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS teacher_ref_seq START 1001;

ALTER TABLE teacher_roster
  ADD COLUMN IF NOT EXISTS teacher_ref BIGINT,
  -- 两个同姓配班时用来区分（「配班（靠窗）」这种）。她选的时候会看到
  ADD COLUMN IF NOT EXISTS note_public VARCHAR(32);

UPDATE teacher_roster SET teacher_ref = nextval('teacher_ref_seq') WHERE teacher_ref IS NULL;
ALTER TABLE teacher_roster ALTER COLUMN teacher_ref SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_roster_ref ON teacher_roster (teacher_ref);

-- moved：她换班了，这一行是历史。**不删** ——
-- 研究要用它区分「她在小一班那半年」和「她在中二班这半年」
COMMENT ON COLUMN teacher_roster.status IS
  'pending 等她来认领 | claimed 已激活 | void 作废 | moved 她换班了，这一行是历史（不删）';
COMMENT ON COLUMN teacher_roster.teacher_ref IS
  '人的稳定编号，我录名单时分配。**不唯一** —— 她换班时新开一行、沿用同一个值。
   研究要追这位老师就按它归组；要追这个班就按（kindergarten_id, class_name）归组';

-- ------------------------------------------------------------
-- 2. 手机号删干净
--
-- 这一步是不可逆的（列删了数据就没了）。之所以敢删：
--   · 库里现在只有开发期造的假号（138xxxx），没有一个真老师的号
--   · CLAUDE.md 那条前提本来就写着「真实手机号要等伦理审查才能进库」
--   · 留一列没人写的手机号，只会让下一个人以为它还在用
-- ------------------------------------------------------------
DROP INDEX IF EXISTS idx_teachers_phone;
ALTER TABLE teacher_roster DROP COLUMN IF EXISTS phone;
ALTER TABLE teachers       DROP COLUMN IF EXISTS phone;

-- 「绑定码」那条路一起撤掉：码从此一律是匿名的一池，身份全部来自名单。
-- 留着两套激活逻辑，以后改其中一条一定会忘了另一条
ALTER TABLE redemption_codes
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS real_name,
  DROP COLUMN IF EXISTS class_name,
  DROP COLUMN IF EXISTS position,
  DROP COLUMN IF EXISTS age_group;

-- ------------------------------------------------------------
-- 3. 账号指向她认领的那个位置
-- ------------------------------------------------------------
ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS roster_entry_id BIGINT
    REFERENCES teacher_roster(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_teachers_roster ON teachers (roster_entry_id);

COMMENT ON COLUMN teachers.roster_entry_id IS
  '她认领的那个位置（= class_teacher_id）。换班时后台把它指到新那一行';

-- 把已经激活的账号补连上它认领的那一行（013/014 期间激活的那些）
UPDATE teachers t
   SET roster_entry_id = r.id
  FROM teacher_roster r
 WHERE r.claimed_by = t.id AND t.roster_entry_id IS NULL;
