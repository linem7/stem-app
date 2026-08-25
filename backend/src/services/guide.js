/**
 * 《3-6岁儿童学习与发展指南》的结构化条目（2026-08-24 用户提供 guide.json）。
 *
 * 【为什么要有这个文件】
 * 在这之前，教案里那一栏《指南》指标是**模型凭记忆写的**，提示词里只有一句
 * 「《指南》领域指标：N 个，只选教学实例里确实体现的」，没有任何原文或清单，
 * 而硬校验只查**数量**（1-2 / 2-3 / 3-4 个），一个字都不查内容。
 *
 * 抽样 8 份真实教案的结果（2026-08-23 查的）：
 *   · 「数学领域：…」—— 🔴 《指南》**没有数学领域**（五大领域是健康/语言/社会/科学/艺术，
 *     数学认知是科学领域下的子领域）。这是专业人士一眼能挑出来的硬错误
 *   · 「科学领域：能通过观察、比较、操作，发现磁铁的特性」—— 编的，
 *     《指南》不会提「磁铁」这种具体材料，这是把活动内容缝进了指标里
 *   · 「对感兴趣的事物能仔细观察，发现其明显特征」在 8 份里出现 7 次，
 *     跨小/中/大班 —— 那条其实是 3-4 岁的典型表现，被套到了大班
 *   · 同一个字段五种写法：`科学：` / `科学领域：` / `《指南》科学领域：` / 带全名 / 无前缀
 *
 * 这一栏挂着一个**权威文件的名字**，老师拿教案去交、去评审。写错比不写更糟：
 * 不写只是不完整，写错是引用错误，而这恰恰是「看起来最专业」的一栏，
 * 她最不会去质疑它。
 *
 * 【这不违反「不做全文 RAG」那条决策】
 * 入库的是**领域 → 子领域 → 目标 → 该年龄段典型表现**的条目结构（5/11/32/97），
 * 属于 CLAUDE.md 里说的「框架提炼」。原书 PDF 照旧不入库。
 *
 * 【为什么放代码里而不是数据库】
 * 它是静态参考数据，不随运营变化、不需要后台改，随版本走最简单。
 * 100KB，启动时读一次常驻内存 —— 解析不到 5ms。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

/**
 * 🔴 年龄班 → `b` 数组的下标。
 *
 * 原书每个目标下按 **3-4岁 / 4-5岁 / 5-6岁** 三档给「典型表现」，
 * guide.json 的 `b` 数组正是这三档，顺序一致。
 *
 * ⚠️ 有一个目标（健康·具有健康的体态）的 `b` 有**第 4 条**，那是脚注
 * （「数据来源：《2006年世界卫生组织儿童生长标准》」），不是第四个年龄段 ——
 * 所以这里只按下标取 0/1/2，多出来的天然被忽略。别改成遍历整个数组。
 */
const AGE_INDEX = { 小班: 0, 中班: 1, 大班: 2 };

/** 领域名去掉「一、」「四、」这类序号。⚠️ 子领域的「（一）」**保留** —— 用户要的位置格式里有它 */
const stripOrder = (s) => String(s || '').replace(/^[一二三四五六七八九十]+、\s*/, '').trim();
/** 「目标1  具有健康的体态」→ 中间的多个空格收成一个 */
const normGoal = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * 把一档典型表现拆成单句。
 *
 * 原文是「1. xxx 2. yyy 3. zzz」这种带序号的一整段。
 * ⚠️ 只认**行首或空格/分号之后**的「数字+点」当序号 —— 直接按 `\d+[.．]` 拆会把
 * 「身高：94.9-111.7厘米」拆成两半（健康领域那条身高体重的原文里全是这种数字）。
 * 拆完丢掉长度 < 6 的碎片。
 */
const splitBehaviors = (s) => String(s || '')
  .split(/(?:^|[\s；;])\d+[.．、]\s*/)
  .map((x) => x.trim())
  .filter((x) => x.length >= 6);

let CACHE = null;

/**
 * 读一次，扁平成条目数组。读不到就返回空数组 ——
 * 指南读不出来不该让教案生成整个瘫掉，那时退回「模型自己写指标」的老行为
 * （质量差，但有教案），并在日志里留一行。
 */
function load() {
  if (CACHE) return CACHE;
  try {
    const path = fileURLToPath(new URL('../data/guide.json', import.meta.url));
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const items = [];
    for (const domain of raw) {
      for (const sub of domain.a || []) {
        for (const goal of sub.g || []) {
          const t = normGoal(goal.t);
          items.push({
            domain: stripOrder(domain.n),
            sub: String(sub.n || '').trim(),      // 带「（一）」
            goalNo: (t.match(/^目标\d+/) || ['目标'])[0],   // 「目标1」
            goalName: t.replace(/^目标\d+\s*/, ''),          // 「亲近自然，喜欢探究」
            // 三个年龄段各自的典型表现，每档再拆成单句
            behaviors: (goal.b || []).slice(0, 3).map((b) => splitBehaviors(b)),
          });
        }
      }
    }
    CACHE = items;
    logger.info('guide_loaded', { goals: items.length, domains: raw.length });
    return CACHE;
  } catch (err) {
    logger.warn('guide_load_failed', { message: err.message });
    CACHE = [];
    return CACHE;
  }
}

/**
 * 这个年龄班能选的全部条目 —— **一句典型表现算一条**（2026-08-24 改）。
 *
 * 为什么从「目标级」改成「句级」：原来让模型引用目标名（「目标2 具有初步的探究能力」），
 * 而**目标名是三个年龄段共用的** —— 输出里看不出这条对应哪一档，
 * 用户实测就看到了「指南的结果来自另外一个年龄段」。
 * 换成引用具体那一句之后，年龄段隐含在句子里（每档文字不同），
 * 抄错档的句子在本档清单里找不到，自动被剔除。
 *
 * label 是用户点名要的格式（2026-08-24 原话举的例）：
 *   `科学 （一）科学探究 目标1：喜欢接触新事物，经常问一些与新事物有关的问题。`
 * 带完整位置，老师能在原书里精确翻到那一句。
 */
export function listIndicators(ageGroup) {
  const idx = AGE_INDEX[ageGroup] ?? AGE_INDEX.中班;
  const out = [];
  for (const it of load()) {
    const sentences = it.behaviors[idx] || it.behaviors[it.behaviors.length - 1] || [];
    for (const s of sentences) {
      out.push({
        domain: it.domain,
        sub: it.sub,
        goalNo: it.goalNo,
        goalName: it.goalName,
        behavior: s,
        label: `${it.domain} ${it.sub} ${it.goalNo}：${s}`,
      });
    }
  }
  return out;
}

/**
 * 注入提示词的清单文本。
 *
 * 🔴 **按年龄班只给该档典型表现**，不是把整份 JSON 塞进去：
 * 整份是 100KB ≈ 5 万 token，筛完约 3000 字符 ≈ 1500 token，差 30 倍。
 * 典型表现给它看是为了判断「这个活动是不是真体现了这条目标」，
 * 所以每条截到 80 字（身高体重那条原文有 100 多字，全给没意义）。
 */
export function buildGoalCatalog(ageGroup) {
  const items = listIndicators(ageGroup);
  if (!items.length) return '';
  /* 按「领域 子领域 目标」分组列出，组头带目标名（帮模型判断这条目标讲的是什么），
     组内一行一句典型表现。分组是为了省 token：不分组的话每一句都要重复一遍
     完整位置，106 句就是 106 遍。 */
  const groups = new Map();
  for (const it of items) {
    const head = `${it.domain} ${it.sub} ${it.goalNo} ${it.goalName}`;
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(it.behavior);
  }
  const body = [...groups.entries()]
    .map(([head, list]) => `${head}\n${list.map((s) => `  · ${s}`).join('\n')}`)
    .join('\n');

  /* 🔴 示例句从**本档清单**里取，不许硬编码。
     原来写死的是「喜欢接触新事物…」——4-5 岁（中班）那一档的句子，却三个班都发，
     而它紧挨着的上一行正写着「只能从这里选，不许自己写」。示例是模型最容易照抄的位置，
     小班/大班照抄的那条在本档清单里匹配不上，会被 enforceAgeBand 剔除 ——
     表现是那份教案白少一条指标，而老师看不出少了什么。
     兜底取最短的一条，别用 items[0]：那是健康领域「身高和体重适宜。参考标准：男孩…」，
     100 多字，拿来当示例会把模型往长句带。 */
  const sample =
    items.find((i) => i.sub.includes('科学探究') && i.goalNo === '目标1') ||
    items.reduce((a, b) => (b.label.length < a.label.length ? b : a), items[0]);

  return `【《指南》指标清单 —— 只能从这里选，不许自己写】
下面是《3-6岁儿童学习与发展指南》里**${ageGroup}这一档**的全部 ${items.length} 条典型表现，
按「领域 子领域 目标」分组。⚠️ 别的年龄段的表现不在这里，也不许用。

${body}

写指标时按这个格式，**位置照抄、那一句也照抄，一个字都不要改**：
  领域 （X）子领域 目标N：那一句典型表现
例：${sample.label}

🔴 不要加书名号、不要写年龄段、不要把活动内容（材料名、现象名）缝进去、
不要自己改写措辞。选不出确实体现的就少写一条 —— 宁可少一条，也不要编一条。`;
}

/**
 * 校验一条生成出来的指标能不能对上清单。
 *
 * 模型即使被要求照抄也会加前缀（「《指南》科学领域：…」）或丢掉子领域，
 * 所以这里做**宽松匹配**：认「目标X + 目标名」那一段，它是清单里最稳定的部分。
 * 匹配到就返回规范化后的 label（顺带把五种写法统一成一种）。
 */
export function matchGoal(text, ageGroup) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const items = listIndicators(ageGroup);
  // ① 整行就是清单里那一行
  const exact = items.find((g) => raw === g.label);
  if (exact) return exact.label;

  /* ② **按典型表现那一句认**（这是主路径）。
     模型即使被要求照抄也会自己加前缀（「《指南》科学领域：…」）、
     丢掉子领域序号、或者把「目标1」写成「目标一」——
     而那一句本身是最稳定的部分，认它最可靠。
     认出来之后返回**规范 label**，顺带把各种写法收成一种。

     去标点也去序号：清单里的句子已经拆过序号了，但模型有时会带回「1.」。
     ⚠️ 不比对目标名 —— 目标名三个年龄段共用，拿它匹配等于放过
     「抄了别档句子」的情况，而那正是这次要修的毛病。 */
  const squash = (s) => s.replace(/[\s，。、：:；;（）()「」《》""''·|0-9０-９.．]/g, '');
  const flat = squash(raw);
  if (flat.length < 8) return null;   // 太短的片段没法可靠匹配，宁可剔除
  const hit = items.find((g) => {
    const seg = squash(g.behavior);
    if (seg.length < 8) return false;
    // 双向包含：模型可能只抄了半句，也可能在句子外面加了一圈前缀
    return flat.includes(seg) || seg.includes(flat);
  });
  return hit ? hit.label : null;
}

/** 有没有加载成功。提示词那边据此决定要不要注入清单 */
export function guideReady() {
  return load().length > 0;
}
