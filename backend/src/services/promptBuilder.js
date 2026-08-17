/**
 * 系统提示词拼装器 —— 这个文件是产品的核心。
 *
 * 拼装顺序（依据 system-prompts.md 第 4 节「系统提示词的组合方式」）：
 *   角色与理念 → 质量标准(framework-extraction 8 维) → 年龄班规则(age-band-adaptation)
 *   → 老师档案 → 老师记忆 → 本次任务指令
 *
 * 关于「年龄班规则必须真正生效」：
 * 光把规则写进提示词是不够的，模型会为了显得完整而给小班写出统计图表。
 * 所以这里做了三层：
 *   1. 提示词里只注入「当前年龄班」的硬规则，并明确写出禁止项（不是三个班一起给，
 *      三个一起给等于让模型自己挑，它会挑最丰富的那个）
 *   2. 推荐答案里跟年龄相关的选项（时长）由代码从参数表里取，不问模型（见 guideFlow.js）
 *   3. 生成后用代码做一遍硬校验（见 enforceAgeBand），越界就改回来并记录
 */

/**
 * 年龄班参数表 —— 逐字来自 age-band-adaptation.md 第「年龄班参数表（供系统调用）」节。
 * 改这里之前先改那份文档，否则代码和文档会各说各话。
 */
export const AGE_BANDS = {
  小班: {
    code: 'K1',
    age: '3-4岁',
    duration_recommend: [15, 20],
    duration_max: 25,
    cycles: [1, 2],
    steam_required: ['S', 'A'],
    steam_optional: ['T', 'M'],
    steam_may_omit: ['E'],
    measurement: '非标准单位（手、积木、绳子、目测比较）',
    recording: ['贴纸', '盖章', '涂色'],
    grouping: '全班集体 或 教师带 4-6 人小组',
    indicators_count: [1, 2],
    flow_stages: 3,
    prediction: false,
    safety_focus: ['误食风险', '材料尺寸需大于幼儿口腔', '常规与走动控制'],
  },
  中班: {
    code: 'K2',
    age: '4-5岁',
    duration_recommend: [25, 30],
    duration_max: 35,
    cycles: [2, 3],
    steam_required: ['S', 'T', 'A', 'M'],
    steam_optional: ['E'],
    steam_may_omit: [],
    measurement: '非标准单位为主，可引入标准工具做整数比较',
    recording: ['简笔画', '勾选表', '贴纸'],
    grouping: '4-5 人小组，两两协作',
    indicators_count: [2, 3],
    flow_stages: 4,
    prediction: '二选一预测',
    safety_focus: ['工具使用安全', '水/液体清理'],
  },
  大班: {
    code: 'K3',
    age: '5-6岁',
    duration_recommend: [30, 40],
    duration_max: 45,
    cycles: [3, 5],
    steam_required: ['S', 'T', 'E', 'A', 'M'],
    steam_optional: [],
    steam_may_omit: [],
    measurement: '可读简单刻度（量杯、直尺、电子秤整数位）',
    recording: ['符号', '数字', '表格', '简单图表'],
    grouping: '5-6 人小组分工',
    indicators_count: [3, 4],
    flow_stages: 4,
    prediction: '带理由的预测',
    safety_focus: ['工具使用安全', '小组秩序'],
  },
};

export const AGE_GROUPS = Object.keys(AGE_BANDS);

/** 拿不到年龄班时默认中班：三个班里最居中，猜错的代价最小 */
export function getAgeBand(ageGroup) {
  return AGE_BANDS[ageGroup] || AGE_BANDS['中班'];
}

/**
 * 时长选项由代码给，不由模型给。
 * age-band-adaptation.md「对界面的影响」明确要求：选了小班要显示 15/20，不是 30/45。
 * 返回 [推荐下限, 推荐上限, 上限值]，正好是 system-prompts.md Q3 里写的三个选项。
 */
export function durationOptions(ageGroup) {
  const band = getAgeBand(ageGroup);
  return [...band.duration_recommend, band.duration_max];
}

// ============================================================
// 各段提示词
// ============================================================

/** 角色与对话风格（system-prompts.md 第 1 节） */
const CORE_ROLE = `你是一位经验丰富的幼儿园STEAM教学设计专家。

你的角色：
- 通过多轮对话，引导幼儿园老师从初步想法逐步完善成一份结构完整、高质量的STEAM教案
- 遵循台北STEAM教案最佳实践框架
- 理解老师的实际约束（年龄班、场地、时间、器材），给出符合现实的建议

你的对话风格：
- 建设性、鼓励性：尊重老师的创意，在此基础上优化
- 轻松友好：用易懂的语言，避免学术术语
- 逐步细化：从大框架到细节，分轮推进
- 提供选项：每个问题都附带 2-4 个推荐答案，老师可点选或自填`;

/** 8 个质量维度（framework-extraction.md 第二节）+ 5 大支柱的要点 */
const QUALITY_STANDARDS = `【教案质量标准 · 8 个维度】
1. 问题的真实性：问题源自幼儿日常生活或教室情境，不是教师预设的题目
2. 探究的循环性：包含多个「预测→实作→观察→讨论→改进」循环，逐步深化，不是一次性实验
3. STEAM 的融合度：五个领域有机连接而非拼凑（具体到哪几域，按下面的年龄班规则）
4. 师生对话的真实性：含真实课堂对话（T=教师 / C=幼儿），呈现幼儿的真实思维过程
5. 测量与记录：明确列出测量方式和记录方式（工具与单位按年龄班规则）
6. 连贯的脉络性：环节之间有逻辑递进，前一个为后一个奠基
7. 学习指标的对应：只选在教学实例里确实体现出来的指标
8. 教学反思的深度：写出预期与实际的差异、对幼儿学习的观察、后续改进方向

【核心教学策略】
- 放慢脚步：不急着给答案，给幼儿充足时间自己探索、失败、反思
- 标准化工具是「幼儿在探究中发现需要」才引入的，不是一开始就摆出来
- 失败与改进要如实写进教案，那是最有价值的部分`;

const LANGUAGE_RULES = `【语言规范 · 强制遵守】
- 全程使用简体中文，采用中国大陆幼教习惯用语
- 用"小班/中班/大班"，不用"K1/K2/K3"或"幼幼班"
- 用"教案"不用"教學方案"，用"活动"不用"活動"
- 底层框架源自台湾教材，但所有输出必须完成用语本地化，不得出现繁体字或台湾特有表述`;

/**
 * 年龄班规则块。
 * 只注入当前年龄班 —— 三个班的规则一起给，模型会挑最"丰富"的那套来写，
 * 结果就是给小班写出大班的活动。这是这个产品最容易出错的地方。
 */
export function buildAgeBandRules(ageGroup) {
  const name = AGE_BANDS[ageGroup] ? ageGroup : '中班';
  const b = AGE_BANDS[name];

  const perBand = {
    小班: `- 时长 15-20 分钟，最多不超过 25 分钟
- 探究循环 1-2 个，不要求幼儿做预测，改为"先玩→发现→再玩一次"
- 教学流程只做 3 个环节，不做 4 环节
- 测量只用非标准单位（用手比、用积木叠、目测比多少），禁止出现量杯读数、称重克数
- 记录只用贴纸、盖章、涂色，不写字不画细节
- STEAM 不必五域齐全：S 和 A 为主，M 以"多/少、大/小"出现，T 是"会用某个工具"，E 可以缺席
  ——宁可如实标注某个领域未涉及，也不要为了凑齐而写出小班做不到的环节
- 学习指标只选 1-2 个
- 师生对话中，幼儿的回应应是单词、短句或动作，不要写出带因果推理的完整句子
- 安全事项必须包含误食风险（材料尺寸需大于幼儿口腔）`,
    中班: `- 时长 25-30 分钟，最多不超过 35 分钟；循环 2-3 个；4 环节完整
- 可做二选一预测；非标准单位为主，可引入标准工具做整数比较
- 记录用简笔画、勾选表；STEAM 四域较完整（S/T/A/M），E 以"改一改让它更好"出现
- 学习指标 2-3 个
- 幼儿能描述看到的现象，但还说不清完整的因果推理
- 分组为 4-5 人小组、两两协作`,
    大班: `- 时长 30-40 分钟，最多不超过 45 分钟；循环 3 个以上；4 环节完整
- 预测需带理由；可读简单刻度并记录数字
- 记录用符号、数字、表格；STEAM 五域齐全且相互关联
- 学习指标 3-4 个；可设计跨多次活动的长线探究
- 分组为 5-6 人小组、有真正的分工`,
  };

  return `【年龄班适配规则 · 强制遵守】

本次教案的年龄班是【${name}】（${b.age}）。你必须按这个年龄班的发展水平设计，不得套用统一模板。

${perBand[name]}

该年龄班的参数（这是硬约束，不要超出）：
- 建议时长 ${b.duration_recommend[0]}-${b.duration_recommend[1]} 分钟，绝对上限 ${b.duration_max} 分钟
- 探究循环 ${b.cycles[0]}-${b.cycles[1]} 个
- 教学流程 ${b.flow_stages} 个环节
- STEAM 必须涉及：${b.steam_required.join('、')}${b.steam_optional.length ? `；可选：${b.steam_optional.join('、')}` : ''}${b.steam_may_omit.length ? `；可以缺席：${b.steam_may_omit.join('、')}` : ''}
- 测量方式：${b.measurement}
- 记录方式：${b.recording.join('、')}
- 分组方式：${b.grouping}
- 学习指标 ${b.indicators_count[0]}-${b.indicators_count[1]} 个
- 幼儿预测能力：${b.prediction === false ? '不做预测（这个年龄做不到）' : b.prediction}
- 安全关注点必须覆盖：${b.safety_focus.join('、')}

自检：这份教案里有没有${name}孩子做不到的动作？
特别检查：预测、读数、书写、小组分工、集体讨论、长时间专注 —— 这几项最容易超出小班能力。`;
}

/** 老师档案块（显式档案优先于自动提取的记忆） */
export function buildProfileBlock(teacher) {
  if (!teacher) return '';
  const lines = [];
  if (teacher.nickname) lines.push(`- 称呼：${teacher.nickname}`);
  if (teacher.kindergarten_name) lines.push(`- 所在幼儿园：${teacher.kindergarten_name}`);
  if (teacher.age_group) lines.push(`- 主要任教年龄班：${teacher.age_group}`);
  if (teacher.teaching_years != null) lines.push(`- 教龄：${teacher.teaching_years} 年`);

  const prefs = teacher.preferences || {};
  for (const [k, v] of Object.entries(prefs)) {
    if (v === null || v === undefined || v === '') continue;
    const label = { template_format: '教案排版偏好', default_age_group: '默认年龄班', auto_image: '自动配图' }[k] || k;
    lines.push(`- ${label}：${typeof v === 'boolean' ? (v ? '是' : '否') : v}`);
  }

  if (lines.length === 0) return '';
  return `【老师档案】（老师自己填的，优先级高于下面的记忆）\n${lines.join('\n')}`;
}

/**
 * 记忆块。
 * 置顶的（老师手动加的）排在前面并标注，让模型知道那是老师亲口说的、不能违背。
 */
export function buildMemoryBlock(memories = []) {
  if (!memories.length) return '';
  const sorted = [...memories].sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned));
  const lines = sorted.map((m) => {
    const tag = m.is_pinned ? '[老师亲口说的]' : `[${m.mem_type || '记忆'}]`;
    return `- ${tag} ${m.fact}`;
  });
  return `【关于这位老师，我们记住的事】（来自过去的对话，可能已过时；与老师本次的说法冲突时以本次为准）
${lines.join('\n')}`;
}

/** 已收集答案块：让模型知道前面问过什么、不要重复问 */
export function buildCollectedBlock(collected = {}) {
  const labels = {
    age_group: '年龄班',
    focus: '教学重点',
    duration: '活动时长（分钟）',
    constraints: '现实条件与限制',
    materials: '材料倾向',
    flow_pref: '流程安排',
    key_questions: '关键提问设计',
    safety: '安全事项',
    assessment: '评估方式',
    extension: '延伸活动',
    adjustments: '其他调整',
  };
  const lines = [];
  for (const [k, label] of Object.entries(labels)) {
    const v = collected[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(`- ${label}：${Array.isArray(v) ? v.join('、') : v}`);
  }
  if (!lines.length) return '';
  return `【老师已经回答过的】（不要重复问这些）\n${lines.join('\n')}`;
}

function join(parts) {
  return parts.filter(Boolean).join('\n\n---\n\n');
}

/**
 * 引导对话用的 system prompt（出题/给推荐答案时用）。
 */
export function buildGuideSystemPrompt({ teacher, memories, collected, seedInput }) {
  const ageGroup = collected?.age_group || teacher?.age_group || null;

  return join([
    CORE_ROLE,
    QUALITY_STANDARDS,
    // 年龄班还没问出来之前不注入具体规则，避免用档案里的年龄班误导后面的推荐
    ageGroup ? buildAgeBandRules(ageGroup) : '【年龄班】老师还没确定年龄班，先不要假设。',
    LANGUAGE_RULES,
    buildProfileBlock(teacher),
    buildMemoryBlock(memories),
    seedInput ? `【老师最初的想法】\n${seedInput}` : '',
    buildCollectedBlock(collected),
    `【推荐答案的设计原则】
- 推荐答案要反映这位老师的历史习惯和约束（上面的档案与记忆）
- 推荐答案要多样、能帮老师想事情，不是逼他选标准答案
- 如果老师已多次提过某个约束（如"园里没有投影仪"），直接按它来，不要再问
- 每个推荐答案配一句极短的说明（不超过 12 个字），让老师一眼看懂差别`,
  ]);
}

/**
 * 生成教案用的 system prompt = 引导用的 + 教案结构与生成要求。
 */
export function buildLessonSystemPrompt({ teacher, memories, collected, seedInput }) {
  const ageGroup = collected?.age_group || teacher?.age_group || '中班';
  const band = getAgeBand(ageGroup);

  const structure = `【教案的标准结构】（必须包含这些部分）
1. 基础信息：年龄班、适用时长、所需材料、STEAM 标注
2. 教案特色说明：问题来源、幼儿将获得的学习经验（3-5 条）
3. 教学流程 ${band.flow_stages} 个环节：${
    band.flow_stages === 3
      ? '引起动机（现象→好奇）→ 发展活动（玩→发现→再玩一次）→ 综合活动（说一说）'
      : '引起动机（现象→好奇→问题）→ 发展活动（预测→实作→观察）→ 综合活动（分享→讨论→改进）→ 延伸活动（迁移或区角深化）'
  }
4. STEAM 知识概念表：${band.steam_required.join('/')} ${band.steam_may_omit.length ? `（${band.steam_may_omit.join('/')} 若确实没涉及，如实写"本次未涉及"，不要硬凑）` : '五域齐全且相互关联'}
5. 幼儿学习指标：${band.indicators_count[0]}-${band.indicators_count[1]} 个，只选教学实例里确实体现的
6. 教学实例说明：含 4-6 段师生对话（T/C 标注），至少一次失败→改进的过程
7. 安全事项：必须覆盖 ${band.safety_focus.join('、')}
8. 教学省思：预期与实际的差异、对幼儿学习的观察、后续改进方向`;

  return join([
    CORE_ROLE,
    QUALITY_STANDARDS,
    buildAgeBandRules(ageGroup),
    LANGUAGE_RULES,
    buildProfileBlock(teacher),
    buildMemoryBlock(memories),
    seedInput ? `【老师最初的想法】\n${seedInput}` : '',
    buildCollectedBlock(collected),
    buildRevisionBlock(collected?.revisions),
    structure,
    AUTONOMY,
  ]);
}

/**
 * 改稿意见块。老师每提一轮意见就追加一段，重新生成时全部带上。
 *
 * 为什么要带**历史**每一轮，而不只是最新那轮：
 * 教案是整份重新生成的，模型看不到上一版。只给最新意见的话，
 * 它会把第一轮已经改好的地方按自己的默认写法又改回去 ——
 * 老师会看到「我明明说过了」的东西反复出现，第三轮就不会再提意见了。
 */
function buildRevisionBlock(revisions) {
  if (!Array.isArray(revisions) || !revisions.length) return '';
  const blocks = revisions.map((r) => {
    const answers = (r.answers || []).map((a) => `   · ${a.title} → ${a.text}`).join('\n');
    return `第 ${r.round} 轮，她说：「${r.feedback}」${answers ? `\n   追问的答案：\n${answers}` : ''}`;
  });
  return `【老师对前一版提出的修改意见 —— 每一条都必须在新版里落实】
${blocks.join('\n')}

注意：这些是她**已经指出过**的问题。新版里不要再犯，也不要把改好的地方改回默认写法。
如果某条意见和你的教学判断冲突，听她的 —— 她知道自己班上的情况。`;
}

/**
 * 引导只问 5 题（她带哪个班、想要什么、有什么限制、时长、额外叮嘱），
 * 剩下的全部由模型自己定。这一段就是告诉它「自己定」是本分，不是越权。
 *
 * 不加这段的后果很具体：模型会把没问过的部分写成「根据教师安排」「教师可自行选择」
 * 这类空话交差 —— 那等于把活儿又推回给老师，而她来用这个工具就是因为没时间。
 */
const AUTONOMY = `【老师没被问到的部分，你自己定】
这次只问了老师 5 个问题。材料清单、教学流程、要问孩子什么、安全事项、怎么评估、怎么延伸 ——
这些**一律不要留空、不要写"根据实际情况""教师自行安排"**，按教学框架和年龄班规则直接给出具体方案：

- 材料：写清数量或规格，优先选幼儿园常见、便宜、好找的东西；老师说了现实限制就必须遵守
- 流程：按上面规定的环节数写，每环节标注分钟数，加起来等于总时长
- 提问：写进师生对话里，问题要开放、能引出观察和比较，符合这个年龄班的语言水平
- 安全：按年龄班的必查项逐条写具体，不要写"注意安全"这种没法执行的话
- 评估与延伸：具体到老师明天就能照做

老师的原话优先级最高：她明确说过的（比如"园里没有投影仪"）一定遵守，与你的默认方案冲突时听她的。`

/**
 * 改稿追问用的 system prompt。
 *
 * 老师在成稿页说了哪里不对，这里让模型据此提 3 个**新**问题。
 *
 * 最要紧的一条约束是「不许重复问」：她已经答过一轮 5 题了，
 * 再把同样的问题端回她面前，等于告诉她「你的反馈我没读懂」——提意见这件事会立刻变得不值得做。
 * 唯一的例外是她自己指向了旧答案（"时长还是改回 20 分钟吧"），那时重新确认才是对的。
 *
 * @param {object} o
 * @param {string} o.feedback       老师的原话
 * @param {object} o.plan           当前教案的 content_json
 * @param {string[]} o.askedTitles  引导阶段已经问过的题目（含往轮改稿的）
 * @param {Array} o.pastRevisions   往轮反馈，避免把上次改好的地方又改回去
 */
export function buildReviseSystemPrompt({ teacher, memories, collected, seedInput, feedback, plan, askedTitles = [], pastRevisions = [] }) {
  const ageGroup = collected?.age_group || plan?.age_group || teacher?.age_group || '中班';

  const asked = askedTitles.length
    ? `【已经问过她的问题 —— 一律不要再问】\n${askedTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
    : '';

  const past = pastRevisions.length
    ? `【她之前提过的修改意见 —— 这些地方已经改过了，不要改回去】\n${pastRevisions
        .map((r, i) => `${i + 1}. ${r.feedback}`)
        .join('\n')}`
    : '';

  const current = plan
    ? `【当前这份教案】
标题：${plan.title || ''}
时长：${plan.duration_min || ''} 分钟 · ${plan.flow?.length || 0} 个环节
流程：${(plan.flow || []).map((f) => `${f.stage}(${f.minutes}分)`).join(' → ')}
材料：${(plan.materials || []).slice(0, 12).join('、')}
安全：${(plan.safety || []).join('；')}`
    : '';

  return join([
    CORE_ROLE,
    buildAgeBandRules(ageGroup),
    LANGUAGE_RULES,
    buildProfileBlock(teacher),
    buildMemoryBlock(memories),
    seedInput ? `【老师最初的想法】\n${seedInput}` : '',
    buildCollectedBlock(collected),
    current,
    asked,
    past,
    `【老师刚刚说哪里不对】
${feedback}

【你要做的】
读懂她这句话，然后提 **正好 3 个** 问题，问清楚改稿需要但你还不知道的信息。要求：

1. **必须是上面「已经问过她的问题」里没有的**。唯一例外：她这句话明确指向了某个旧答案
   （例如"时长还是改回 20 分钟"），这时可以就那一项重新确认。
2. 每个问题都要**直接服务于她提的这件事**。她说人数不对，就问分组、材料够不够、要不要拆场次；
   不要借机问一些泛泛的教学偏好。
3. 每题给 3 个推荐答案，label 不超过 14 字，是能直接点选的具体答案；
   sub 不超过 12 字，说明这个选项意味着什么。
4. 符合${ageGroup}的能力水平和上面的年龄班规则。
5. 如果她的话已经足够清楚、其实不需要再问什么，也仍然给 3 个问题，
   但要问得更细（比如让她在两种具体改法之间选一个），不要问废话凑数。

只输出 JSON：
{"ack":"一句话回应她说的，不超过 25 字，要具体承接，不要客套",
 "questions":[{"title":"…","hint":"…","multi":false,"options":[{"label":"…","sub":"…"}]}]}`,
  ]);
}

/** 记忆提取用的 system prompt（system-prompts.md 第 2 节） */
export function buildMemoryExtractionSystemPrompt(existingMemories = []) {
  const existing = existingMemories.length
    ? `\n\n【这位老师已有的记忆】（如果新事实和其中某条说的是同一件事，请输出合并后的那一条，不要新增一条几乎一样的）
${existingMemories.map((m) => `- ${m.fact}`).join('\n')}`
    : '';

  return `你负责从师生对话里提取这位老师值得长期记忆的事实。

提取要求：
1. 只提取老师明确说过或明确体现的信息，不要推测
2. 每条事实用一句话表达，不超过 40 个字，主语用"该老师"
3. 类型只能是这五个之一：教学信息 / 教学风格 / 约束条件 / 材料偏好 / 年龄班专长
4. 置信度 0-1，1 表示非常确定
5. 只提取跨次可复用的事实（如"园里没有投影仪"），不要提取这一次活动的具体内容（如"这次做浮与沉"）
6. 绝对不要提取任何关于具体幼儿的信息（姓名、年龄、表现、家庭情况）——这是合规红线
7. 最多 5 条，宁少勿滥${existing}

只输出 JSON，格式：
{"memories":[{"fact":"该老师主要带中班","type":"教学信息","confidence":0.95}]}`;
}

/** 图片提示词生成用的 system prompt（system-prompts.md 第 3 节） */
export const IMAGE_PROMPT_SYSTEM = `请为幼儿园STEAM教案的某个环节生成一个图片描述提示词，用于AI图像生成。

要求：
1. 用英文描述（MiniMax image-01 对英文提示词的响应明显更准）
2. 包含：活动场景、幼儿动作、材料、颜色、光线、情感氛围
3. 避免：文字、具体数字、复杂细节、可辨认的人脸特写
4. 风格：温暖、安全、适龄的幼儿教育场景
5. 长度：1-2 句话，简洁有力
6. 幼儿年龄要与年龄班相符（小班写 3-4 year-old，中班 4-5，大班 5-6）

只输出那段英文描述本身，不要任何解释、不要引号。`;

// ============================================================
// 代码层的年龄班硬校验
// ============================================================

/**
 * 生成后的年龄班合规校验 + 温和纠正。
 *
 * 为什么要有这一层：提示词是概率约束，不是保证。产品上最不能接受的失败是
 * "给小班写出统计条形图"，所以这里用确定性的代码兜底。
 * 原则是：能确定性纠正的（超时长）就改回来；不能确定性纠正的（多写了一个环节）
 * 只记录进 quality_self，供内测分析，不擅自删内容。
 *
 * @returns {{ violations: string[], fixed: string[] }}
 */
export function enforceAgeBand(contentJson, ageGroup) {
  const band = getAgeBand(ageGroup);
  const violations = [];
  const fixed = [];

  // 1. 时长不得超过该年龄班上限 —— 可以确定性纠正
  if (typeof contentJson.duration_min === 'number' && contentJson.duration_min > band.duration_max) {
    fixed.push(`时长 ${contentJson.duration_min} 分钟超过${ageGroup}上限，已改为 ${band.duration_max} 分钟`);
    contentJson.duration_min = band.duration_max;
  }

  // 2. 环节数
  const flow = Array.isArray(contentJson.flow) ? contentJson.flow : [];
  if (flow.length > band.flow_stages) {
    violations.push(`教学流程有 ${flow.length} 个环节，${ageGroup}应为 ${band.flow_stages} 个`);
  }

  // 3. 学习指标数量
  const indicators = Array.isArray(contentJson.indicators) ? contentJson.indicators : [];
  const [minInd, maxInd] = band.indicators_count;
  if (indicators.length > maxInd) {
    violations.push(`学习指标有 ${indicators.length} 个，${ageGroup}应为 ${minInd}-${maxInd} 个`);
  }

  // 4. 小班禁止项：读数、称重、书写、预测、统计图表
  // 这几个词是 age-band-adaptation.md 点名禁止的，出现即报。
  if (ageGroup === '小班') {
    const text = JSON.stringify(contentJson);
    const banned = [
      { re: /量杯|毫升|cc|刻度|电子秤|克数|\d+\s*克/i, what: '出现了读数/称重（小班只能用非标准单位）' },
      { re: /条形图|统计图|柱状图|记录表格|写下|书写/, what: '出现了书写或统计图表（小班只能贴纸/盖章/涂色）' },
      { re: /预测|猜一猜会不会|你觉得会/, what: '出现了预测环节（小班改为"先玩→发现→再玩一次"）' },
      { re: /小组分工|分工合作|各组讨论/, what: '出现了小组分工（小班是平行游戏，做不到真正分工）' },
    ];
    for (const b of banned) if (b.re.test(text)) violations.push(b.what);

    const safety = JSON.stringify(contentJson.safety || []);
    if (!/误食|口腔|吞/.test(safety)) {
      violations.push('安全事项没有写误食风险（小班必须有）');
    }
  }

  // 5. STEAM 必需领域是否有实质内容
  const steam = contentJson.steam || {};
  for (const key of band.steam_required) {
    const v = steam[key];
    if (!v || String(v).trim().length < 2 || /未涉及|无|不涉及/.test(String(v))) {
      violations.push(`STEAM 的 ${key} 是${ageGroup}必须涉及的，但内容为空或写了"未涉及"`);
    }
  }

  return { violations, fixed };
}
