-- 021: 模型注册表两栖化 —— image_models 改名 ai_models，文本模型也进库（2026-08-23）
--
-- 起因：配图模型 08-22 已经彻底搬进库（后台可加可删可设默认），
-- 而文本模型（DeepSeek）还钉死在 .env 里 —— 换模型要改文件重启，加一家要改代码。
-- 这次把同一套机制扩成两栖：一张表、一个 kind 列，后台「模型管理」页两个 section。

-- 1) 改名 + kind。
--    migrate.js 按文件名记账、跑过的不再跑，007 的 CREATE TABLE IF NOT EXISTS
--    不会在老库上复活旧表；全新部署按 007 → 021 顺序执行也正确。
ALTER TABLE image_models RENAME TO ai_models;
ALTER INDEX idx_image_models_enabled RENAME TO idx_ai_models_enabled;
ALTER TABLE ai_models ADD COLUMN kind VARCHAR(8) NOT NULL DEFAULT 'image';
ALTER TABLE ai_models ADD CONSTRAINT ai_models_kind_chk CHECK (kind IN ('image', 'text'));
CREATE INDEX IF NOT EXISTS idx_ai_models_kind ON ai_models (kind, enabled, sort_order);

-- key 保持全局唯一、跨 kind 不重名：它进 lesson_images.provider 和 model_calls.provider，
-- 两类共用一个命名空间，追账时一个 key 只指一个模型。
COMMENT ON COLUMN ai_models.kind IS 'text | image。key 跨 kind 全局唯一';

-- 2) model_calls 加宽。key 的校验正则允许 32 位，而 provider 是 VARCHAR(16)——
--    超长 PG 直接报错，而 recordModelCall 整个吞异常（记账是旁路），结果是静默丢账。
--    model 同理：文本模型名可能超 32（gemini 系已有 30 字符的先例）。
ALTER TABLE model_calls ALTER COLUMN provider TYPE VARCHAR(32);
ALTER TABLE model_calls ALTER COLUMN model TYPE VARCHAR(80);

-- 3) 成本改小数分 + 回填。
--    单次文本调用约 0.1 分，逐行 round 成整数分后绝大多数历史行是 0 ——
--    以前靠 sumTextSpend 按 SUM(token)×全局单价补救，但多家厂商不同价之后
--    这个补救在数学上不再成立，必须逐行按各自单价算好存 NUMERIC。
--    顺带修既有暗伤：园所花费页早就在 SUM(m.cost_cents)，现在就系统性偏低。
ALTER TABLE model_calls ALTER COLUMN cost_cents TYPE NUMERIC(12,4);

-- 回填历史行。200/800（分/百万token）与 config.js 里 DEEPSEEK_PRICE_* 的默认值一致；
-- ⚠️ 如果 .env 改过单价，跑迁移前手调这两个数。
UPDATE model_calls
   SET cost_cents = (COALESCE(token_in, 0)::numeric / 1e6) * 200
                  + (COALESCE(token_out, 0)::numeric / 1e6) * 800
 WHERE provider = 'deepseek'
   AND (token_in IS NOT NULL OR token_out IS NOT NULL);
