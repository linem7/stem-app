-- ============================================================
-- 014 · 换绑：她换了微信号
--
-- 这是一个**现在就存在的真缺口**，不是预防性设计。
--
-- 老师的身份就是 openid（微信静默给的）。换手机 openid 不变，
-- 但**换微信号 = 一个全新账号**，她原来的教案、额度、记忆全都在
-- 那个进不去的旧账号里。
--
-- 而她想重新激活时会被「这个手机号已经激活过一个账号了」拦住
-- （routes/account.js 那句），那句文案让她「找发码给你的人处理」——
-- **但后台从来没有任何能处理它的接口**。能清掉 teachers.phone 的地方
-- 只有老师自己注销。也就是说那是一句空头承诺。
--
-- 【为什么不是「把名单那行改回 pending，让她重新领一次」】
-- 那样会新建一个账号，**教案拿不回来** —— 而教案是这个产品全部的价值。
-- 换绑保留教案、额度台账、记忆，以及她已经同意过的协议。
--
-- 【为什么不是「输手机号自动换绑」】
-- 那等于「知道她手机号 + 有任意一个码 = 接管她的账号」，
-- 正是 013 那张表想避开的弱点（手机号不是秘密）。
-- 换绑必须由管理员发起，一次一码。
-- ============================================================

CREATE TABLE IF NOT EXISTS account_rebinds (
  id          BIGSERIAL PRIMARY KEY,

  -- 跟兑换码同一个字符集和形状（utils/code.js），老师分不出也不需要分：
  -- 她在同一个输入框里输，后端认得出来
  code        VARCHAR(32) NOT NULL UNIQUE,

  -- 要挪到哪个账号。CASCADE：那个账号真被删了，这个码也没有意义了
  teacher_id  BIGINT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,

  status      VARCHAR(8) NOT NULL DEFAULT 'pending',  -- pending | used | void

  -- 短有效期。这把钥匙能**接管一整个账号**，比发额度敏感得多，
  -- 不该在外面无限期地飘着
  expires_at  TIMESTAMPTZ NOT NULL,

  created_by  BIGINT,                                  -- admins.id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 换绑留痕。账号所有权转移，事后必须查得到
  -- 「谁在什么时候把哪个账号挪给了哪个微信」
  used_at     TIMESTAMPTZ,
  old_openid  VARCHAR(64),
  new_openid  VARCHAR(64)
);

-- 「这位老师有没有一个还没用的换绑码」—— 生成前要查这个：
-- 已经有 pending 的就返回那一个，**不重复生成**，
-- 否则外面就同时有两把能接管她账号的钥匙
CREATE INDEX IF NOT EXISTS idx_rebind_teacher ON account_rebinds (teacher_id, status);

COMMENT ON TABLE account_rebinds IS
  '换绑码：她换了微信号，把旧账号（教案/额度/记忆/已同意的协议）挪到新 openid 上。
   一次一码、短有效期、只能用一次 —— 它能接管一整个账号';

COMMENT ON COLUMN account_rebinds.old_openid IS
  '换绑前那个 openid。留着是因为这是账号所有权转移，
   事后要查得到「谁把哪个账号挪给了哪个微信」';
