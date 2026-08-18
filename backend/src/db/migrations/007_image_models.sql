-- ============================================================
-- 007 · 自定义配图模型
--
-- 起因：出图这块换得很勤（豆包 → MiniMax → gpt-image-2 → nanobanana），
-- 每换一家都要改代码、重启、发版。而换家的判断标准很朴素 ——
-- 「哪家把记录表的格子画对了」「哪家快」「哪家便宜」，试出来的，不是选出来的。
-- 所以要能**不改代码就加一家**。
--
-- 三种请求格式已经覆盖了目前见到的全部：
--   openai_images —— OpenAI /images/generations 那套（Bearer 头，size=宽x高）
--   gemini        —— Gemini generateContent（key 走 query，尺寸走 aspectRatio + imageSize）
--   minimax       —— MiniMax image_generation（Bearer 头，自带提示词润色开关）
-- 加同格式的新模型 = 填一行配置；只有出现第四种格式时才需要写代码。
--
-- api_key 明文存库。这不理想，但比另外两条路都好：放 .env 就做不到「自己加」，
-- 加密就得再管一把主密钥。前提是这张表**只有超管读得到，而且任何接口都不下发 key**
-- （admin 里一律 mask 成 sk-abcd…，小程序那边连这张表的存在都不知道）。
-- 这条约束要是破了，等于把钥匙串挂在门上。
-- ============================================================

CREATE TABLE IF NOT EXISTS image_models (
  id          BIGSERIAL PRIMARY KEY,
  -- 会存进 lesson_images.provider、会出现在接口里。改它等于改数据
  key         VARCHAR(32)  NOT NULL UNIQUE,
  name_cn     VARCHAR(40)  NOT NULL,
  -- 设置页上那行小字。老师是照着这句选的，写"它擅长什么"，别写参数
  hint        VARCHAR(60)  NOT NULL DEFAULT '',
  format      VARCHAR(24)  NOT NULL,
  base_url    TEXT         NOT NULL,
  api_key     TEXT         NOT NULL,
  model       VARCHAR(80)  NOT NULL,
  -- 各家自己的旋钮：quality（openai）、imageSize（gemini）、optimize（minimax）
  options     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  enabled     BOOLEAN      NOT NULL DEFAULT true,
  sort_order  SMALLINT     NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_image_models_enabled ON image_models (enabled, sort_order);

COMMENT ON TABLE image_models IS
  '自定义配图模型。内置的 gpt / minimax 仍从 .env 读，这张表放的是后台加进来的';
COMMENT ON COLUMN image_models.format IS
  'openai_images | gemini | minimax —— 决定怎么拼请求、怎么解返回';
COMMENT ON COLUMN image_models.api_key IS
  '明文。只有超管读得到，且任何接口都必须 mask 后再下发';
