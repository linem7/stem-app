-- ============================================================
-- 015 · token 版本号：让「换绑」真的意味着旧设备失去访问
--
-- 起因：014 做完之后测出来的一件事 —— 换绑把 openid 挪到**旧那一行**上，
-- 所以旧 token（payload 里是 teacher_id）指向的行还在、**仍然有效**，
-- 最多能再用 30 天（JWT 有效期）。
--
-- 注销没有这个问题：`requireAuth` 每次都查一行并拒绝 status <> 'active'，
-- 而注销把 status 改成 'deleted'，所以那一刻所有已签发的 token 立刻作废。
-- 换绑不改 status，于是漏了。
--
-- 【为什么值得补】
-- 换绑的常见触发原因之一是**手机丢了/换号了**。「换绑」这个词让任何人都以为
-- 旧设备当场失去访问 —— 假设错一个安全属性，比没有这个属性更糟。
--
-- 【为什么这么便宜】
-- `requireAuth` 本来就每次查一行完整的 teachers（见那个函数的注释：
-- 「换来『后台一改立刻生效』的确定性」）。所以多比一个整数，成本是零。
--
-- 兼容：已经签发的老 token 里没有 tv 字段，读出来是 undefined → 当 0 看，
-- 而这一列默认也是 0，所以现有登录**不会被强制退出**。
-- ============================================================

ALTER TABLE teachers
  ADD COLUMN IF NOT EXISTS token_version SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN teachers.token_version IS
  '签发 token 时写进 payload 的 tv，requireAuth 逐个请求比对。
   换绑时 +1 → 旧设备上那个 token 当场失效。
   以后要做「强制所有设备重新登录」也是 +1 这一件事';
