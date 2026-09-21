-- ============================================================
-- 025 · 职称从六档改成五档
--
-- 起因（2026-09-21 用户定）：原来的六档（未评定 / 三级教师 / 二级教师 /
-- 一级教师 / 高级教师 / 正高级教师）对老师来说太细，改成五档：
--
--     未评级 / 初级 / 中级 / 副高级 / 正高级
--
-- 【为什么是这五个】
-- 这是中小学教师职称序列的**通行粗分**：初级（三级 + 二级）、中级（一级）、
-- 副高级（高级）、正高级。用户补了一句「应该要有副高级」——
-- 即「高级教师」那一档要写成「副高级」，跟「正高级」配对，
-- 因为中小学的「高级教师」在序列上**对应大学的副教授**，
-- 写成「高级」会让人以为它比正高还高一档。
--
-- 【为什么要迁已有数据】
-- 库里已经有 2 行填了旧值（三级教师 1 行、高级教师 1 行）。
-- 不迁的话它们会落在白名单外 —— 而 `PATCH /me` 和 `POST /me/profile`
-- 都会拿白名单校验，**再存一次就被拒**，表现是「她的职称改不动了」。
--
-- ⚠️ 映射按序列合并，不做别的解释：
--     三级教师 → 初级      （三级 = 初级的一档）
--     二级教师 → 初级      （二级 = 初级的一档）
--     一级教师 → 中级      （一级就是中级）
--     高级教师 → 副高级    （中小学的高级 = 副高）
--     正高级教师 → 正高级
--     未评定 → 未评级      （只是措辞统一）
--
-- ⚠️ `TITLES` 那份白名单在 `services/roster.js`，**这个迁移改不了它** ——
-- 两边要一起改，否则库里的值合法、代码却认不出来。
-- ============================================================

UPDATE teachers SET professional_title = '未评级'   WHERE professional_title = '未评定';
UPDATE teachers SET professional_title = '初级'     WHERE professional_title IN ('三级教师', '二级教师');
UPDATE teachers SET professional_title = '中级'     WHERE professional_title = '一级教师';
UPDATE teachers SET professional_title = '副高级'   WHERE professional_title = '高级教师';
UPDATE teachers SET professional_title = '正高级'   WHERE professional_title = '正高级教师';

COMMENT ON COLUMN teachers.professional_title IS
  '职称。**五档**：未评级 / 初级 / 中级 / 副高级 / 正高级（2026-09-21 从六档合并）。
   ⚠️ 「未评级」是她主动选的值，跟 NULL（没填过）不是一回事 ——
   研究上这两者要分得开，任何地方不许把 NULL 显示成「未评级」。
   ⚠️ 白名单在 `services/roster.js` 的 TITLES，**只有那一份**。';
