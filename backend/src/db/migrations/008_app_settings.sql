-- ============================================================
-- 008 · 运行期设置（键值对）
--
-- 起因：配图用哪个模型，原本由 .env 的 IMAGE_PROVIDER 决定 —— 改一次要进服务器改文件、
-- 再重启后端。而这个选择恰恰是要**经常改**的（哪家把记录表画对了、哪家快、哪家便宜，
-- 都是试出来的），把它锁在服务器文件里，等于锁给会 ssh 的人。
--
-- 同时 2026-08-18 定死了另一条：**老师不选模型**。原来设置页上那个选择器撤掉了 ——
-- 让老师在「GPT 出图」和「MiniMax 出图」之间选，是把我们内部的技术选型摊给她看，
-- 她既没有判断依据，选错了还怪自己。用哪家是我们的事，她只管配图好不好用。
--
-- 所以要有一个「后台改完立刻生效、不用重启」的地方，就是这张表。
-- 只放**运行期可调的运营参数**，不放密钥（密钥在 .env 和 image_models 里）。
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
  key         VARCHAR(48)  PRIMARY KEY,
  value       TEXT         NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by  BIGINT
);

COMMENT ON TABLE app_settings IS
  '运行期可调的运营参数。改完立刻生效，不用重启。不放密钥';
COMMENT ON COLUMN app_settings.key IS
  'image_provider = 配图默认用哪个模型（值是 image_models.key 或内置的 gpt / minimax）';
COMMENT ON COLUMN app_settings.updated_by IS 'admins.id —— 谁改的，配合 admin_logs 对账';
