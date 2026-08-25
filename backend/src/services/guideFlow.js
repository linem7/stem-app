/**
 * 三轮引导的流程控制。
 *
 * 设计取舍（对照 system-prompts.md 第 5 节「MVP：纯 prompt 驱动」）：
 * 这里做的是**题目骨架由后端固定、推荐答案由模型生成**的折中方案，
 * 而不是让模型自己决定问几题。理由有三个：
 *   1. api-spec 的 progress 里要求返回确定的 round/question/total_rounds，
 *      模型自由发挥就给不出稳定的进度条
 *   2. 「每答一题即落库、断点续写」需要题目有稳定的 id 才能续得上
 *   3. 年龄班相关的选项（时长）必须是确定值，不能让模型即兴给出 45 分钟的小班活动
 * 这相当于直接把 system-prompts.md 里说的 Phase 2 状态机做掉了 —— 因为它是断点续写的前提。
 *
 * 本文件只做「逻辑与模型调用」，不碰数据库；落库在 routes/conversations.js。
 */
import { chatJSON } from './textChat.js';
import {
  buildGuideSystemPrompt,
  getAgeBand,
  AGE_GROUPS,
} from './promptBuilder.js';
import { badRequest } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * 题目骨架，对应 system-prompts.md「对话管理策略」的 Q1-Q11。
 * source 决定推荐答案从哪来：
 *   fixed    —— 代码写死（年龄班就三个，没有第四种可能）
 *   age_band —— 从年龄班参数表算出来（时长，必须受约束）
 *   model    —— 模型按老师档案+记忆生成
 */
export const QUESTION_PLAN = [
  { id: 'q1', key: 'age_group',   title: '这次活动是给哪个年龄班的？', hint: '决定后面所有内容的深浅', multi: false, source: 'fixed', required: true,  allowCustom: false },
  { id: 'q2', key: 'focus',       title: '你希望孩子主要收获什么？',   hint: '可以多选',             multi: true,  source: 'model', required: false, allowCustom: true },
  { id: 'q3', key: 'venue',       title: '打算在哪里做？',             hint: '场地不同，活动做法完全不一样', multi: false, source: 'model', required: false, allowCustom: true },
  { id: 'q4', key: 'constraints', title: '班上有什么情况要我考虑？',   hint: '人数、材料、人手都算',  multi: true,  source: 'model', required: false, allowCustom: true },
];

/**
 * 4 题，一次性全给出来（2026-08-17）。
 *
 * 【为什么是这 4 题】
 * 判断标准只有一条：**只问模型猜不到的，不问模型本来就该会的**。
 *   年龄班   —— 决定整套适龄规则，唯一必答
 *   教学重点 —— 老师的意图。同一个「浮与沉」，有人想让孩子玩个痛快，有人想引出材料概念
 *   场地     —— 户外空地搭跷跷板，还是教室区角做桌面游戏，活动形态是两回事。
 *                模型只看主题猜不出来，猜错了整份教案都白写
 *   班上情况 —— 人数、材料、人手，每个园都不一样
 *
 * 【为什么不问时长】
 * 年龄班一确定时长就定了（defaultDuration：小班 20 / 中班 30 / 大班 40）。
 * 再问一遍等于让老师替代码做算术。她要改，成稿页直接改那个数字。
 *
 * 【砍掉的那些去哪了】
 * 材料、流程、要问孩子什么、安全事项、评估、延伸 —— 全部由模型按教学框架和年龄班规则产出。
 * 它们本来就是 lessonGenerator 里模型输出的字段，从来不是从 collected 读的。
 *
 * 【为什么一次给全，不再一题一题喂】
 * 老师看不到总量时，答完一题不知道还剩几题，心里没底就容易中途退出。
 * 一屏摊开、顶部一条进度、随时看得到还差几题，比逐题揭晓好。
 * 一次性出题不等于一次性提交 —— 前端每选一项仍然调一次 answer 落库，
 * 她在幼儿园随时被叫走，进度不能丢（PRD 的硬要求）。
 */
export const TOTAL_QUESTIONS = QUESTION_PLAN.length;

// ---------------------------------------------------------------
// 进度
// ---------------------------------------------------------------

/** 已经答过的题（collected 里有值就算答过；空数组、空串不算） */
function answeredKeys(collected = {}) {
  return QUESTION_PLAN.filter((q) => {
    const v = collected[q.key];
    return !(v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0));
  }).map((q) => q.key);
}

/**
 * api-spec 第 3 节的 progress。
 * 从「第几轮第几题」换成「答了几题 / 共几题」—— 题目一次性全给出来之后，
 * 轮次不再是老师感知得到的东西，她看到的就是一条进度。
 */
export function buildProgress(collected = {}) {
  const answered = answeredKeys(collected).length;
  const requiredLeft = QUESTION_PLAN.filter(
    (q) => q.required && !answeredKeys(collected).includes(q.key)
  ).length;
  return { answered, total: TOTAL_QUESTIONS, required_left: requiredLeft };
}

/** 教案库列表里的 progress_text（api-spec 第 7 节） */
export function progressText(conv) {
  if (conv.status === 'completed') return '已完成';
  if (conv.status === 'generating') return '正在生成教案…';
  if (conv.status === 'failed') return '生成失败，可以重试';

  const { answered, total } = buildProgress(conv.collected || {});
  if (answered === 0) return `还没开始答，共 ${total} 题`;
  if (answered >= total) return '问题都答完了，可以生成教案';
  return `答了 ${answered}/${total} 题，还剩 ${total - answered} 题`;
}

/** 必答题都答完了就算走完 —— 其余题跳过是允许的 */
export function isFinished(collected = {}) {
  return buildProgress(collected).required_left === 0;
}

/**
 * 能不能生成（api-spec 的 can_finish）。
 * 门槛就是年龄班：没有年龄班就没法应用适配规则，生成出来的一定是错的。
 */
export function canFinish(collected) {
  return Boolean(collected && collected.age_group);
}

/** 按 id 找题 */
export function specOf(questionId) {
  return QUESTION_PLAN.find((q) => q.id === questionId) || null;
}

// ---------------------------------------------------------------
// 出题
// ---------------------------------------------------------------

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E'];

/**
 * 兜底选项：模型挂了或超时时用这套，保证引导永远不会卡死。
 * 老师宁可看到一组普通的推荐，也不愿意看到「生成失败请重试」。
 */
function fallbackOptions(spec) {
  const map = {
    focus: ['体验和感受这个现象', '弄懂一个简单的道理', '学会用某样工具', '敢说出自己的发现'],
    venue: ['就在教室里', '走廊或区角', '户外场地', '多功能活动室'],
    constraints: ['班上人数偏多', '材料要便宜好找', '只有我一个老师', '只能安排一次'],
  };
  const labels = (map[spec.key] || ['我自己说']).slice(0, 4);
  return labels.map((label, i) => ({ key: OPTION_KEYS[i], label }));
}

/** 年龄班这题写死：只有三个班，没有第四种可能，不值得问模型 */
function ageGroupOptions(teacher) {
  return AGE_GROUPS.map((name, i) => {
    const band = getAgeBand(name);
    const opt = { key: OPTION_KEYS[i], label: name, sub: band.age };
    // 老师档案里的任教年龄班预先推荐 —— 她只带一个班，这个默认几乎总是对的
    if (teacher?.age_group === name) opt.recommended = true;
    return opt;
  });
}

/**
 * 一次生成全部需要模型出选项的题（现在是 focus / venue / constraints 三题）。
 *
 * 合成一次调用而不是三次：延迟和成本都是三分之一，而且模型能看到三题的全貌，
 * 不会在「场地」里给出跟「班上情况」重复的选项。
 *
 * 推荐答案按 ageGroup 生成 —— 老师还没答年龄班时用她档案里的班（她只带一个班，
 * 档案稳定）。她要是选了别的班，路由会调 GET /conversations/:id/questions 重拉。
 *
 * 这个函数**永远不抛错**：模型挂了就整体降级到兜底选项，引导流程不能因此卡住。
 */
export async function buildAllQuestions({ teacher, memories, collected = {}, seedInput, ageGroup }) {
  const age = ageGroup || collected.age_group || teacher?.age_group || null;
  const modelSpecs = QUESTION_PLAN.filter((q) => q.source === 'model');

  let generated = {};
  try {
    const system = buildGuideSystemPrompt({
      teacher, memories,
      collected: { ...collected, ...(age ? { age_group: age } : {}) },
      seedInput,
    });

    const ask = modelSpecs
      .map((q, i) => `${i + 1}. 题目 ${q.id}「${q.title}」（${q.multi ? '可多选，给 4 个' : '单选，给 3 个'}）`)
      .join('\n');

    const { data } = await chatJSON({
      system,
      messages: [{ role: 'user', content:
`老师刚说了他的想法：${seedInput}

请一次性为下面这几道题各准备一组推荐答案：
${ask}

要求：
- label 不超过 14 个字，是老师能直接点选的**具体**答案，不要"其他""视情况而定"这种废话
- sub 不超过 12 个字，说明这个选项意味着什么，帮她一眼区分
- ${age ? `这是${age}的活动，必须符合上面的年龄班规则` : '年龄班还没定，给通用的'}
- **场地那题（venue）要给出真正不同的场地**，比如教室区角、走廊、户外空地、盥洗室、多功能室，
  并且要贴合这个主题 —— 搭高塔和玩水，适合的场地完全不一样
- 结合老师的档案和记忆，别给她已经明确排除过的东西
- 三题的选项之间不要重复：场地就说场地，班上情况说人数材料人手

只输出 JSON：{"q2":{"ack":"","options":[{"label":"","sub":""}]},"q3":{...},"q4":{...}}
每题的 ack 是一句不超过 20 字的引导语，写在题目下方帮老师理解为什么问这个。` }],
      temperature: 0.8,
      maxTokens: 1200,
      purpose: 'guide_all',
      teacherId: teacher?.id ?? null,   // 记账用：算「哪个园花了多少文本钱」
    });
    generated = data || {};
  } catch (err) {
    logger.warn('guide_model_degraded', { code: err?.code });
  }

  return QUESTION_PLAN.map((spec) => {
    let options;
    if (spec.source === 'fixed') {
      options = ageGroupOptions(teacher);
    } else {
      const g = generated[spec.id];
      const raw = Array.isArray(g?.options) ? g.options : [];
      const cleaned = raw
        .filter((o) => o && typeof o.label === 'string' && o.label.trim())
        .slice(0, 5)
        .map((o, i) => ({
          key: OPTION_KEYS[i],
          label: o.label.trim().slice(0, 30),
          ...(o.sub ? { sub: String(o.sub).trim().slice(0, 24) } : {}),
        }));
      options = cleaned.length >= 2 ? cleaned : fallbackOptions(spec);
    }

    return {
      id: spec.id,
      key: spec.key,
      title: spec.title,
      hint: spec.hint,
      multi: spec.multi,
      options,
      allow_custom: spec.allowCustom,
      custom_placeholder: spec.allowCustom ? '我自己说 —— 点这里打字' : null,
      required: spec.required,
    };
  });
}

/**
 * 老师答完一题后的那句回应。单独一次小调用，失败就用一句中性的兜底 ——
 * 它只是让界面显得在听，值不了一次重试。
 */
export async function buildAck({ teacher, memories, collected, seedInput, spec, answerText }) {
  try {
    const { data } = await chatJSON({
      system: buildGuideSystemPrompt({ teacher, memories, collected, seedInput }),
      messages: [{ role: 'user', content:
`老师刚回答了「${spec.title}」，她的答案是：${answerText}

只输出 JSON：{"ack":"一句话回应，不超过 25 字，要具体承接她说的内容，不要复述、不要客套"}` }],
      temperature: 0.8,
      /* 240 不是 120（2026-08-23 上调）。这句回应只要 25 字，120 token 本该够用 ——
         但换成 deepseek-v4-flash 之后实测**每次都顶满 120 被截断**，
         于是老师每答一题看到的都是兜底句「好的，记下了。」，
         而这个调用存在的全部理由就是让她觉得「它真的在听」。
         这里不重试（有兜底句），所以预算必须一次给够。 */
      maxTokens: 240,
      purpose: `ack_${spec.id}`,
      teacherId: teacher?.id ?? null,
    });
    const ack = typeof data.ack === 'string' ? data.ack.trim().slice(0, 60) : '';
    if (ack) return ack;
  } catch (err) {
    logger.warn('ack_model_degraded', { code: err?.code, question_id: spec.id });
  }
  return '好的，记下了。';
}

// ---------------------------------------------------------------
// 收答案
// ---------------------------------------------------------------

/**
 * 把「选了哪几个 key + 自己打的字」还原成可读文本和结构化值。
 *
 * @param {object} spec      QUESTION_PLAN 里的那一项
 * @param {object} pending   上一条 assistant 消息里存的 question payload（含 options）
 * @param {object} answer    { selected: string[], custom_text: string|null }
 * @returns {{ value: any, text: string }}
 */
export function resolveAnswer(spec, pending, answer) {
  const selected = Array.isArray(answer.selected) ? answer.selected : [];
  const custom = typeof answer.custom_text === 'string' ? answer.custom_text.trim() : '';

  const options = Array.isArray(pending?.options) ? pending.options : [];
  const labels = selected
    .map((k) => options.find((o) => o.key === k)?.label)
    .filter(Boolean);

  if (selected.length && labels.length !== selected.length) {
    throw badRequest('有个选项没找到，刷新一下再试');
  }
  if (!spec.multi && labels.length > 1) {
    throw badRequest('这题只能选一个');
  }
  if (!spec.allowCustom && custom) {
    throw badRequest('这题只能从给出的选项里选');
  }
  if (spec.required && labels.length === 0 && !custom) {
    throw badRequest(
      spec.key === 'safety' ? '安全事项是必答的，随便写一条也行' : '这题要选一个才能继续'
    );
  }

  const all = custom ? [...labels, custom] : labels;
  const text = all.length ? all.join('；') : '（跳过）';

  // 按字段类型收敛成合适的结构，供后续生成教案直接用
  let value;
  switch (spec.key) {
    case 'age_group': {
      // 年龄班必须收敛到三个合法值之一，否则后面的适配规则会失效
      const raw = all.join('');
      const hit = AGE_GROUPS.find((g) => raw.includes(g));
      if (!hit) throw badRequest('请选择小班、中班或大班');
      value = hit;
      break;
    }
    default:
      value = spec.multi ? all : all.join('；') || null;
  }

  return { value, text };
}
