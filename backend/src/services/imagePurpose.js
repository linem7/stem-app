/**
 * 配图用途 —— 决定「画成什么形状」和「多大画布」。
 *
 * 核心前提：**这些图是老师要打印出来在活动里用的**，不是拿来看的。
 * 所以同一个主题，用途不同，构图完全是两回事：
 *   记录表要有能写字的大格子，头饰要有能绕头的两条长带，
 *   展示图要有把物品隔开的网格，背景墙要中间留白给孩子贴作品。
 * 这些不是"风格微调"，用一套提示词根本出不来。
 *
 * 两条贯穿所有用途的硬规则：
 *
 * 1. **一个字都不许画**。模型写中文必然是乱码，印出来就是废纸。
 *    需要表头、标签的地方一律用简笔图标代替。
 * 2. **不画人，尤其不画儿童面孔**。这个风险靠"不要画脸"压不住
 *    （实测 4 张里 2 张照样画正脸），靠"画面里本来就不该有人"才压得住。
 *    唯一的例外是头饰上的动物/角色图案，那是图形不是人像。
 */

/** 出图一律 2048 长边：这图的终点是打印机，不是屏幕。A4 上约 250 DPI */
const LONG = 2048;

/**
 * 所有用途共用的英文负面约束，拼在风格前缀末尾。
 *
 * 为什么必须是**英文**、必须在前缀里：中文那几条规则是写给 DeepSeek 看的，
 * 它只影响 DeepSeek 翻出来的那句英文描述；**图片模型从头到尾没见过那段中文**。
 * 第一版就是这么翻的车 —— 中文写着「一个字都不许画」，出来的记录表上却印着
 * BOAT / HEAVY STONE / LEAF，还有一个拼错的 BUBRAIIN CORK 和右下角一个假签名。
 * 负面约束只有落在图片模型真正读到的那段英文里才有效。
 */
const NO_TEXT =
  ' Absolutely no text of any kind: no letters, no words, no numbers, no captions, no labels, ' +
  'no handwriting, no signature, no watermark, no logo.';

export const PURPOSES = {
  material: {
    cn: '材料图',
    hint: '单样材料，照着去准备',
    width: 1536,
    height: 1536,
    style:
      'Plain flat cream background, no room, no floor, no wall, no corner, no perspective, no scenery. ' +
      'The object is drawn large and centered, filling most of the frame, like a catalogue item.',
    rules: `1. 画的是**这样材料本身**，静物。写清楚它是什么、什么形状、大概什么尺寸、准备几份
2. 材料若是一组同类物（比如"10 块积木"），画成整齐排开的一组，同样占满画面
3. 不要背景故事、不要教室场景、不要正在被使用的样子
4. 描述以 "drawn large, filling the frame" 之类的说法收尾`,
  },

  worksheet: {
    cn: '记录表',
    hint: '打印发给孩子写写画画',
    // 竖版对着 A4。白底不是奶油底 —— 打印省墨，孩子写上去也清楚
    width: 1536,
    height: LONG,
    // 文档类图必须关掉 MiniMax 的提示词润色：它会把「练习纸」的套路补齐 ——
    // 标题栏、出版社水印、页脚花边，而这些恰恰是我们写死不许有的
    optimize: false,
    style:
      'A blank printable worksheet for young children. Pure white background. ' +
      'One single table with thick clean black gridlines. The first row of the table contains ' +
      'small simple line-art picture icons as column headers, one icon centered inside each cell. ' +
      'Every other cell is completely empty white space for children to draw in. ' +
      'Large cells, generous spacing, portrait orientation, like a photocopiable activity sheet.',
    rules: `1. 这是一张**空白的、给孩子写画的表**，不是填好的示意图
2. **格子里必须是空的**，留出写字画画的地方；线要粗、格子要大（3-4 岁握笔不稳）
3. 每一列的含义用**简笔图标**表示，图标要画在表格第一行的格子**里面**，不要飘在表格外
   —— 飘在外面老师就对不上是哪一列了。绝对不要写字
4. 结构简单：最多 3 列 × 4 行，再多小班孩子对不上格
5. 描述里要出现 "large empty boxes for children to draw in"`,
  },

  headwear: {
    cn: '头饰',
    hint: '打印剪下来戴头上',
    // 横版。两条长带要够长，宽高比越扁越好用
    width: LONG,
    height: 1024,
    style:
      'A printable cut-out headband template, laid flat, viewed straight on. ' +
      'A decorated shape in the center with two long straight horizontal strips that extend all the way ' +
      'to the very left and right edges of the image, running off the canvas, to wrap around a head. ' +
      'Plain white background, thick clean outlines suitable for cutting, ' +
      'flat vector style, soft yellow / mint green / sky blue palette.',
    rules: `1. 画的是**摊平的头饰纸样**，不是戴在头上的样子 —— 老师要照着剪
2. 中间是主体图案（动物、植物、角色的正面简笔形象），**左右各接一条水平长带**，
   两条带子必须一直画到画面最左边和最右边、被画面切断，那是绕头一圈用的 ——
   带子没顶到边，印出来就短一截，围不上小孩的头
3. 轮廓线要粗、要闭合，方便沿线剪
4. 带子上可以有简单重复花纹，但不要复杂到剪不动
5. 描述里要出现 "flat cut-out template with two long horizontal side strips"`,
  },

  display: {
    cn: '展示图',
    hint: '一格一样，贴展示板上介绍',
    width: LONG,
    height: 1536,
    style:
      'A tidy grid poster on a plain cream background. The frame is divided into equal rectangular cells ' +
      'by clean thin dividing lines, one single object drawn large and centered inside each cell. ' +
      'Flat vector style, soft yellow / mint green / sky blue palette, no photorealism.',
    rules: `1. 画成**网格**，2×2 或 3×2，格与格之间有清楚的分隔线
2. 每一格里放**一样**东西，画大、居中，格与格之间不要重叠
3. 不要给格子写标题、不要编号 —— 一个字都不要
4. 描述里点明总共几格、每格分别是什么`,
  },

  backdrop: {
    cn: '环创背景',
    hint: '贴墙做主题墙，中间留白',
    // 通景，横得越开越像一面墙
    width: LONG,
    height: 1152,
    style:
      'A wide decorative classroom wall backdrop for a kindergarten theme wall. ' +
      'Flat vector illustration, simple geometric shapes, soft yellow / mint green / sky blue palette, ' +
      'cream background. Decoration concentrated along the top, bottom and side edges, ' +
      'with a large clear empty area in the middle.',
    rules: `1. 这是一面**主题墙的背景**，装饰集中在四周边缘
2. **中间必须留出一大片空白** —— 老师要往那儿贴孩子的作品，画满了就没法用了
3. 图案要简单、可重复，远看得清楚（这东西贴在墙上，是从三米外看的）
4. 不画人、不画孩子
5. 描述里要出现 "large empty space in the center for children's artwork"`,
  },
};

export const DEFAULT_PURPOSE = 'material';

/** 不认识的值一律当材料图，不报错 —— 老师那边没有"用途填错了"这种事 */
export function resolvePurpose(value) {
  const key = String(value || '').trim();
  return PURPOSES[key] ? key : DEFAULT_PURPOSE;
}

export function purposeSpec(value) {
  return PURPOSES[resolvePurpose(value)];
}

/**
 * 拼出这个用途专用的系统提示词。
 *
 * 风格前缀要求「一字不改」是有理由的：实测这段能稳定压住写实照片风格，
 * 而单靠「不要画成照片」压不住。风格对了就算画歪也只是卡通歪，风格错了会出照片质感 ——
 * 那才是真问题。
 */
export function buildPurposeSystem(value) {
  const p = purposeSpec(value);
  return `请为幼儿园STEAM教案生成一个图片描述提示词，用于AI图像生成。
这张图**老师会打印出来在活动中使用**，用途是「${p.cn}」（${p.hint}）。

**提示词必须以这段风格前缀开头，一字不改**：
"Flat vector illustration in a warm children's picture-book style, simple geometric shapes, no photorealism, no photographic rendering, no 3D. ${p.style}${NO_TEXT}"

然后接一到两句英文描述，要求：
${p.rules}

以下几条对所有用途都成立，不许违反：
- **画面里一个文字、一个字母、一个数字都不许出现**。模型写出来的中文必然是乱码，
  印出来是废纸。要标注含义就用简笔图标
- **不画人、不画手、不画儿童或教师的面孔**${
    value === 'headwear' ? '（头饰中间的动物或角色图案不算，那是图形不是人像）' : ''
  }
- 不要品牌标识、不要写实照片质感
- 描述控制在 1-2 句

只输出「风格前缀 + 描述」这一整段英文，不要任何解释、不要引号。`;
}
