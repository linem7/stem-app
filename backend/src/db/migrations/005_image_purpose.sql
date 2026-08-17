-- ============================================================
-- 005 · 配图用途
--
-- 起因：图不是拿来看的，是**拿来打印**的。所以「画成什么形状」取决于印出来干什么 ——
-- 记录表要有能写字的大格子，头饰要有两条能绕头的长带，展示图要有分隔网格。
-- 这些是完全不同的构图规则，用一套提示词出不来。
--
-- purpose 同时决定画布比例（记录表竖版、头饰横版、材料图方版）。
-- ============================================================

ALTER TABLE lesson_images
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(16) NOT NULL DEFAULT 'material';

COMMENT ON COLUMN lesson_images.purpose IS
  'material 材料图 | worksheet 记录表 | headwear 头饰 | display 展示图 | backdrop 环创背景';

-- section_key 现在是可选的：老师自由描述（比如「海洋主题背景墙」）时没有对应的材料下标。
-- 建表时它本来就允许 NULL，这里只是把这件事记下来 —— 别以为漏了约束。
