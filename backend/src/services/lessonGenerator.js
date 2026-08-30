/**
 * 教案生成 + 自检 + （学习模式的）教案解读。
 *
 * 模型调用两次，学习模式三次：
 *   第一次：生成结构化教案（要求返回 JSON，便于分节编辑）
 *   第二次：自检（8 个质量维度 + 年龄班越界检查）
 *   第三次：教案解读（**只有学习模式**，见 api-spec 第 5 节）
 * 中间夹一层代码层的年龄班硬校验（promptBuilder.enforceAgeBand）。
 *
 * 后两次**都是 try/catch，失败只记日志**。这不是偷懒，是定死的规矩：
 * 老师等的是教案，自检是给我们看的、解读是加分项，
 * 任何一个把「拿不到教案」当作失败结果的写法都是错的。
 *
 * 为什么要 JSON 而不是直接要 Markdown：
 * db-schema.md 要求同时存 md 和 json，且「编辑时以 json 为准，md 由 json 渲染」。
 * 所以生成时就只产出 json 一份真相，md 由 renderMarkdown 渲染 —— 两份永远不会漂移。
 */
import { chatJSON, chat } from './textChat.js';
import {
  buildLessonSystemPrompt,
  buildCollectedBlock,
  getAgeBand,
  enforceAgeBand,
} from './promptBuilder.js';
import { isLearning, buildCommentaryUserPrompt, normalizeCommentary } from './learningMode.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/* PROGRESS_HINTS（'正在梳理你的想法…' 那四句）**2026-08-25 删掉了**。
   它是「编出来的进度」：四句文案按代码走到哪一行推进，跟模型真的写到哪没关系。
   现在老师看到的是**正文本身**一个字一个字长出来（onStream），
   进度只剩三个真实阶段：thinking / writing / checking。
   ⚠️ 别照旧稿把它加回来 —— 一屏上同时摆真进度和假进度，假的那份迟早说反话。 */

/**
 * 要模型返回的形状 —— **中国大陆幼儿园常见的教案格式**（2026-08-20 改版）。
 * 结构的来由和每个字段的取舍见 docs/design/lesson-structure-and-modes.md。
 *
 * 已经删掉的两样，别照旧稿加回来：
 *   `features`   —— 两个子字段各自搬去了 intent / objectives
 *   `reflection` —— 「预期与实际的差异」在活动开始前只能是编的
 */
/* 🔴 `duration_min` 必须插值，不许写死 30。
   这段结构拼在 user prompt 的最末尾，是模型出稿前看到的**最后一个数字** ——
   写死 30 等于给小班（20 分钟）和中班（25 分钟）递了一个错的锚点，
   比年龄班规则块里那句时长矛盾离「模型写出 30 分钟」更近。 */
const jsonShape = (durationTarget) => `{
  "title": "活动名称，动词+对象的形式，不超过 20 字",
  "duration_min": ${durationTarget},
  "intent": "设计意图：为什么设计这个活动、想解决孩子什么问题。两三句话，写活动之前的判断，不要写事后语气",
  "objectives": [
    { "dimension": "认知", "text": "孩子会知道或理解什么" },
    { "dimension": "能力", "text": "孩子会做到什么（动作必须是这个年龄班真做得到的）" },
    { "dimension": "情感", "text": "孩子会愿意或乐于什么" }
  ],
  "key_points": {
    "focus": "活动重点：这次最要紧的那件事，一句话",
    "difficulty": "活动难点：孩子最容易卡住的地方，一句话"
  },
  "preparation": {
    "experience": ["经验准备：孩子在这次活动之前得先有什么经验"],
    "material": ["物质准备：材料清单，每项写清数量或规格；场地怎么布置也写在这里"]
  },
  "flow": [
    { "stage": "导入", "minutes": 5, "detail": "这个环节老师具体做什么、说什么、孩子在干什么。要写得能照着上，不要写空话" }
  ],
  "extension": "活动延伸，一段话，具体到区角怎么放、家里怎么做",
  "safety": ["安全提示，每条具体可执行"],
  "steam": {
    "S": "科学：这次活动里具体是什么现象或特性",
    "T": "技术：具体用什么工具、什么技巧",
    "E": "工程：具体改进了什么、优化了什么",
    "A": "艺术：具体的美感或创意表现",
    "M": "数学：具体的比较、测量或数量经验"
  },
  "indicators": ["《指南》领域指标，只写教学实例里确实体现出来的"],
  "dialogue": [
    { "speaker": "T", "text": "老师说的话" },
    { "speaker": "C", "text": "孩子说的话" }
  ]
}`;

/**
 * 生成一份教案。
 *
 * @param {object} o
 * @param {object} o.conversation  conversations 行
 * @param {object} o.teacher       teachers 行
 * @param {Array}  o.memories      teacher_memories 行
 * @param {Array}  [o.qaHistory]   [{question, answer}] 引导过程的问答，供模型理解上下文
 * @param {Function} [o.onPhase]   (phase) => void，'thinking' | 'checking'。
 *   'writing' 不在这里发 —— 那一步的判据是「模型吐出第一个字」，由 onStream 那边认
 * @param {Function} [o.onStream]  (chunk, {restart}) => void，模型每吐一小段就调一次。
 *   老师那一屏靠它看见正文长出来（2026-08-25）
 * @returns {Promise<{title,age_group,duration_min,content_json,content_md,quality_self,tokenIn,tokenOut}>}
 */
export async function generateLessonPlan({
  conversation, teacher, memories, qaHistory = [], onPhase = () => {}, onStream,
}) {
  // 模式挂在会话上（017 迁移）。这里不 resolveMode ——
  // 值是开会话时收敛过才落库的，重新收敛一遍只会掩盖「库里怎么会有乱值」这个问题
  const learning = isLearning(conversation.mode);
  const collected = conversation.collected || {};
  const ageGroup = collected.age_group || conversation.age_group || teacher?.age_group || '中班';
  const band = getAgeBand(ageGroup);

  onPhase('thinking');

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
${jsonShape(durationTarget)}`;

  const { data, reasoning, tokenIn, tokenOut } = await chatJSON({
    system,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.7,
    /* 8000 不是 4000（2026-08-23 上调）。4000 是按 deepseek-chat 的输出长度定的，
       而换成 deepseek-v4-flash 之后一份完整教案要 4000 以上 —— 每次都顶到
       3999 截断、JSON 解析失败，表现是「这次没生成成功」而重试永远不会好。
       max_tokens 只是上限，给大了不多花钱（按实际输出计费）。
       真被截断时 textChat 还会加倍重试一次，那是兜底，不该常态依赖。 */
    maxTokens: 8000,
    // 整份教案比出题慢得多，超时单独放宽到 3 分钟
    timeoutMs: 180000,
    purpose: 'lesson_generate',
    // 这是最贵的一次调用 —— 在 model_calls 之前它一分钱都没被记下来
    teacherId: teacher?.id ?? null,
    // 「思考/联网」开关只作用于这次和解读那次 —— 管理员开思考的本意是
    // 「教案写得更好」，胶水调用（回应/自检/翻译）跟着开只有慢和贵
    applyToggles: true,
    /* 🔴 **只有这一次调用值得为「被截断」重来一次。**
       教案是老师唯一真正要的东西，缺一半等于没有；而自检、解读、每题回应
       都有兜底（失败只记日志或用中性句），为它们重试只是让老师多等。 */
    retryOnTruncate: true,
    /* 🔴 **八次文本调用里只有这一次开流式**（2026-08-25）。
       老师那一屏等的就是这份教案，让她看着它长出来；
       出题回应、自检、解读、翻译、记忆提取没有任何人在看，
       给它们开流式只是各自多一条更容易出错的代码路径。 */
    onStream,
  });

  const contentJson = normalizePlan(data, ageGroup, durationTarget);

  onPhase('checking');

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

  /* 模型自检（8 维度）——**不 await，不挡出稿**（2026-08-24）。
     它的产出只进 quality_self 给内测分析用，**老师一个字都看不到**
     （成稿页那个「模型自检」入口 08-22 就撤了），而它实测要 3 秒 ——
     那 3 秒是白让老师等的。
     现在它跟教案解读并行跑（解读是学习模式老师真要看的，仍然 await），
     算完之后由 generate.js 事后回填进 lesson_plans.quality_self。

     ⚠️ 这里就得 catch 掉：promise 漏出去 reject 会变成 unhandled rejection。
     失败就是 null，跟「没跑」由 model_pending 区分。 */
  const selfCheckTask = selfCheck(contentJson, ageGroup, system, teacher?.id ?? null)
    .catch((err) => {
      logger.warn('self_check_failed', { conversation_id: conversation.id, code: err?.code });
      return null;
    });

  /*
    教案解读 —— 学习模式才有（api-spec 第 5 节）。

    【为什么是单独一次调用，不塞进生成那一次】
    生成那次已经是最贵最慢的（maxTokens 4000、超时 3 分钟）。再往里塞一千多字解读，
    挤占的是教案本身的质量 —— 而教案是她真正要的东西。
    分开还白得两样好处：解读**看得到已经写完的教案**（解释的是真产出，
    不是在生成的同时预测自己会写什么），以及解读挂了不影响出稿。

    ⚠️ 放在 enforceAgeBand **之后**：硬校验会自动收敛超时长之类的问题，
    放在它前面，解读讲的就是一份已经被改过的教案，对不上号。
  */
  let commentary = null;
  if (learning) {
    try {
      commentary = await buildCommentary(contentJson, ageGroup, system, teacher?.id ?? null);
      if (commentary) contentJson.commentary = commentary;
    } catch (err) {
      // 学习模式的老师拿到的会是一份没有解读的教案。比拿不到教案好得多。
      logger.warn('commentary_failed', { conversation_id: conversation.id, code: err?.code });
    }
  }

  const qualitySelf = {
    checked_at: new Date().toISOString(),
    age_group: ageGroup,
    age_band_violations: violations, // 代码查出来的越界（这几条最要紧）
    age_band_auto_fixed: fixed, // 代码自动纠正掉的
    /* 模型的 8 维度打分 —— 出稿时它还没算完（见上面 selfCheckTask），
       由 generate.js 事后回填。`model_pending: true` 是**必须有的**：
       没有它，「自检还在跑」和「自检失败了」在库里长得一模一样，
       而「有多少比例的自检真的成了」正是要用这个字段回答的问题。 */
    model: null,
    model_pending: true,
    /*
      学习模式下这份教案的解读写成了没有、写了哪几个板块。
      记这个是因为它的失败**完全没有声音**：老师看到一份没有「为什么这样设计」的
      教案，只会以为这个模式就是这样。不留痕的话，
      「学习模式的解读到底有多少比例真的写出来了」这个问题以后没法回答。
      效率模式下是 null（不是空数组）—— 区分「没写成」和「压根不该有」。
    */
    commentary_keys: learning ? Object.keys(commentary || {}) : null,
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
    // 生成这次调用的思考链路（模型没开思考模式时是 null）。
    // 落进 messages 的 generation 消息，后台「查看正文」的对话记录里能看到
    reasoning: reasoning ?? null,
    /* 这次用的提示词原文（2026-08-23 用户提「对话记录同时涵盖提示词的部分」）。
       system 是每次实时拼装的（框架 + 年龄班规则 + 档案 + 记忆 + 改稿历史），
       user 带着她的想法、引导问答和那 8 条生成要求 —— 两样都不在别处存着。

       ⚠️ 001_init.sql 里那句「system 消息不入库：存了会大量重复，
       且改了提示词后旧记录会失真」的后半截**现在正好是要它的理由**：
       想知道「这份教案当时是用什么提示词生成的」，就得存当时那一份。
       前半截（重复）是真代价：一次生成约 5KB，落在 generation 消息的 payload 里。 */
    prompt: { system, user: userPrompt },
    /* 自检那个还在跑的 promise。generate.js 存完库拿到 id 之后 .then 回填 ——
       调用方**不要 await 它**，那就把刚省下来的 3 秒又等回去了。
       它已经 catch 过，永远 resolve（失败是 null）。 */
    selfCheckTask,
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
      /* 说话人认宽一点。原来只认严格等于 'C'，模型写「幼儿」「C（幼儿）」一律被**静默**转成 T ——
         结果是一份「孩子一句话都没说」的对话看起来完全正常，
         而「呈现幼儿的思维过程」正是这一节存在的全部理由。 */
      return { speaker: /^\s*[cC]\b|幼儿|孩子|儿童/.test(String(d?.speaker ?? '')) ? 'C' : 'T', text: str(d?.text) };
    })
    .filter((d) => d.text);

  const title = str(raw.title).slice(0, 60) || '未命名教案';
  const duration =
    Number.isFinite(Number(raw.duration_min)) && Number(raw.duration_min) > 0
      ? Number(raw.duration_min)
      : durationTarget;

  /*
    活动目标要收敛成 [{dimension, text}]。模型有三种写法都见得到：
      · 已经是对象数组（想要的）
      · 纯字符串数组 ["知道…","能…","愿意…"]
      · 带前缀的字符串 "【认知】知道…" 或 "认知：知道…"
    后两种要把维度认出来 —— 认不出来就留空，让 enforceAgeBand 报出来，
    **不要瞎猜一个维度填上去**：猜错了那条硬校验就永远查不出问题，等于校验空转。
  */
  const DIMS = ['认知', '能力', '情感'];
  const objectives = arr(raw.objectives)
    .map((o) => {
      if (typeof o === 'string') {
        const m = /^\s*[【\[]?(认知|能力|情感)[态度]*[】\]]?\s*[:：]?\s*(.+)$/.exec(o);
        return m ? { dimension: m[1], text: m[2].trim() } : { dimension: '', text: o.trim() };
      }
      const d = str(o?.dimension).replace(/态度|目标/g, '').trim();
      return { dimension: DIMS.includes(d) ? d : '', text: str(o?.text ?? o?.content ?? '') };
    })
    .filter((o) => o.text);

  /*
    物质准备兼容 `materials` 这个旧字段名。
    模型看过的提示词里现在只有 preparation.material，但它偶尔会顺手写回 materials ——
    真发生时如果不接住，出来的教案会是「一份没有材料清单的教案」，
    而那是老师第一眼就要看的东西。
  */
  const material = arr(raw.preparation?.material ?? raw.materials).map(str).filter(Boolean);
  const experience = arr(raw.preparation?.experience).map(str).filter(Boolean);

  /*
    ⚠️ 这里**故意不接 raw.commentary**，即使模型自己写了一个。

    解读是另一次调用的产物，要过 normalizeCommentary 那道白名单才准进 content_json。
    生成那次的提示词从来没提过 commentary，所以它真出现了只能是模型自作主张 ——
    那份内容既没被白名单过滤、也没被截断，直接放进去等于让模型决定界面上出现什么。
    下面返回的是一个显式对象，所以「不接」是天然的；写这段注释是为了防止
    以后有人为了「顺手兼容一下」把它加回来。
  */
  return {
    title,
    age_group: ageGroup,
    duration_min: duration,
    intent: str(raw.intent ?? raw.features?.problem_source),
    objectives,
    key_points: {
      focus: str(raw.key_points?.focus),
      difficulty: str(raw.key_points?.difficulty),
    },
    preparation: { experience, material },
    flow,
    extension: str(raw.extension),
    safety: arr(raw.safety).map(str).filter(Boolean),
    steam,
    indicators: arr(raw.indicators).map(str).filter(Boolean),
    dialogue,
  };
}

/** 模型自检：8 个维度打分 + 指出问题（system-prompts.md「质量检查」） */
async function selfCheck(contentJson, ageGroup, systemPrompt, teacherId = null) {
  const { data } = await chatJSON({
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `下面是你刚生成的教案。请以审稿人的身份自检，诚实打分，不要护短。

${JSON.stringify(contentJson)}

按 8 个质量维度各打 1-5 分（5 分最好），并指出确实存在的问题。
特别检查两件事：
1. 这份教案里有没有【${ageGroup}】孩子做不到的动作？重点看预测、读数、书写、小组分工、集体讨论、长时间专注
2. 三条活动目标是不是**真的**都有对应的环节？尤其那条情感目标 ——
   「愿意分享」这种目标很容易写在纸上、而过程里根本没有让孩子说话的时候

只输出 JSON：
{"scores":{"问题的真实性":4,"探究的循环性":4,"STEAM的融合度":4,"师生对话的真实性":4,"测量与记录":4,"连贯的脉络性":4,"学习指标的对应":4,"目标与过程的对应":4},
 "age_band_fit": true,
 "issues": ["具体问题，没有就给空数组"]}`,
      },
    ],
    temperature: 0.2,
    /* 1600 不是 800（2026-08-23 上调）。8 个维度打分 + 问题列表，800 对
       deepseek-chat 够用，对 v4-flash 实测**每次都截断**（那时它连打三次
       800→1600→3200 全失败，白等 46 秒）—— 于是自检这个功能等于不存在，
       而 quality_self.model 是研究要用的数据。
       ⚠️ 这次调用**串在老师的等待时间上**（await 在生成之后），所以只给到
       一次够用的量，不做截断重试：它失败不影响出稿，不值得让她多等一轮。 */
    maxTokens: 1600,
    timeoutMs: 90000,
    purpose: 'lesson_self_check',
    teacherId,
  });

  return {
    scores: data.scores && typeof data.scores === 'object' ? data.scores : null,
    age_band_fit: data.age_band_fit !== false,
    issues: Array.isArray(data.issues) ? data.issues.map(String).slice(0, 10) : [],
  };
}

/**
 * 教案解读：给各板块挂一段「为什么这样设计」（学习模式，api-spec 第 5 节）。
 *
 * 提示词在 `learningMode.js` —— 学习模式的文案集中在那一个文件，
 * 改措辞不用进这里。这边只管调用和收敛，跟上面 selfCheck 对称。
 *
 * temperature 比生成低（0.7 → 0.45）：这一段是在解释一份**已经定稿**的教案，
 * 要的是说准，不是说得花。但也不能压到 0.2 那么死 ——
 * 全是同一个句式的九段话读起来像表格，她会跳过去不看。
 */
async function buildCommentary(contentJson, ageGroup, systemPrompt, teacherId = null) {
  const { data } = await chatJSON({
    system: systemPrompt,
    messages: [{ role: 'user', content: buildCommentaryUserPrompt(contentJson, ageGroup) }],
    temperature: 0.45,
    maxTokens: 1600,
    timeoutMs: 90000,
    purpose: 'lesson_commentary',
    teacherId,
    // 解读讲的是「为什么这样设计」，思考模式对它是有意义的（同 lesson_generate）
    applyToggles: true,
  });

  return normalizeCommentary(data, Array.isArray(contentJson.flow) ? contentJson.flow.length : 0);
}

/**
 * 由 content_json 渲染 Markdown。
 *
 * 编辑教案时也调这个函数重渲染（PATCH /lesson-plans/:id），
 * 保证 md 永远是 json 的投影，不会两边各改一半。
 *
 * @param {object} plan
 * @param {object} [opts]
 * @param {boolean} [opts.withCommentary=false]  带上学习模式的教案解读
 *
 * 【为什么解读要一个开关，而不是永远带或永远不带】
 *
 * 存进 `lesson_plans.content_md` 的那一份**必须不带**（默认值就是 false）。
 * 那一列是「教案正文」的规范形式：内容安全检查过的是它、
 * 版本快照存的是它、以后比对两版差异读的是它。
 * 把解读混进去，`content_md` 就不再是那份教案，而是教案加旁白。
 *
 * 但**导出的时候要带**（用户 2026-08-21 定）：她导出是为了把东西带走，
 * 解读是这份教案里唯一只存在于屏幕上的部分，不导就等于导不全。
 * 所以开关由调用方给：落库不带，导出带。
 */
export function renderMarkdown(plan, { withCommentary = false } = {}) {
  const c = plan.content_json || {};
  const L = [];
  // 解读只在导出时出现。cm 为空对象时下面每个 why() 都返回空，一行都不会多
  const cm = withCommentary && c.commentary && typeof c.commentary === 'object' ? c.commentary : {};

  /**
   * 一段解读。**排版上要一眼看出这不是教案正文** —— 她可能把导出的东西
   * 直接交上去，混在正文里的旁白会被当成她自己写的话。
   * 用引用块 + 抬头，跟界面上那一行对得上。
   *
   * `head` 只有逐环节那几条要换（'为什么这个环节这么安排'）。
   * 屏幕上环节的解读嵌在那张环节卡里，上下文一目了然；
   * 导出成一份文档之后卡片没了，最后一个环节的解读和「整组为什么是这个顺序」
   * 会紧挨着，两条抬头一样就分不出哪条讲的是整体。
   */
  const pushWhy = (v, head = '为什么这样设计') => {
    if (!v || typeof v !== 'string') return;
    L.push(`> **${head}**：${v.replace(/\n+/g, ' ')}`);
    L.push('');
  };
  const why = (key) => pushWhy(cm[key]);

  L.push(`# ${plan.title || c.title || '未命名教案'}`);
  L.push('');
  L.push(`**年龄班**：${plan.age_group || c.age_group || ''}　　**时长**：${plan.duration_min || c.duration_min || '—'} 分钟`);

  const steamTags = ['S', 'T', 'E', 'A', 'M'].filter((k) => {
    const v = c.steam?.[k];
    return v && !/未涉及|不涉及|^无$/.test(v);
  });
  if (steamTags.length) L.push(`**STEAM 领域**：${steamTags.join(' · ')}`);
  L.push('');

  /*
    板块顺序 = 大陆常见教案格式的顺序（2026-08-20 改版）。
    这个顺序就是以后导出 docx 的顺序 —— 老师是打印出来交给园里的，
    所以正文（设计意图 … 安全提示）必须先出完，特征标注和教学实例排在后面。

    解读（`commentary`）只在 `withCommentary` 为真时出现，也就是**只在导出时**。
    落库那一份不带 —— 理由见这个函数的文档注释。
  */

  if (c.intent) {
    L.push('## 设计意图');
    L.push('');
    L.push(c.intent);
    L.push('');
    why('intent');
  }

  if (c.steam) {
    L.push('## STEAM 五域标注');
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
    why('steam');
  }

  if (c.objectives?.length) {
    L.push('## 活动目标');
    L.push('');
    c.objectives.forEach((o) => {
      const d = o?.dimension ? `**${o.dimension}**　` : '';
      L.push(`- ${d}${o?.text || ''}`);
    });
    L.push('');
    why('objectives');
  }

  if (c.key_points?.focus || c.key_points?.difficulty) {
    L.push('## 活动重点与难点');
    L.push('');
    if (c.key_points.focus) L.push(`**重点**：${c.key_points.focus}`);
    if (c.key_points.focus && c.key_points.difficulty) L.push('');
    if (c.key_points.difficulty) L.push(`**难点**：${c.key_points.difficulty}`);
    L.push('');
    why('key_points');
  }

  const prep = c.preparation || {};
  if (prep.experience?.length || prep.material?.length) {
    L.push('## 活动准备');
    L.push('');
    if (prep.experience?.length) {
      L.push('**经验准备**');
      L.push('');
      prep.experience.forEach((x) => L.push(`- ${x}`));
      L.push('');
    }
    if (prep.material?.length) {
      L.push('**物质准备**');
      L.push('');
      prep.material.forEach((x) => L.push(`- ${x}`));
      L.push('');
    }
    why('preparation');
  }

  if (c.flow?.length) {
    L.push('## 活动过程');
    L.push('');
    c.flow.forEach((s, i) => {
      L.push(`### ${i + 1}. ${s.stage}${s.minutes ? `（${s.minutes} 分钟）` : ''}`);
      L.push('');
      L.push(s.detail);
      L.push('');
      // 逐环节的那一条。下标对齐 flow，取不到就不出现（模型可能只解读了前几个）
      pushWhy(Array.isArray(cm.flow_stages) ? cm.flow_stages[i] : '', '为什么这个环节这么安排');
    });
    // 整组那一条（讲的是「为什么是这个顺序」）排在全部环节之后，跟界面一致
    why('flow');
  }

  if (c.extension) {
    L.push('## 活动延伸');
    L.push('');
    L.push(c.extension);
    L.push('');
    why('extension');
  }

  if (c.safety?.length) {
    L.push('## 安全提示');
    L.push('');
    c.safety.forEach((x) => L.push(`- ${x}`));
    L.push('');
    why('safety');
  }

  // ---- 以下不是教案正文，是特征标注与教学实例 ----

  if (c.indicators?.length) {
    L.push('## 《指南》领域指标');
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
export async function buildImagePrompt({ lessonTitle, ageGroup, sectionName, note, system, teacherId = null }) {
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
    teacherId,
  });
  const clean = text.replace(/^["'\s]+|["'\s]+$/g, '');

  /*
    上限对齐 MiniMax 自己的 1500（见 minimax.js 那行 slice(0, 1500)），不再是 800。
    800 踩过一次大坑：记录表那套强制前缀本身就有 840 字符，于是**每一次**都在
    「no captions, no labels, no handwriti」这里被切断 —— 禁止文字那句话被砍成半句，
    老师要画的东西（描述在最后）整段没了。出来的图顶上印着 "Name ______"、
    配一条动物花边，表格还是随机列数。表面上看像模型不听话，其实提示词根本没发全。

    而且切的时候要切在句号上，不是切在字母中间：半句 "no handwriti" 对模型只是噪音。
    真被切了要留个日志 —— 这种事静悄悄发生一次就够难查了。
  */
  const LIMIT = 1500;
  if (clean.length <= LIMIT) return clean;

  const cut = clean.slice(0, LIMIT);
  const lastStop = cut.lastIndexOf('. ');
  const out = lastStop > LIMIT * 0.6 ? cut.slice(0, lastStop + 1) : cut;
  logger.warn('image_prompt_truncated', { from: clean.length, to: out.length });
  return out;
}
