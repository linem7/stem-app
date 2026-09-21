/**
 * 教案 → .docx（2026-09-21 新增）。
 *
 * 【为什么是真 .docx，不是 HTML 改名成 .doc】
 * 用户 2026-09-21 定：老师拿到导出件之后**要自己再改** ——
 * 加园所抬头、改班级名、调字号。PDF 改不了，而「HTML 存成 .doc」
 * 会让她每次打开都看到一句「文件格式与扩展名不符」的警告，
 * 手机上还可能直接打不开。所以用 `docx` 这个库真拼 OOXML。
 *
 * 【为什么单独一个文件】
 * 拼 OOXML 的代码跟「取教案、查图、发响应」是两件事。混在路由里的话，
 * 那个路由会长到看不清哪一段是「业务」哪一段是「排版」，
 * 而排版这部分**是要反复调的**（她要打印出来看）。
 *
 * 【正文的八节从哪来】
 * `content_json` 的 13 个键（见 `docs/design/lesson-structure-and-modes.md`）：
 *
 *   title          教案名
 *   intent         设计意图      ┐
 *   objectives     活动目标（三维各一条）  │
 *   key_points     活动重点难点  │ 正文八节
 *   preparation    活动准备（经验/物质）   │
 *   flow           活动过程（导入/展开/…） │
 *   extension      活动延伸      │
 *   safety         安全提示      ┘
 *   steam          STEAM 标注（五域）
 *   indicators     《指南》指标
 *   dialogue       教学实例（师幼对话）
 *   age_group      年龄班
 *   duration_min   时长（分钟）
 *
 * ⚠️ **`commentary` 不导出**（各板块底下那行「为什么这样设计」）。
 * 用户 2026-08-21 定过，理由写在 `lessonPlans.js` 的导出路由里 ——
 * 那是给她看的旁白，不是教案内容，老师拿它去交园所是不合适的。
 *
 * 🔴 **注意别把「设计意图」和「教案解读」混了**：前者是 `intent`，
 * 正文第一节，**一直都在导出里**；后者是 `commentary`，不导出。
 * 这两样 2026-08-21 已经因为同一个词来回改过一次。
 */
import {
  AlignmentType, Document, HeadingLevel, ImageRun, Packer,
  Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { logger } from '../utils/logger.js';

/* 中文字体。`docx` 的 `font` 只在西文那半边生效，中文要走 `eastAsia` ——
   不写的话 Word 会用默认宋体渲染中文，跟西文混在一起看着很别扭。 */
const FONT = { ascii: 'Calibri', eastAsia: '微软雅黑', hAnsi: 'Calibri' };

const SIZE = {
  title: 32, // 半磅：32 = 16pt
  h2: 26,
  body: 22, // 11pt，正文
};

/** 一节小标题 + 正文 */
function heading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 260, after: 100 },
    children: [new TextRun({ text, bold: true, size: SIZE.h2, font: FONT })],
  });
}

/** 一段正文。`indent` 用来把「（一）经验准备」这种子项缩进去 */
function para(text, { indent = 0, bullet = false } = {}) {
  return new Paragraph({
    spacing: { after: 80, line: 320 },
    indent: indent ? { left: indent * 400 } : undefined,
    bullet: bullet ? { level: 0 } : undefined,
    children: [new TextRun({ text: String(text ?? ''), size: SIZE.body, font: FONT })],
  });
}

export async function buildLessonDocx({ plan, content, images }) {
  const c = content || {};
  const children = [];

  // ——— 标题 ———
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 60 },
    children: [new TextRun({ text: c.title || '教案', bold: true, size: SIZE.title, font: FONT })],
  }));

  /* 年龄班 + 时长。这是**她最需要在纸上看清的两项** ——
     园所检查教案时常问这两个，而且它们决定这份教案能不能给这个班用 */
  const meta = [c.age_group, c.duration_min ? `${c.duration_min} 分钟` : null]
    .filter(Boolean).join('　·　');
  if (meta) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text: meta, size: SIZE.body, color: '666666', font: FONT })],
    }));
  }

  // ——— 一、设计意图 ———
  if (c.intent) {
    children.push(heading('一、设计意图'));
    children.push(para(c.intent));
  }

  // ——— 二、活动目标 ———
  if (Array.isArray(c.objectives) && c.objectives.length) {
    children.push(heading('二、活动目标'));
    for (const o of c.objectives) {
      /* 三维各一条。**把「认知/能力/情感」写在前面** ——
         园所检查时看的就是这三条齐不齐，混在一段里她要自己找 */
      const label = o.dimension ? `${o.dimension}：` : '';
      children.push(para(`${label}${o.text || ''}`, { bullet: true }));
    }
  }

  // ——— 三、活动重点难点 ———
  //
  // ⚠️ 字段名是 `focus` / `difficulty`，**不是** `key` / `difficult`。
  // 第一版我按工具栏那套写的，结果是这一节整节不见了 ——
  // 而它不报错，只是标题和内容都不出现，看起来像「这份教案本来就没有」。
  // 判据在 `promptBuilder.js` 那条自检里（`缺少活动重点` / `缺少活动难点`），
  // 跟这里必须一致。
  if (c.key_points && (c.key_points.focus || c.key_points.difficulty)) {
    children.push(heading('三、活动重点难点'));
    if (c.key_points.focus) children.push(para(`活动重点：${c.key_points.focus}`));
    if (c.key_points.difficulty) children.push(para(`活动难点：${c.key_points.difficulty}`));
  }

  // ——— 四、活动准备 ———
  //
  // ⚠️ 字段名是 **`material`（单数）**，不是 `materials`。
  // 第一版按复数写的，结果是「（二）物质准备」整块不见了 ——
  // 而物质准备正是她**要照着备料的那一节**，缺了这份教案就用不了。
  if (c.preparation) {
    children.push(heading('四、活动准备'));
    if (c.preparation.experience) {
      children.push(para('（一）经验准备'));
      children.push(para(c.preparation.experience, { indent: 1 }));
    }
    const mats = c.preparation.material;
    if (Array.isArray(mats) && mats.length) {
      children.push(para('（二）物质准备'));
      for (const m of mats) children.push(para(m, { indent: 1, bullet: true }));
    }
  }

  // ——— 五、活动过程 ———
  if (Array.isArray(c.flow) && c.flow.length) {
    children.push(heading('五、活动过程'));
    for (const step of c.flow) {
      const mins = step.minutes ? `（${step.minutes} 分钟）` : '';
      children.push(new Paragraph({
        spacing: { before: 140, after: 80 },
        children: [new TextRun({
          text: `${step.stage || ''}${mins}`, bold: true, size: SIZE.body, font: FONT,
        })],
      }));
      children.push(para(step.detail, { indent: 1 }));
    }
  }

  // ——— 六、活动延伸 ———
  if (c.extension) {
    children.push(heading('六、活动延伸'));
    children.push(para(c.extension));
  }

  // ——— 七、安全提示 ———
  if (Array.isArray(c.safety) && c.safety.length) {
    children.push(heading('七、安全提示'));
    for (const s of c.safety) children.push(para(s, { bullet: true }));
  }

  // ——— 八、配图（用户 2026-09-21 定：嵌进 Word）———
  //
  // 放在安全提示之后、STEAM 标注之前 ——
  // **正文八节是「她要交给园所看的东西」，配图附在它后面**；
  // 而 STEAM / 《指南》/ 教学实例是「附注」，在最后。
  // 插在中间会把八节的连续性打断，而她打印时多半是连着打正文的。
  if (images && images.length) {
    children.push(heading('八、配图'));

    /* ⚠️ **图片按用途分组并标出用途**（材料图 / 记录表 / 头饰…）。
       不标的话她打出来分不清哪张是给孩子填的、哪张是给自己看的，
       而这五种用途的打印方式完全不同（记录表要粗线大格、头饰要够绕头）。 */
    for (const img of images) {
      children.push(new Paragraph({
        spacing: { before: 160, after: 60 },
        children: [new TextRun({
          text: img.purposeLabel || '配图', bold: true, size: SIZE.body, font: FONT,
        })],
      }));
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 160 },
        children: [new ImageRun({
          data: img.data,
          /* 尺寸按**打印**定，跟生成时那条一致（长边 2048 = A4 约 250 DPI）。
             这里在 Word 里给的是显示尺寸：A4 正文宽度约 15.9cm，
             `docx` 的 transformation 单位是**磅**（1cm ≈ 28.35pt），
             所以 15.9cm ≈ 450pt。**等比缩放**，不拉伸。 */
          transformation: fitBox(img.width, img.height, 450),
          type: img.type || 'jpg',
        })],
      }));
    }
  }

  // ——— 附：STEAM 标注 ———
  if (c.steam && Object.keys(c.steam).length) {
    children.push(heading('附：STEAM 标注'));
    /* 按 S/T/E/A/M 固定顺序，不按对象的键顺序 ——
       键顺序是模型给的，每次可能不一样，而这份东西她要对着看 */
    for (const k of ['S', 'T', 'E', 'A', 'M']) {
      if (c.steam[k]) children.push(para(`${k}｜${c.steam[k]}`, { bullet: true }));
    }
  }

  // ——— 附：《指南》指标 ———
  //
  // ⚠️ **每一项是一整句字符串**，不是 `{domain, subdomain, target, performance}`
  // 那种对象。第一版按对象拼，会拼出一串 `undefined`。
  // 格式是用户点名的：带完整位置（子领域保留「（一）」序号），
  // 老师能在原书里精确翻到那一句 —— 那一句本来就拼好在字符串里了，直接用。
  if (Array.isArray(c.indicators) && c.indicators.length) {
    children.push(heading('附：《3-6 岁儿童学习与发展指南》指标'));
    for (const it of c.indicators) {
      /* 兼容对象形态（万一哪天改成结构化的）——
         但**默认这一条是字符串**，按字符串直接用，不拼。 */
      const line = typeof it === 'string'
        ? it
        : [it?.domain, it?.subdomain, it?.target, it?.performance].filter(Boolean).join(' ');
      if (line) children.push(para(line, { bullet: true }));
    }
  }

  // ——— 附：教学实例（师幼对话）———
  if (Array.isArray(c.dialogue) && c.dialogue.length) {
    children.push(heading('附：教学实例（师幼对话）'));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: c.dialogue.map((d) => new TableRow({
        children: [
          new TableCell({
            width: { size: 12, type: WidthType.PERCENTAGE },
            children: [para(d.speaker === 'T' ? '教师' : '幼儿')],
          }),
          new TableCell({
            width: { size: 88, type: WidthType.PERCENTAGE },
            children: [para(d.text)],
          }),
        ],
      })),
    }));
  }

  const doc = new Document({
    creator: '幼儿园 STEAM 教案生成平台',
    title: c.title || '教案',
    sections: [{
      properties: {
        /* A4 + 常规页边距。**不用 Letter** —— 这是给大陆幼儿园打印的 */
        page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } },
      },
      children,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  logger.info('lesson_docx_built', {
    plan_id: plan.id,
    images: images?.length || 0,
    bytes: buf.length,
  });
  return buf;
}

/**
 * 等比缩放进一个方框。
 *
 * ⚠️ **必须等比。** 拉成正方形的话，记录表（竖版长条）会被压扁，
 * 而记录表的格子「不对就是废纸」—— 那是它存在的全部意义。
 * 宽高缺一个就退回一个保守的默认值（不按 1:1 猜，那会画错比例）。
 */
function fitBox(w, h, box) {
  const W = Number(w) || 0;
  const H = Number(h) || 0;
  if (!W || !H) return { width: box, height: box };
  const scale = box / Math.max(W, H);
  return {
    width: Math.round(W * scale),
    height: Math.round(H * scale),
  };
}
