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

/**
 * 风格前缀分两种，**这是这个文件最要紧的一条**。
 *
 * 原来五个用途共用一句「Flat vector illustration in a warm children's picture-book style」，
 * 记录表和头饰也顶着它。这是自己把「要印出来用的东西」往插画那边推 ——
 * 而且它是提示词的第一句，权重最高，后面写多少「pure white / thick black gridlines」都掰不回来。
 *
 * 实测（2026-08-17，同一句中文描述、同一个模型）：
 *   带插画前缀的记录表 → 顶上一行手写体乱码（B'se kllgo / Cvre eck hls...）、
 *     7 列 2 行（要的是 3×4）、细黄线（要的是粗黑线），外加一只猫头鹰和一只摇摇马
 *   换成 PRINT 前缀 → 干净的 3×4 空格子、粗黑线、纯白底、一个字都没有
 *
 * 所以：画给人看的（材料图/展示图/环创背景）走 ILLUSTRATION，
 * 印出来当东西用的（记录表/头饰）走 PRINT。别再合并回一句。
 */
const ILLUSTRATION_PREFIX =
  "Flat vector illustration in a warm children's picture-book style, simple geometric shapes, " +
  'no photorealism, no photographic rendering, no 3D.';

/*
  这段要**短**。它和 style、NO_TEXT 一起是强制前缀，三段加起来必须给老师那句描述
  留出余量 —— 超过 buildImagePrompt 的上限，被切掉的正是描述（详见那里的注释）。
  scripts/versions-test.mjs 里有一条长度断言盯着这件事，别把它写长了。
*/
const PRINT_PREFIX =
  'Black and white line drawing on pure white paper, thick solid black outlines, ' +
  'no colour, no shading, no texture. Plain and utilitarian, like a blank photocopied handout. ' +
  'No cartoon mascots, no decorative border, no background scenery.';

export const PURPOSES = {
  material: {
    cn: '材料图',
    hint: '单样材料，照着去准备',
    kind: 'illustration',
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
    kind: 'print',
    // 竖版对着 A4。白底不是奶油底 —— 打印省墨，孩子写上去也清楚
    width: 1536,
    height: LONG,
    // 文档类图必须关掉 MiniMax 的提示词润色：它会把「练习纸」的套路补齐 ——
    // 标题栏、出版社水印、页脚花边，而这些恰恰是我们写死不许有的
    optimize: false,
    style:
      'An empty printable chart: one plain table, 3 columns and 4 rows, thick straight black lines, ' +
      'every cell completely empty white space for children to draw in. Large cells, portrait orientation. ' +
      'A row of small black pictograms sits directly above the table, one per column.',
    rules: `1. 这是一张**空白的、给孩子写画的表**，不是填好的示意图
2. **格子里必须是空的**，留出写字画画的地方；线要粗、格子要大（3-4 岁握笔不稳）
3. 每一列的含义用**简笔图标**表示。图标画在表格**正上方**、每列一个、跟那一列对齐
   —— 原来要求「画在第一行格子里面」，实测模型做不到，它一律飘到表格外面去；
   与其要一个它给不了的位置，不如要一个它稳定给得到、老师也对得上的位置。绝对不要写字
4. 结构简单：3 列 × 4 行，再多小班孩子对不上格
5. 描述里要出现 "every cell completely empty for children to draw in"`,
  },

  headwear: {
    cn: '头饰',
    hint: '打印剪下来戴头上',
    kind: 'print',
    // 横版。两条长带要够长，宽高比越扁越好用
    width: LONG,
    height: 1024,
    optimize: false,
    // 走 PRINT 前缀 = 黑白线稿。三个理由：园里彩打贵、沿线剪要线清楚、
    // 空心图案孩子能自己涂色（多一个活动环节）。要改回彩色版就把 kind 换成 illustration
    style:
      'A cut-out headband template, laid flat, viewed straight on: one outlined shape in the center, ' +
      'with two long horizontal strips running from it all the way off the left and right edges of the image, ' +
      'to wrap around a head. Outlines only, hollow for children to colour in.',
    rules: `1. 画的是**摊平的头饰纸样**，不是戴在头上的样子 —— 老师要照着剪
2. 中间是主体图案（动物、植物、角色的正面简笔轮廓），**左右各接一条水平长带**，
   两条带子必须一直画到画面最左边和最右边、被画面切断，那是绕头一圈用的 ——
   带子没顶到边，印出来就短一截，围不上小孩的头
3. 轮廓线要粗、要闭合，方便沿线剪；图案是空心的，留给孩子涂色
4. 带子上可以有简单重复花纹，但不要复杂到剪不动
5. 描述里要出现 "flat cut-out template with two long horizontal side strips"`,
  },

  display: {
    cn: '展示图',
    hint: '一格一样，贴展示板上介绍',
    kind: 'illustration',
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
    kind: 'illustration',
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

/**
 * 她这句话里说了几样东西。
 *
 * 起因是实测：老师写「我需要准备小狗、小猫和兔子的头饰」，出来的图**只有小狗** ——
 * 头饰的构图规则里写死了 "one outlined shape in the center"，
 * 于是 DeepSeek 只能从三个里挑一个，另外两样被悄悄丢掉。
 * 图片标签上还写着完整那句话，她不一定看得出来少了两样，而配额已经扣掉一张。
 *
 * 数出来是为了：一张纸上排几条。**不是**拆成几张 ——
 * 一份教案总共才 3 张配额，一句话就把配额吃光是另一种糟糕。
 *
 * 顿号、逗号、和、跟、与、以及、还有，都算分隔。多算一样最多是纸上多排一条空的，
 * 少算一样才是真丢东西，所以这里宁可多算。
 */
export function countSubjects(note) {
  const s = String(note || '').trim();
  if (!s) return 1;
  const parts = s
    .split(/[、,，;；]|和|跟|与|以及|还有/)
    .map((x) => x.trim())
    .filter(Boolean);
  // 上限 4：再多每条就窄到剪不动了，A4 上一条不到 5 厘米高
  return Math.min(Math.max(parts.length, 1), 4);
}

/**
 * @param {string} value 用途
 * @param {number} [count] 这张纸上要排几样（只有头饰用得上，见 countSubjects）
 */
export function purposeSpec(value, count = 1) {
  const spec = PURPOSES[resolvePurpose(value)];
  const n = Math.min(Math.max(Number(count) || 1, 1), 4);
  if (resolvePurpose(value) !== 'headwear' || n < 2) return spec;

  // 排几条就要多高的纸。一条是 2:1 的横条，三条就得接近方的，
  // 否则每条被压扁到剪不动。宽度不动 —— 带子要横着通到边
  const height = { 2: 1280, 3: 1536, 4: LONG }[n];
  return {
    ...spec,
    height,
    style:
      `A printable sheet of ${n} separate cut-out headband templates, stacked one above another, ` +
      'evenly spaced with a clear white gap between them for cutting. Each template has one outlined ' +
      'shape in the center and two long horizontal strips running from it all the way off the left and ' +
      'right edges of the image. Outlines only, hollow for children to colour in.',
    rules: `1. 这是**一张纸上排 ${n} 条**头饰纸样，上下排开，条与条之间留出白边好下剪刀
2. 老师说了几样就画几样，**一样都不能少**（她说的每一样各占一条）
3. 每一条都是：中间一个主体图案（那样动物/角色的正面简笔轮廓），左右各接一条水平长带，
   带子必须一直画到画面最左边和最右边、被画面切断 —— 没顶到边印出来就围不上小孩的头
4. 轮廓线要粗、要闭合，方便沿线剪；图案空心，留给孩子涂色
5. 描述里要逐条点明每一条画的是什么，并出现 "stacked cut-out headband templates"`,
  };
}

/** 这个用途要的是「印出来当东西用」还是「画出来给人看」 */
export function isPrintKind(value) {
  return purposeSpec(value).kind === 'print';
}

/**
 * 拼出这个用途专用的系统提示词。
 *
 * 风格前缀要求「一字不改」是有理由的：实测这段能稳定压住写实照片风格，
 * 而单靠「不要画成照片」压不住。风格对了就算画歪也只是卡通歪，风格错了会出照片质感 ——
 * 那才是真问题。
 *
 * 前缀分插画/线稿两种，选哪一种由 kind 决定，理由见文件头上 PRINT_PREFIX 那段。
 */
export function buildPurposeSystem(value, count = 1) {
  const p = purposeSpec(value, count);
  const prefix = p.kind === 'print' ? PRINT_PREFIX : ILLUSTRATION_PREFIX;
  const useLine =
    p.kind === 'print'
      ? '这张图**是要印出来直接给孩子用的东西**（表格、纸样），不是一张插画。'
      : '这张图是**画给人看的**（照着准备材料、贴出来展示），老师会印出来用。';
  return `请为幼儿园STEAM教案生成一个图片描述提示词，用于AI图像生成。
用途是「${p.cn}」（${p.hint}）。${useLine}

**提示词必须以这段风格前缀开头，一字不改**：
"${prefix} ${p.style}${NO_TEXT}"

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
