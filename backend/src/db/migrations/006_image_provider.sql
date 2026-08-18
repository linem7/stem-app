-- ============================================================
-- 006 · 这张图是哪个模型画的
--
-- 起因：配图从一家变成两家（2026-08-18 接入 gpt-image-2，与 MiniMax 并存，
-- 老师可以在设置页里换）。两家的长处不一样 ——
--   gpt-image-2：表格线条准。记录表（印出来给孩子填的那张）MiniMax 稳定画不对，
--     试了五次五种错法：7列2行还带手写体乱码、3×3、2×3 顶着一行 "Name ______"…
--   MiniMax：插画类更贴这套设计的扁平矢量调子
--
-- 不记这一列的话，「哪个模型画得好」就只能靠印象说话。图片是主要成本项，
-- 这个判断早晚要做，而且要拿真实采用率说话，不是拿感觉。
--
-- 默认 'minimax'：已有的那些图确实都是它画的，回填成 gpt 就是记了假账。
-- ============================================================

ALTER TABLE lesson_images
  ADD COLUMN IF NOT EXISTS provider VARCHAR(16) NOT NULL DEFAULT 'minimax';

COMMENT ON COLUMN lesson_images.provider IS
  'gpt = gpt-image-2（经 12ai）| minimax = image-01。哪个模型画的，用来对比质量与成本';
