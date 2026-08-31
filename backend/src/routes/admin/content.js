import { Router } from 'express';
import { query, queryOne } from '../../db/pool.js';
import { ok, asyncRoute, notFound } from '../../utils/errors.js';
import { requireSuper } from './_shared.js';

export const contentRouter = Router();

// ---------------------------------------------------------------
// 内容与反馈
// ---------------------------------------------------------------
/**
 * 把一串消息卷成**问答对**（2026-08-22 用户提）。
 *
 * 原来这一屏是把 messages 原样铺成 JSON：一条 assistant（题目）、
 * 一条 user（答案），各自带完整 payload —— 而 assistant 的 payload 里
 * 装着那道题的**全部推荐选项**（四个 label + sub），
 * 于是一份四题的教案能滚出两百多行，而真正要看的
 * 「问了什么 / 她答了什么」被埋在里面。用户原话：
 * 「呈现了问题但不呈现用户的答案，当前结构太长了」。
 *
 * 现在按 `question_id` 把题和答配成对，选项整个丢掉 ——
 * 选项是当时**给她挑的**，不是她说的；要复盘推荐质量得看别的东西。
 *
 * 2026-08-23 补角色和思考链路（用户：「没有角色，没有思考链路，记录不够完整」）：
 * 键名直接写明是谁（AI问 / 教师答 / 教师说 / AI思考），开头带教师最初那句想法；
 * 生成和每轮重写各留一条（来自 payload.kind='generation' 的消息），
 * AI思考 = null 是「那次没开思考模式」，不是数据丢了。
 * 旧教案没有 generation 消息，初稿/重写键缺席 —— 宁可缺一条，不要凑一条。
 *
 * 🔴 **答不上的题也要留一行（教师答为 null）**，不能因为没答案就把题丢掉：
 * 「这道题她没答」本身是信号（题目看不懂 / 她被叫走了），
 * 而丢掉之后那一屏看起来就像她全答了。
 */
function buildTranscript(msgs, seedInput) {
  const guided = [];
  const rounds = new Map();     // round -> { 轮次, 教师说, AI追问: [] }
  const qIndex = new Map();     // `${round}:${id}` -> 那个问答对象
  let draft = null;             // 初稿那次生成
  const prompts = {};           // 每次生成用的提示词原文

  const roundOf = (n) => {
    if (!rounds.has(n)) rounds.set(n, { 轮次: n, 教师说: null, AI追问: [] });
    return rounds.get(n);
  };

  for (const m of msgs) {
    const p = m.payload || {};
    if (m.role === 'assistant') {
      if (p.kind === 'generation') {
        const gen = { 版本: p.version ?? null, AI思考: p.reasoning || null };
        /* 提示词收在最外层的一个键里，不塞进 gen（2026-08-23）：
           一份提示词约 5KB，塞在「初稿」里会把后面的改稿轮次推到几百行之后 ——
           而这一屏最常看的是「她说了什么、AI 问了什么」。
           流程在前、原始材料在后。 */
        if (p.prompt_system || p.prompt_user) {
          prompts[p.round ? `重写第${p.round}轮` : '初稿'] = {
            系统提示词: p.prompt_system || null,
            用户提示词: p.prompt_user || null,
          };
        }
        // round 为空 = 初稿；有 round = 那一轮改稿的重写
        if (p.round) roundOf(p.round).重写 = gen;
        else draft = gen;
        continue;
      }
      const pair = { AI问: m.content || p.title || null, 教师答: null };
      if (p.kind === 'revise_question') {
        roundOf(p.round).AI追问.push(pair);
        qIndex.set(`${p.round}:${p.id}`, pair);
      } else {
        guided.push(pair);
        qIndex.set(`0:${p.id}`, pair);
      }
      continue;
    }
    if (m.role !== 'user') continue;
    if (p.kind === 'revise_feedback') { roundOf(p.round).教师说 = m.content || null; continue; }
    const key = p.kind === 'revise_answer' ? `${p.round}:${p.question_id}` : `0:${p.question_id}`;
    const pair = qIndex.get(key);
    // 配不上的答案（题被删过、或者历史数据）单独留一行，别静默丢掉
    if (pair) pair.教师答 = m.content || null;
    else if (p.kind === 'revise_answer') roundOf(p.round).AI追问.push({ AI问: null, 教师答: m.content || null });
    else guided.push({ AI问: null, 教师答: m.content || null });
  }

  const out = {};
  if (seedInput) out.教师的想法 = seedInput;
  if (guided.length) out.引导 = guided;
  if (draft) out.初稿 = draft;
  const rs = [...rounds.values()].sort((a, b) => a.轮次 - b.轮次);
  if (rs.length) out.改稿 = rs;
  // **提示词放最后**：它是这一屏里最长的东西，但也是回答「这份教案凭什么长成这样」
  // 唯一的材料。旧教案没有（那时候没存），键缺席 —— 宁可缺一条，不要凑一条
  if (Object.keys(prompts).length) out.AI提示词 = prompts;
  return out;
}

/**
 * 教案正文和对话记录 —— **只有超管**。
 * 这是老师写的东西，运营工作（建码、看反馈）根本用不到。
 *
 * `?version=2` 看历史版本（2026-08-18 加）。为什么要按版本看：
 * 老师标「用不了」是标在**某一个版本**上的（feedback 绑 plan_version），
 * 而 lesson_plans 那一行只存当前内容 —— 她改过之后，
 * 当前内容已经不是她当初评价的那一份了。看错版本等于看错了证据。
 */
contentRouter.get('/plans/:id', requireSuper, asyncRoute(async (req, res) => {
  const planId = Number(req.params.id);
  const p = await queryOne(
    `SELECT p.*, t.real_name, k.name AS kindergarten
       FROM lesson_plans p
       JOIN teachers t ON t.id = p.teacher_id
       LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
      WHERE p.id = $1`, [planId]);
  if (!p) throw notFound('没有这份教案');

  const versions = (await query(
    `SELECT version, revise_note, created_at FROM lesson_plan_versions
      WHERE lesson_plan_id = $1 ORDER BY version`, [planId])).rows;

  // 要看哪一版。不传 = 当前内容（lesson_plans 那一行）
  const want = req.query.version ? Number(req.query.version) : null;
  let shown = p;
  let shownVersion = p.current_version ?? p.version;
  if (want) {
    const snap = await queryOne(
      `SELECT * FROM lesson_plan_versions WHERE lesson_plan_id = $1 AND version = $2`,
      [planId, want]);
    if (!snap) throw notFound(`这份教案没有第 ${want} 版`);
    // 用快照覆盖内容字段，但**保留身份字段**（谁写的、哪个园）——
    // 那些不在版本快照里，它们不随版本变
    shown = { ...p, title: snap.title, age_group: snap.age_group,
      duration_min: snap.duration_min, content_md: snap.content_md,
      content_json: snap.content_json, quality_self: snap.quality_self };
    shownVersion = snap.version;
  }

  // 对话记录**给结构化数组**，界面上以 JSON 呈现（2026-08-18 用户定）：
  // 这一屏的用处是拿去做研究分析，一个能整块选中复制的 JSON 比排好的表更有用。
  // system 那条不在库里（每次实时拼装，见 001_init.sql 的注释），所以本来就不会出现
  const msgs = (await query(
    `SELECT role, content, payload, created_at FROM messages
      WHERE conversation_id = $1 ORDER BY id`, [p.conversation_id])).rows;
  // 教师最初那句想法在 conversations 上，不在 messages 里 ——
  // 它是整场对话的起点，对话记录缺了它就是从半截开始讲的
  const seed = await queryOne(
    `SELECT seed_input FROM conversations WHERE id = $1`, [p.conversation_id]);

  return ok(res, {
    plan: shown,
    shown_version: shownVersion,
    versions,
    // 界面用 transcript（问答对）。`messages` **保留原样下发** ——
    // 它是这份对话的原始记录，研究要拿去做分析时不该只剩我卷过的那一份；
    // 而且回归脚本读着它
    transcript: buildTranscript(msgs, seed?.seed_input || null),
    messages: msgs,
  });
}));

contentRouter.get('/feedback', asyncRoute(async (req, res) => {
  const kind = String(req.query.kind || 'all');
  const where = kind === 'all' ? '' : `WHERE f.kind = '${kind === 'lesson_rating' ? 'lesson_rating' : 'suggestion'}'`;
  const rows = (await query(`
    SELECT f.*, t.real_name, k.name AS kindergarten, p.title AS plan_title, p.age_group
      FROM feedback f
      JOIN teachers t ON t.id = f.teacher_id
      LEFT JOIN kindergartens k ON k.id = t.kindergarten_id
      LEFT JOIN lesson_plans p ON p.id = f.lesson_plan_id
    ${where}
     ORDER BY f.created_at DESC LIMIT 200`)).rows;
  return ok(res, { items: rows });
}));

contentRouter.post('/feedback/:id/handled', asyncRoute(async (req, res) => {
  const row = await queryOne(
    `UPDATE feedback SET handled = $1 WHERE id = $2 RETURNING id, handled`,
    [req.body?.handled !== false, Number(req.params.id)]);
  if (!row) throw notFound('没有这条反馈');
  return ok(res, row);
}));
