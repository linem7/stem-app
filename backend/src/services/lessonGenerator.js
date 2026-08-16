/**
 * 教案生成 + 自检。
 *
 * 两次模型调用：
 *   第一次：生成结构化教案（要求返回 JSON，便于分节编辑）
 *   第二次：自检（8 个质量维度 + 年龄班越界检查）
 * 中间夹一层代码层的年龄班硬校验（promptBuilder.enforceAgeBand）。
 *
 * 为什么要 JSON 而不是直接要 Markdown：
 * db-schema.md 要求同时存 md 和 json，且「编辑时以 json 为准，md 由 json 渲染」。
 * 所以生成时就只产出 json 一份真相，md 由 renderMarkdown 渲染 —— 两份永远不会漂移。
 */
import { chatJSON, chat } from './deepseek.js';
import {
  buildLessonSystemPrompt,
  buildCollectedBlock,
  getAgeBand,
  enforceAgeBand,
} from './promptBuilder.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** 生成阶段的提示文案（api-spec 第 4 节 progress_hint） */
export const PROGRESS_HINTS = {
  start: '正在梳理你的想法…',
  drafting: '正在设计教学流程…',
  checking: '正在检查是否适合这个年龄班…',
  finishing: '就快好了，正在排版…',
};

const JSON_SHAPE = `{
  "title": "教案标题，动词+对象的形式，不超过 20 字",
  "duration_min": 30,
  "features": {
    "problem_source": "这个问题为什么源自老师说的那个真实情境，两三句话",
    "learning_experiences": ["幼儿将获得的学习经验，3-5 条"]
  },
  "materials": ["材料清单，每项写清楚数量或规格"],
  "flow": [
    { "stage": "引起动机", "minutes": 5, "detail": "这个环节老师具体做什么、说什么、孩子在干什么。要写得能照着上，不要写空话" }
  ],
  "steam": {
    "S": "科学：这次活动里具体是什么现象或特性",
    "T": "技术：具体用什么工具、什么技巧",
    "E": "工程：具体改进了什么、优化了什么。这个年龄班若确实不涉及，写「本次未涉及」",
    "A": "艺术：具体的美感或创意表现",
    "M": "数学：具体的比较、测量或数量经验"
  },
  "indicators": ["幼儿学习指标，只写教学实例里确实体现出来的"],
  "dialogue": [
    { "speaker": "T", "text": "老师说的话" },
    { "speaker": "C", "text": "孩子说的话" }
  ],
  "safety": ["安全事项，每条具体可执行"],
  "extension": "延伸活动，一段话",
  "reflection": "教学省思：可能和预期不一样的地方、要重点观察什么、下次可以怎么改"
}`;

/**
 * 生成一份教案。
 *
 * @param {object} o
 * @param {object} o.conversation  conversations 行
 * @param {object} o.teacher       teachers 行
 * @param {Array}  o.memories      teacher_memories 行
 * @param {Array}  [o.qaHistory]   [{question, answer}] 引导过程的问答，供模型理解上下文
 * @param {Function} [o.onProgress] (hintKey) => void，用来推进 progress_hint
 * @returns {Promise<{title,age_group,duration_min,content_json,content_md,quality_self,tokenIn,tokenOut}>}
 */
export async function generateLessonPlan({ conversation, teacher, memories, qaHistory = [], onProgress = () => {} }) {
  const collected = conversation.collected || {};
  const ageGroup = collected.age_group || conversation.age_group || teacher?.age_group || '中班';
  const band = getAgeBand(ageGroup);

  onProgress('start');

  const system = buildLessonSystemPrompt({
    teacher,
    memories,
    collected: { ...collected, age_group: ageGroup },
    seedInput: conversation.seed_input,
  });

  const qaBlock = qaHistory.length
    ? `\n\n【引导过程的问答】\n${qaHistory.map((x, i) => `${i + 1}. 问：${x.question}\n   答：${x.answer}`).join('\n')}`
    : '';

  const durationTarget = pickDuration(collected.duration, band);

  const userPrompt = `请根据下面的信息，生成一份完整的STEAM教案。

【老师最初的想法】
${conversation.seed_input}
${qaBlock}

${buildCollectedBlock(collected)}
${collected.duration_note ? `\n注意：${collected.duration_note}` : ''}

生成要求：
1. 年龄班是【${ageGroup}】，时长按 ${durationTarget} 分钟设计（绝对不能超过 ${band.duration_max} 分钟）
2. 教学流程写 ${band.flow_stages} 个环节，每个环节都要有 minutes，加起来等于 ${durationTarget}
3. 学习指标 ${band.indicators_count[0]}-${band.indicators_count[1]} 个
4. 师生对话写 4-6 组，要包含至少一次「没成功 → 改一改 → 再试」的过程
5. 对话里孩子的话必须符合${ageGroup}的语言水平（${
    ageGroup === '小班'
      ? '单词、短句或动作，不要写出带因果推理的完整句子'
      : ageGroup === '中班'
        ? '能描述看到的现象，但说不清完整的因果'
        : '能说出理由和过程'
  }）
6. 测量与记录方式必须是：${band.measurement}；记录用 ${band.recording.join('、')}
7. 安全事项必须覆盖：${band.safety_focus.join('、')}
8. 全程简体中文，大陆幼教用语

只输出 JSON，结构如下（不要加任何解释文字）：
${JSON_SHAPE}`;

  onProgress('drafting');

  const { data, tokenIn, tokenOut } = await chatJSON({
    system,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.7,
    maxTokens: 4000,
    // 整份教案比出题慢得多，超时单独放宽到 3 分钟
    timeoutMs: 180000,
    purpose: 'lesson_generate',
  });

  const contentJson = normalizePlan(data, ageGroup, durationTarget);

  onProgress('checking');

  // 代码层硬校验：模型是概率的，这一层是确定的
  const { violations, fixed } = enforceAgeBand(contentJson, ageGroup);
  if (violations.length || fixed.length) {
    logger.warn('age_band_check', {
      conversation_id: conversation.id,
      age_group: ageGroup,
      violations: violations.length,
      fixed: fixed.length,
    });
  }

  // 模型自检（8 维度）。失败不影响出稿 —— 自检只是内测分析用的附加信息。
  let modelSelfCheck = null;
  try {
    modelSelfCheck = await selfCheck(contentJson, ageGroup, system);
  } catch (err) {
    logger.warn('self_check_failed', { conversation_id: conversation.id, code: err?.code });
  }

  onProgress('finishing');

  const qualitySelf = {
    checked_at: new Date().toISOString(),
    age_group: ageGroup,
    age_band_violations: violations, // 代码查出来的越界（这几条最要紧）
    age_band_auto_fixed: fixed, // 代码自动纠正掉的
    model: modelSelfCheck, // 模型的 8 维度打分
  };

  const contentMd = renderMarkdown({
    title: contentJson.title,
    age_group: ageGroup,
    duration_min: contentJson.duration_min,
    content_json: contentJson,
  });

  return {
    title: contentJson.title,
    age_group: ageGroup,
    duration_min: contentJson.duration_min,
    content_json: contentJson,
    content_md: contentMd,
    quality_self: qualitySelf,
    tokenIn,
    tokenOut,
  };
}

/** 时长：老师选了就用老师的，没选就用该年龄班推荐区间的上限 */
function pickDuration(collectedDuration, band) {
  const d = Number(collectedDuration);
  if (Number.isFinite(d) && d > 0) return Math.min(d, band.duration_max);
  return band.duration_recommend[1];
}

/**
 * 把模型返回的 JSON 收敛成我们要存的形状。
 * 模型偶尔会少字段、把数组写成字符串、把 flow 写成对象 —— 这里全部兜住，
 * 让下游（渲染、编辑、导出）永远拿到同一种结构。
 */
function normalizePlan(raw, ageGroup, durationTarget) {
  if (!raw || typeof raw !== 'object') {
    throw new AppError(ErrorCode.MODEL_FAILED, { detail: { reason: 'plan_not_object' } });
  }
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : v ? [v] : []);
  const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

  const flow = arr(raw.flow)
    .map((s, i) => ({
      stage: str(s?.stage) || `环节${i + 1}`,
      minutes: Number.isFinite(Number(s?.minutes)) ? Number(s.minutes) : null,
      detail: str(s?.detail ?? s?.content ?? ''),
    }))
    .filter((s) => s.detail);

  if (!flow.length) {
    throw new AppError(ErrorCode.MODEL_FAILED, { detail: { reason: 'plan_no_flow' } });
  }

  const steamRaw = raw.steam && typeof raw.steam === 'object' ? raw.steam : {};
  const steam = {};
  for (const k of ['S', 'T', 'E', 'A', 'M']) steam[k] = str(steamRaw[k] ?? steamRaw[k.toLowerCase()] ?? '');

  const dialogue = arr(raw.dialogue)
    .map((d) => {
      if (typeof d === 'string') {
        const m = /^\s*([TC])\s*[:：]\s*(.+)$/.exec(d);
        return m ? { speaker: m[1], text: m[2].trim() } : { speaker: 'T', text: d.trim() };
      }
      return { speaker: d?.speaker === 'C' ? 'C' : 'T', text: str(d?.text) };
    })
    .filter((d) => d.text);

  const title = str(raw.title).slice(0, 60) || '未命名教案';
  const duration =
    Number.isFinite(Number(raw.duration_min)) && Number(raw.duration_min) > 0
      ? Number(raw.duration_min)
      : durationTarget;

  return {
    title,
    age_group: ageGroup,
    duration_min: duration,
    features: {
      problem_source: str(raw.features?.problem_source),
      learning_experiences: arr(raw.features?.learning_experiences).map(str).filter(Boolean),
    },
    materials: arr(raw.materials).map(str).filter(Boolean),
    flow,
    steam,
    indicators: arr(raw.indicators).map(str).filter(Boolean),
    dialogue,
    safety: arr(raw.safety).map(str).filter(Boolean),
    extension: str(raw.extension),
    reflection: str(raw.reflection),
  };
}

/** 模型自检：8 个维度打分 + 指出问题（system-prompts.md「质量检查」） */
async function selfCheck(contentJson, ageGroup, systemPrompt) {
  const { data } = await chatJSON({
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `下面是你刚生成的教案。请以审稿人的身份自检，诚实打分，不要护短。

${JSON.stringify(contentJson)}

按 8 个质量维度各打 1-5 分（5 分最好），并指出确实存在的问题。
特别检查：这份教案里有没有【${ageGroup}】孩子做不到的动作？重点看预测、读数、书写、小组分工、集体讨论、长时间专注。

只输出 JSON：
{"scores":{"问题的真实性":4,"探究的循环性":4,"STEAM的融合度":4,"师生对话的真实性":4,"测量与记录":4,"连贯的脉络性":4,"学习指标的对应":4,"教学反思的深度":4},
 "age_band_fit": true,
 "issues": ["具体问题，没有就给空数组"]}`,
      },
    ],
    temperature: 0.2,
    maxTokens: 800,
    timeoutMs: 90000,
    purpose: 'lesson_self_check',
  });

  return {
    scores: data.scores && typeof data.scores === 'object' ? data.scores : null,
    age_band_fit: data.age_band_fit !== false,
    issues: Array.isArray(data.issues) ? data.issues.map(String).slice(0, 10) : [],
  };
}

/**
 * 由 content_json 渲染 Markdown。
 *
 * 编辑教案时也调这个函数重渲染（PATCH /lesson-plans/:id），
 * 保证 md 永远是 json 的投影，不会两边各改一半。
 */
export function renderMarkdown(plan) {
  const c = plan.content_json || {};
  const L = [];

  L.push(`# ${plan.title || c.title || '未命名教案'}`);
  L.push('');
  L.push(`**年龄班**：${plan.age_group || c.age_group || ''}　　**时长**：${plan.duration_min || c.duration_min || '—'} 分钟`);

  const steamTags = ['S', 'T', 'E', 'A', 'M'].filter((k) => {
    const v = c.steam?.[k];
    return v && !/未涉及|不涉及|^无$/.test(v);
  });
  if (steamTags.length) L.push(`**STEAM 领域**：${steamTags.join(' · ')}`);
  L.push('');

  if (c.features?.problem_source) {
    L.push('## 教案特色说明');
    L.push('');
    L.push(c.features.problem_source);
    L.push('');
  }
  if (c.features?.learning_experiences?.length) {
    L.push('**幼儿将获得的学习经验**');
    L.push('');
    c.features.learning_experiences.forEach((x) => L.push(`- ${x}`));
    L.push('');
  }

  if (c.materials?.length) {
    L.push('## 材料准备');
    L.push('');
    c.materials.forEach((x) => L.push(`- ${x}`));
    L.push('');
  }

  if (c.flow?.length) {
    L.push('## 教学流程');
    L.push('');
    c.flow.forEach((s, i) => {
      L.push(`### ${i + 1}. ${s.stage}${s.minutes ? `（${s.minutes} 分钟）` : ''}`);
      L.push('');
      L.push(s.detail);
      L.push('');
    });
  }

  if (c.steam) {
    L.push('## STEAM 知识概念');
    L.push('');
    L.push('| 领域 | 具体内容 |');
    L.push('| --- | --- |');
    const names = { S: 'S 科学', T: 'T 技术', E: 'E 工程', A: 'A 艺术', M: 'M 数学' };
    for (const k of ['S', 'T', 'E', 'A', 'M']) {
      const v = c.steam[k];
      if (!v) continue;
      L.push(`| ${names[k]} | ${String(v).replace(/\|/g, '/')} |`);
    }
    L.push('');
  }

  if (c.indicators?.length) {
    L.push('## 幼儿学习指标');
    L.push('');
    c.indicators.forEach((x) => L.push(`- ${x}`));
    L.push('');
  }

  if (c.dialogue?.length) {
    L.push('## 教学实例（师生对话）');
    L.push('');
    c.dialogue.forEach((d) => L.push(`**${d.speaker === 'C' ? 'C（幼儿）' : 'T（教师）'}**：${d.text}`));
    L.push('');
  }

  if (c.safety?.length) {
    L.push('## 安全事项');
    L.push('');
    c.safety.forEach((x) => L.push(`- ${x}`));
    L.push('');
  }

  if (c.extension) {
    L.push('## 延伸活动');
    L.push('');
    L.push(c.extension);
    L.push('');
  }

  if (c.reflection) {
    L.push('## 教学省思');
    L.push('');
    L.push(c.reflection);
    L.push('');
  }

  return L.join('\n').trim();
}

/**
 * 教案标题兜底：会话列表要显示标题，生成失败时用老师最初那句话截断。
 */
export function fallbackTitle(seedInput) {
  const s = String(seedInput || '').replace(/\s+/g, ' ').trim();
  return s.length > 24 ? `${s.slice(0, 24)}…` : s || '未命名教案';
}

/** 让文本模型给图片描述（system-prompts.md 第 3 节），供豆包使用 */
export async function buildImagePrompt({ lessonTitle, ageGroup, sectionName, note, system }) {
  const { text } = await chat({
    system,
    messages: [
      {
        role: 'user',
        content: `教案：${lessonTitle}\n年龄班：${ageGroup}\n环节：${sectionName || '活动过程'}\n老师希望看到的场景：${note || '孩子在做这个活动'}`,
      },
    ],
    temperature: 0.6,
    maxTokens: 300,
    purpose: 'image_prompt',
  });
  return text.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 800);
}
