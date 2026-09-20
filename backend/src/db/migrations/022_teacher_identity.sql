-- ============================================================
-- 022 · 老师账号 = 手机号 + 密码（web 身份模型）
--
-- 起因：ADR-002 转向 web 之后，「身份就是 openid」这个前提没了。
-- 网页里没有 wx.login，拿不到 openid，也没地方放它。
--
-- 【为什么不新建一个库重来】
-- ADR-002 原本写的是「新建空库」，理由是 openid 是唯一键而 web 端没有 openid，
-- 掰弯 21 次迁移不如重写一份干净的 schema。
-- 但真正跟 openid 有关的只有 **4 处** —— teachers.openid、
-- teacher_roster.claimed_openid、account_rebinds 的 old/new_openid。
-- 其余 17 次迁移跟身份无关。而这一次只重写身份这一块，
-- 所以走一次正常迁移，线上那张已经跑通的库不用重建。
--
-- 【openid 为什么不删，只是放开】
-- 注销认人的逻辑原本靠它（「这个微信注销过，不许再登录」，见 account.js 的 DELETE /me）。
-- 现在还留着 21 个迁移跑出来的历史行，删列会让它们失去这个标记。
-- 所以留列、放开 NOT NULL —— 新账号写 NULL，老行保持原样。
-- ⚠️ 它现在是**遗留列**，新代码不该再往里写东西。
--
-- 【手机号为什么不是 NOT NULL】
-- 新账号一定有，老行没有。PostgreSQL 的 UNIQUE 允许多个 NULL，
-- 所以「填了的必须唯一」这条自然成立，不需要额外的部分索引。
-- ============================================================

ALTER TABLE teachers
  ALTER COLUMN openid DROP NOT NULL;

ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS phone         VARCHAR(20),
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_salt TEXT;

-- 登录靠它查人。UNIQUE 顺带挡住「同一个号注册两次」
CREATE UNIQUE INDEX IF NOT EXISTS teachers_phone_key ON teachers (phone);

COMMENT ON COLUMN teachers.openid IS
  '⚠️ 遗留列（小程序时代）。web 端没有 openid，新账号一律 NULL。
   留着是为了让 21 个迁移跑出来的历史行还能被认出来。';
COMMENT ON COLUMN teachers.phone IS
  '老师自己设的登录名。**只是用户名**：不用于联系、不进 AI 提示词、不下发前端、不进日志。
   2026-08-30 定。这一列 016 迁移删过，022 又加回来 —— 变的不是「该不该存」，是「存来干什么」';
COMMENT ON COLUMN teachers.password_hash IS
  'scrypt 哈希，与管理员那套同一个实现（services/admins.js）。
   密码不可逆，所以「重置密码」和「改手机号」是两个不同的动作，都只有超管能做';
COMMENT ON COLUMN teachers.password_salt IS
  '每个账号一份的盐。和 password_hash 同生共死，不许单独改其中一个';
