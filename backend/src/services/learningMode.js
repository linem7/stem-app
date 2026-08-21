/**
 * 学习模式 —— 沿途解释「为什么」。
 *
 * 效率模式帮她**这一次**省时间；学习模式让她**下一次**少依赖我们。
 * 后者是这个研究项目更接近目的的那一半。
 *
 * 【硬约束：不许分叉出第二条链路】
 * 出题、生成、改稿、配图全部走同一套代码。学习模式只是多带一些解释字段。
 * 分叉的代价很具体：两条实现里总有一条是没人测的，而且慢慢会长得不一样 ——
 * 到那时「学习模式的教案质量是不是更差」这个问题就没法回答了。
 */

export const MODES = ['efficient', 'learning'];

/**
 * 不认识的值一律当效率模式 —— 老师那边不该出现「模式填错了」这种事。
 *
 * **先判类型再 trim**：只写 `String(raw).trim()` 的话 `['learning']` 会通过，
 * 因为 `String(['learning'])` 正好等于 `'learning'`（回归脚本第 3 节抓到的）。
 * 这不是安全边界，但一个声称「只认这两个字符串」的函数就该真的只认。
 */
export function resolveMode(raw) {
  if (typeof raw !== 'string') return 'efficient';
  const v = raw.trim();
  return MODES.includes(v) ? v : 'efficient';
}

export const isLearning = (mode) => resolveMode(mode) === 'learning';

/**
 * 四道引导题各一句「为什么问这个」。
 *
 * 【为什么写死，不调模型】
 *
 * 这四道题是固定的（`guideFlow.js` 的 QUESTION_PLAN），而它们的**教学道理
 * 不随主题变化** —— 「年龄班决定一切深浅」这句话对浮沉和对搭高塔是同一句。
 * 让模型每次现写，得到的是同一个意思的不同措辞：花钱、变慢、质量还会飘。
 *
 * 更要紧的是，这几句是她真正要带走的东西。**要带走的东西必须是稳定的**：
 * 她第三次用的时候应该认出「哦又是这四件事」，那才叫学会了；
 * 每次读到一段新写的漂亮话，学到的只是「AI 很会说」。
 *
 * 【怎么写】
 * 每条都要能回答「我下次自己写教案时，在这一步该想什么」。
 * 所以：先说这一步决定了什么，再给一个具体的对比。
 * 光说「年龄班很重要」没有用 —— 那是她已经知道的。
 */
const WHY_BY_KEY = {
  age_group: {
    why: '写教案第一步永远是先定年龄班，定错了后面全错。',
    detail:
      '同一个浮与沉：小班是「玩，玩出感觉」，中班开始「猜一猜再试」，' +
      '大班才做得到「找原因、记下来」。时长、环节数、能不能读刻度、要不要分组，' +
      '全都跟着这一个答案走。',
  },
  focus: {
    why: '一次活动只能有一个重点，多了等于没有。',
    detail:
      '想让孩子玩个痛快，和想让他弄懂「为什么木头浮」，是两套材料、两套提问。' +
      '两个都想要，40 分钟里两个都做不深。先想清楚这次要哪一个。',
  },
  venue: {
    why: '场地不是背景，它决定活动能做成什么形态。',
    detail:
      '户外空地能搭大的、能跑、能洒水；教室区角只能做桌面的，还得控制同时几个人。' +
      '很多教案写得漂亮但上不了，就是因为写的时候没把场地算进去。',
  },
  constraints: {
    why: '人数、材料、有几个老师 —— 这三件事决定分组方式。',
    detail:
      '而分组方式决定这个活动做不做得下来：32 个孩子一个老师，' +
      '「四人一组自主探索」是句空话。先说出限制，比事后发现做不了省事。',
  },
};

/**
 * 给引导题挂上「为什么问这个」。
 *
 * 效率模式原样返回 —— **不是返回了但前端不显示**，是根本不下发：
 * 那几段文字对效率模式的老师是纯噪音，而响应体每多一份都要过一次微信的传输。
 *
 * @param {Array} questions  buildAllQuestions 的产出
 * @param {string} mode
 */
export function attachWhy(questions, mode) {
  if (!isLearning(mode)) return questions;
  return questions.map((q) => {
    const w = WHY_BY_KEY[q.key];
    return w ? { ...q, why: w.why, why_detail: w.detail } : q;
  });
}

/**
 * 学习模式的开场话。
 *
 * 只在引导页顶上出现一次，代替效率模式那句「就问这 4 个，其余的我来定」。
 * 一句话，不铺开 —— 铺开就变成了她进来第一眼要读的一段说明书。
 */
export const LEARNING_LEAD =
  '这 4 个问题也是你自己写教案时要先想清楚的 4 件事。每题下面写了为什么。';

/* ===================================================================
   教案解读（content_json.commentary）—— api-spec 第 5 节
   =================================================================== */

/**
 * 可以挂解读的板块，**这是白名单**：模型返回别的键一律丢掉。
 *
 * 为什么要白名单：解读是模型自由写的一段 JSON，而它会被存进 content_json、
 * 跟着版本走、由前端逐键渲染。放任它长出新键，等于让模型决定界面上出现什么。
 *
 * 为什么只有这 9 个：解读讲的是**设计决定**，所以挂在「有得选、选了这个没选那个」
 * 的板块上。`indicators`（《指南》指标）和 `dialogue`（师生对话）不在里面 ——
 * 前者是照着文件对号，后者是实例，两样都不是决定。
 */
export const COMMENTARY_KEYS = [
  'intent',
  'objectives',
  'key_points',
  'preparation',
  'flow',
  'flow_stages',
  'extension',
  'safety',
  'steam',
];

/** 每条解读的字数上限。超了截断而不是丢掉 —— 半段有用的话比没有好 */
const COMMENTARY_MAX = 200;

/**
 * 解读那一次调用的用户提示词。
 *
 * 【为什么这段话写得这么防御】
 *
 * 解读最可能的失败**不是写不出来，是写出套话**：
 * 「这样设计符合幼儿的年龄特点」「体现了以幼儿为主体的理念」——
 * 语法正确、听着专业、信息量为零。而老师一眼就认得出这种话，
 * 认出来之后她对整个学习模式的信任就没了（比不做更糟）。
 *
 * 所以三条硬要求写进提示词，每条都对着一种具体的废话：
 *   1. 必须给对比（「为什么不是另一种做法」）—— 对着「符合年龄特点」那种空话
 *   2. 不许复述教案里已经写着的内容 —— 对着「本环节让幼儿观察沉浮现象」这种改写
 *   3. 答不上来就不写这一条 —— 对着为了填满九个键而硬凑
 *
 * 第 3 条是最要紧的一条，也是最容易在后续改动里被删掉的一条：
 * 「宁可缺一条，不要凑一条」跟 STEAM 五域那条「宁可诚实标注缺席，不要虚假齐全」
 * 是同一个判断。
 */
export function buildCommentaryUserPrompt(contentJson, ageGroup) {
  const stageCount = Array.isArray(contentJson?.flow) ? contentJson.flow.length : 0;

  return `下面是你刚写好的这份【${ageGroup}】教案。

${JSON.stringify(contentJson)}

现在换一个身份：你在带一位想学会自己写教案的幼儿园老师。
请逐个板块告诉她**你为什么这么设计**——不是这一段写了什么，而是你当时在权衡什么。

三条硬要求：

1. **每条都要有一个具体的对比**：你选了这个做法，那个更常见的做法是什么，为什么不选它。
   只说「这样符合${ageGroup}幼儿的年龄特点」是废话，她已经知道要符合年龄特点，
   她不知道的是「具体到这一步，符合和不符合差在哪儿」。
2. **不许复述教案正文**。她看得到教案，把「本环节让幼儿观察沉浮现象」换个说法再讲一遍，
   对她一点用都没有。
3. **答不上来的板块就不要写那个键**。九个键缺几个完全没关系；
   凑一句空话进去，会让她连真有价值的那几条一起不信。

只输出 JSON，键从下面这些里选，每个键的值是一段 60-${COMMENTARY_MAX} 字的中文：

{
  "intent":      "为什么从这个切入点开始，而不是直接讲道理或直接发材料",
  "objectives":  "为什么是这三条目标；为什么不再加一条（或为什么某个显而易见的目标故意没写）",
  "key_points":  "为什么难点是这个，而不是看起来更难的那件事",
  "preparation":  "为什么是这些材料；哪样材料是特意换掉的，换掉的那个会出什么问题",
  "flow":        "为什么是这个顺序；为什么不先讲规则再动手（或反过来）",
  "flow_stages": ["按顺序，第 1 个环节为什么这么安排", "第 2 个……", "一共 ${stageCount} 个环节，可以只写前几个"],
  "extension":   "为什么延伸是这么放的（区角／回家／下一次活动），别的放法会怎样",
  "safety":      "这几条为什么是【${ageGroup}】的必查项，换个年龄班会不一样吗",
  "steam":       "这次哪个领域重、哪个刻意不做，为什么不凑齐五个"
}`;
}

/**
 * 收敛模型给的解读。
 *
 * 白名单过滤 + 截断 + `flow_stages` 对齐 `flow` 的长度。
 *
 * ⚠️ **返回 null 而不是 `{}`**（空对象也返回 null）。
 * 契约是「效率模式下这个键根本不存在」，而前端判断「有没有解读」只看一个条件：
 * `content_json.commentary` 有没有内容。存一个空对象进去，
 * 前端就得多写一条「有键但是空的」分支 —— 那种分支永远有一半没人测。
 *
 * @param {object} raw       模型返回的 JSON
 * @param {number} flowLen   flow 有几个环节，用来裁 flow_stages
 */
export function normalizeCommentary(raw, flowLen = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  /*
    超长要**切在句末**，不是切在第 200 个字上。

    这条是 buildImagePrompt 那个坑的同一课（见 lessonGenerator.js 里那段注释）：
    半句话对读者只是噪音。而解读比提示词更要紧 —— 它是直接给老师看的，
    一段停在「因为中班幼儿还难以」的解释，比没有这段解释更糟：
    她会觉得这个功能是坏的。

    切不到句号（整段一句话都没断过）才硬切，那时至少不留一个悬着的半句标点。
  */
  const clean = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) return '';
    if (s.length <= COMMENTARY_MAX) return s;

    const cut = s.slice(0, COMMENTARY_MAX);
    // 从后往前找最后一个句末标点。太靠前就不用它 ——
    // 只留 30 字的一句话等于把整段解读丢了
    const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
    return stop > COMMENTARY_MAX * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/[，、；：…\-—\s]+$/, '');
  };

  const out = {};
  for (const key of COMMENTARY_KEYS) {
    if (key === 'flow_stages') {
      // 下标要对得上 flow —— 前端是按下标取的，多出来的几条会挂到不存在的环节上
      const list = (Array.isArray(raw.flow_stages) ? raw.flow_stages : []).slice(0, flowLen).map(clean);
      // 末尾的空串截掉，中间的留着（保持下标对齐）
      while (list.length && !list[list.length - 1]) list.pop();
      if (list.length) out.flow_stages = list;
      continue;
    }
    const v = clean(raw[key]);
    if (v) out[key] = v;
  }

  return Object.keys(out).length ? out : null;
}
