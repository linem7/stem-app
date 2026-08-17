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
import { chatJSON } from './deepseek.js';
import {
  buildGuideSystemPrompt,
  durationOptions,
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
  { id: 'q1', key: 'age_group', round: 1, title: '这次活动是给哪个年龄班的？', hint: '选一个最接近的就好', multi: false, source: 'fixed', required: true, allowCustom: false },
  { id: 'q2', key: 'focus', round: 1, title: '你希望孩子在这次活动里主要收获什么？', hint: '可以多选，也可以自己说', multi: true, source: 'model', required: false, allowCustom: true },

  { id: 'q3', key: 'constraints', round: 2, title: '有什么现实条件要考虑吗？', hint: '场地、材料、人手都算', multi: true, source: 'model', required: false, allowCustom: true },
  { id: 'q4', key: 'duration', round: 2, title: '活动大概安排多长时间？', hint: '按这个年龄班的注意力时长推荐的', multi: false, source: 'age_band', required: false, allowCustom: true },

  { id: 'q5', key: 'adjustments', round: 3, title: '还有什么想让我注意的？', hint: '没有就跳过，剩下的我来定', multi: false, source: 'model', required: false, allowCustom: true },
];

/**
 * 从 11 题砍到 5 题（2026-08-17）。
 *
 * 砍掉的是：材料、流程安排、关键提问、安全事项、评估方式、延伸活动。
 * 判断标准只有一条 —— **只问 AI 猜不到的，不问 AI 本来就该会的**：
 *   留下的四类信息（她带哪个班、她想要什么、她有什么限制、她额外想说的）
 *   只有老师知道，模型再聪明也猜不出来；
 *   砍掉的六项是教学专业知识，模型按教学框架 + 年龄班规则本来就该产出得比老师随手选的更好，
 *   问了反而是把活儿推回给老师 —— 而她来用这个工具就是因为没时间。
 *
 * 这几项并没有从教案里消失：它们本来就是 lessonGenerator 里模型输出的字段，
 * 不是从 collected 读的。老师要改，在成稿页直接改，或者走「改一改」重新追问。
 */
export const TOTAL_ROUNDS = 3;
/** 每轮题数：2 / 2 / 1 —— 一共 5 题，对应首页那句「分 2–3 轮问你几个问题」 */
export const QUESTIONS_IN_ROUND = QUESTION_PLAN.reduce((acc, q) => {
  acc[q.round] = (acc[q.round] || 0) + 1;
  return acc;
}, {});

// ---------------------------------------------------------------
// 进度换算
// ---------------------------------------------------------------

/** (round, questionIndex) → 在 QUESTION_PLAN 里的下标（0 起） */
export function planIndexOf(round, questionIndex) {
  let seen = 0;
  for (let r = 1; r < round; r += 1) seen += QUESTIONS_IN_ROUND[r] || 0;
  return seen + questionIndex - 1;
}

/** 下标 → { round, questionIndex }；越界返回 null（表示引导已走完） */
export function positionOf(planIndex) {
  if (planIndex < 0 || planIndex >= QUESTION_PLAN.length) return null;
  const spec = QUESTION_PLAN[planIndex];
  let before = 0;
  for (let r = 1; r < spec.round; r += 1) before += QUESTIONS_IN_ROUND[r] || 0;
  return { round: spec.round, questionIndex: planIndex - before + 1 };
}

/** api-spec 里的 progress 对象 */
export function buildProgress(round, questionIndex) {
  return {
    round,
    question: questionIndex,
    total_rounds: TOTAL_ROUNDS,
    questions_in_round: QUESTIONS_IN_ROUND[round] || 0,
  };
}

/** 教案库列表里的 progress_text（api-spec 第 7 节） */
export function progressText(conv) {
  if (conv.status === 'completed') return '已完成';
  if (conv.status === 'generating') return '正在生成教案…';
  if (conv.status === 'failed') return '生成失败，可以重试';

  const idx = planIndexOf(conv.round_index, conv.question_index);
  if (idx >= QUESTION_PLAN.length) return '问题都答完了，可以生成教案';
  const inRound = QUESTIONS_IN_ROUND[conv.round_index] || 0;
  const left = inRound - conv.question_index;
  return left > 0
    ? `进行到第 ${conv.round_index} 轮第 ${conv.question_index} 题，还剩 ${left} 题`
    : `进行到第 ${conv.round_index} 轮最后一题`;
}

/** 引导是不是已经走完 */
export function isFinished(round, questionIndex) {
  return planIndexOf(round, questionIndex) >= QUESTION_PLAN.length;
}

/**
 * 能不能提前生成（api-spec 的 can_finish）。
 * 门槛是「年龄班已确定」：没有年龄班就没法应用适配规则，生成出来的一定是错的。
 */
export function canFinish(collected) {
  return Boolean(collected && collected.age_group);
}

// ---------------------------------------------------------------
// 出题
// ---------------------------------------------------------------

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E'];

/**
 * 兜底选项：模型挂了/超时的时候用这一套，保证引导流程永远不会卡死。
 * 老师宁可看到一组普通的推荐，也不愿意看到"生成失败请重试"。
 */
function fallbackOptions(spec, collected) {
  const band = getAgeBand(collected.age_group);
  const map = {
    focus: ['体验和感受这个现象', '弄懂一个简单的道理', '学会用某样工具', '敢说出自己的发现'],
    constraints: ['就在教室里做', '没有大的活动场地', '材料要便宜好找', '只能安排一次活动'],
    adjustments: ['再简单一点', '再有挑战一点', '时间再短一点', '不用调整'],
  };
  void band; // 安全事项已改为模型按年龄班规则自己产出，这里不再需要 band.safety_focus
  const labels = (map[spec.key] || ['我自己说']).slice(0, 4);
  return labels.map((label, i) => ({ key: OPTION_KEYS[i], label }));
}

/** 年龄班这题的选项是写死的：只有三个班，不需要问模型 */
function ageGroupOptions(teacher) {
  return AGE_GROUPS.map((name, i) => {
    const band = getAgeBand(name);
    const opt = { key: OPTION_KEYS[i], label: name, sub: band.age };
    // 老师档案里的任教年龄班作为默认推荐（age-band-adaptation.md「对界面的影响」）
    if (teacher?.age_group === name) opt.recommended = true;
    return opt;
  });
}

/**
 * 时长选项来自年龄班参数表，不问模型。
 * 这是「年龄班规则真正生效」的第二道保障：选了小班就只能看到 15/20/25，
 * 界面上根本不会出现 45 分钟这个选项。
 */
function durationOptionsFor(collected) {
  const ageGroup = collected.age_group;
  const [rec1, rec2, max] = durationOptions(ageGroup);
  const band = getAgeBand(ageGroup);
  return [
    { key: 'A', label: `${rec1} 分钟`, sub: '偏短，注意力容易保持', recommended: true },
    { key: 'B', label: `${rec2} 分钟`, sub: `${ageGroup || '这个年龄班'}最常用的时长`, recommended: true },
    { key: 'C', label: `${max} 分钟`, sub: `已经是${ageGroup || '这个年龄班'}的上限了` },
  ].map((o) => ({ ...o, _band_max: band.duration_max }));
}

/**
 * 让模型生成 ack + 推荐选项。
 * ack 和选项合并成一次调用：每答一题只调一次模型，成本和延迟都减半。
 */
async function askModel({ teacher, memories, collected, seedInput, spec, lastAnswer, needOptions }) {
  const system = buildGuideSystemPrompt({ teacher, memories, collected, seedInput });

  const parts = [];
  if (lastAnswer) {
    parts.push(`老师刚刚回答了「${lastAnswer.title}」，他的答案是：${lastAnswer.text}`);
  } else {
    parts.push('这是对话的开始，老师刚说完他的想法。');
  }
  if (spec) {
    parts.push(`接下来我要问老师的是：「${spec.title}」`);
    if (needOptions) {
      parts.push(
        `请给这道题准备 ${spec.multi ? '4' : '3'} 个推荐答案。要求：\n` +
          `- label 不超过 14 个字，是老师能直接点选的具体答案，不是"其他""视情况而定"这种废话\n` +
          `- sub 不超过 12 个字，说明这个选项意味着什么，帮老师区分\n` +
          `- 必须符合上面的年龄班规则；${collected.age_group ? `这是${collected.age_group}的活动` : '年龄班还没定，给通用的'}\n` +
          `- 结合老师的档案和记忆，别给他已经明确排除过的东西`
      );
    } else {
      parts.push('这道题的选项由系统给定，你不用出选项。');
    }
  } else {
    parts.push('所有问题都问完了，接下来就要生成教案了。');
  }
  parts.push(
    `只输出 JSON：{"ack":"一句话回应老师刚才的答案，不超过 25 字，要具体承接他说的内容，不要复述、不要客套"${
      needOptions ? ',"options":[{"label":"…","sub":"…"}]' : ''
    }}`
  );

  const { data } = await chatJSON({
    system,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    temperature: 0.8,
    maxTokens: 600,
    purpose: `guide_${spec ? spec.id : 'finish'}`,
  });

  const ack = typeof data.ack === 'string' ? data.ack.trim().slice(0, 60) : '';
  let options = null;
  if (needOptions && Array.isArray(data.options)) {
    options = data.options
      .filter((o) => o && typeof o.label === 'string' && o.label.trim())
      .slice(0, 5)
      .map((o, i) => ({
        key: OPTION_KEYS[i],
        label: o.label.trim().slice(0, 30),
        ...(o.sub ? { sub: String(o.sub).trim().slice(0, 24) } : {}),
      }));
    if (options.length < 2) options = null; // 少于两个不成其为选择题，走兜底
  }
  return { ack, options };
}

/**
 * 生成「下一题 + 对上一题的回应」。
 *
 * 关键约定：这个函数**永远不抛错**。老师的答案在调用它之前就已经落库了，
 * 模型挂掉不应该让老师看到失败 —— 降级成兜底选项继续往下走。
 *
 * @returns {Promise<{ack:string, question:object|null, ready_to_generate:boolean}>}
 */
export async function buildNextStep({ teacher, memories, collected, seedInput, planIndex, lastAnswer }) {
  const spec = QUESTION_PLAN[planIndex] || null;
  const needOptions = Boolean(spec && spec.source === 'model');

  let ack = '';
  let modelOptions = null;
  try {
    const r = await askModel({ teacher, memories, collected, seedInput, spec, lastAnswer, needOptions });
    ack = r.ack;
    modelOptions = r.options;
  } catch (err) {
    logger.warn('guide_model_degraded', { code: err?.code, plan_index: planIndex });
    ack = lastAnswer ? '好的，记下了。' : '好的，我们一起把它想清楚。';
  }

  if (!spec) {
    return { ack: ack || '问题都问完了，可以生成教案了。', question: null, ready_to_generate: true };
  }

  let options;
  if (spec.source === 'fixed') options = ageGroupOptions(teacher);
  else if (spec.source === 'age_band') options = durationOptionsFor(collected);
  else options = modelOptions || fallbackOptions(spec, collected);

  // 清掉内部字段，别让 _band_max 之类的东西泄到接口上
  options = options.map(({ _band_max, ...rest }) => rest);

  return {
    ack,
    ready_to_generate: false,
    question: {
      id: spec.id,
      title: spec.title,
      hint: spec.hint,
      multi: spec.multi,
      options,
      allow_custom: spec.allowCustom,
      custom_placeholder: spec.allowCustom ? '我自己说 —— 点这里打字' : null,
      required: spec.required,
    },
  };
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
    case 'duration': {
      const m = /(\d{1,3})/.exec(all.join(' '));
      const mins = m ? Number(m[1]) : null;
      if (!mins) {
        value = null;
        break;
      }
      value = mins;
      break;
    }
    default:
      value = spec.multi ? all : all.join('；') || null;
  }

  return { value, text };
}

/**
 * 时长的年龄班兜底：老师自己打字写了 60 分钟给小班时，收敛到该班上限。
 * 不直接报错拒绝，因为老师可能真的想上两次课；但教案必须按上限生成，
 * 同时把老师原话留在 collected.duration_note 里，生成时会一并给模型。
 * @returns {{ duration:number|null, note:string|null }}
 */
export function clampDuration(minutes, ageGroup) {
  if (!minutes) return { duration: null, note: null };
  const band = getAgeBand(ageGroup);
  if (minutes > band.duration_max) {
    return {
      duration: band.duration_max,
      note: `老师原本想安排 ${minutes} 分钟，但${ageGroup || '这个年龄班'}单次活动上限是 ${band.duration_max} 分钟，已按上限设计；可以建议老师拆成两次活动。`,
    };
  }
  return { duration: minutes, note: null };
}
