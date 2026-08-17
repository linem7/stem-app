-- 003_admins.sql
-- 管理员账号表。从「一个环境变量密码」升级成「多账号 + 两级权限」。
--
-- 为什么要分两级（operations.md 第 2 节的承诺直接相关）：
--   老师同意的协议里写着「你的幼儿园和园长看不到这里的任何东西」。
--   同事不是园方，这句承诺依然成立；但「只有开发者本人可见」这个措辞
--   在有第二个人登录后就不准确了，所以协议文案同步改成了「项目团队」。
--
--   同时把最敏感的两项锁在超级管理员手里：**手机号全号**和**对话正文**。
--   同事做运营（发额度、建兑换码、看反馈）不需要读老师写了什么，
--   少一个人能读，那句承诺就多一分是真的。
--
-- 密码用 scrypt 加盐哈希。不用明文也不用 md5：
-- 这张表一旦泄露，攻击者拿到的就是全部老师的手机号和对话内容的入口。

CREATE TABLE IF NOT EXISTS admins (
  id            BIGSERIAL PRIMARY KEY,
  username      VARCHAR(32) NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,        -- scrypt(password, salt) 的 hex
  salt          TEXT        NOT NULL,
  role          VARCHAR(16) NOT NULL DEFAULT 'admin',   -- super | admin
  display_name  VARCHAR(32),                             -- 「张三」，日志和界面上显示谁做的操作
  status        VARCHAR(16) NOT NULL DEFAULT 'active',   -- active | disabled
  created_by    BIGINT REFERENCES admins(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admins_status ON admins (status, role);

-- 操作审计。多个人能改额度之后，「这 20 次是谁发的」必须能查。
-- 单人时期这张表没必要（答案永远是"我"），多人之后它是对账的前提。
CREATE TABLE IF NOT EXISTS admin_logs (
  id         BIGSERIAL PRIMARY KEY,
  admin_id   BIGINT REFERENCES admins(id) ON DELETE SET NULL,
  action     VARCHAR(32) NOT NULL,      -- grant_quota | create_code | void_code | create_admin | …
  target     VARCHAR(64),               -- 操作对象的可读标识（teacher:12 / code:STEM-XXXX）
  detail     JSONB,                     -- 不放对话正文，只放操作参数
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs ON admin_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_who ON admin_logs (admin_id, created_at DESC);
