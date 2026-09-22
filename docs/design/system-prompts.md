# 系统提示词设计

2026-09-23 对照当前实现整理。实际提示词由后端代码拼接，本文记录职责、约束和修改入口；早期 11 题、豆包场景插图等草案保留在 [历史快照](../handoff/2026-09-23-整理前开发约定.md)，不作为当前实现模板。

## 提示词入口

| 场景 | 实现与职责 |
|---|---|
| 引导 | [guideFlow.js](../../backend/src/services/guideFlow.js) 生成一屏 4 题；[promptBuilder.js](../../backend/src/services/promptBuilder.js) 拼接教师档案、记忆、已收集条件和当前年龄班规则 |
| 生成与改稿 | promptBuilder 的教案／改稿系统提示词；[lessonGenerator.js](../../backend/src/services/lessonGenerator.js) 生成、解析、规范化和硬校验 |
| 记忆 | [memoryExtractor.js](../../backend/src/services/memoryExtractor.js) 提取、合并与淘汰；默认目标上限 10 条，教师置顶记录不因超限自动删除 |
| 配图 | lessonGenerator 的 buildImagePrompt 结合 [imagePurpose.js](../../backend/src/services/imagePurpose.js) 用途与构图约束，再交给后台选定的图片模型 |
| 模型调用 | [textChat.js](../../backend/src/services/textChat.js) 统一处理格式、开关、预算与重试；模型配置由后台管理 |

## 教学与交互约束

- 引导一屏 4 题，逐题保存；年龄班参数由代码控制，题干与推荐答案可由模型个性化。不能恢复旧的 11 题三轮草案。
- 只注入当前年龄班规则，避免模型给小班套用更丰富的大班活动。生成后做年龄班硬校验，违规写入质量记录。
- 小班／中班／大班默认 20／25／30 分钟，3／4／4 环节，2／3／4 指标。小班不强求 STEAM 五域齐全；指标须对应当前年龄档的典型表现。
- 正文采用大陆教案结构；设计意图是正文，学习模式折叠解读 commentary 是额外说明。默认导出不包含 commentary。
- 改稿追问应结合已问过的问题和反馈，不重新问同样的问题；改稿仍须满足年龄班约束。

专题依据见 [年龄班适配](age-band-adaptation.md)、[教案结构与模式](lesson-structure-and-modes.md)、[框架提炼](framework-extraction.md) 和 [评价量规](lesson-evaluation-rubric.md)。

## 配图与内容审核

- 配图用于打印。推荐方案的一条是一张纸的完整安排，老师可修改描述；不将材料实物本身误写成需要打印的示意图。
- 记录表独占一张纸、留大格空白，不能与材料裁切图或头饰拼在同页。具体用途的构图、尺寸及模型参数以 imagePurpose 和当前模型适配代码为准。
- 教师输入和 AI 输出经过 [内容安全](content-safety.md)；长文本完整分段审核，编辑审核合并后的内容。
- 开启审核时，未经审核的标题、正文和结构化内容不得提前显示；浏览器先显示阶段进度。
- 不向提示词注入教师手机号、真实姓名或个体幼儿信息。自动记忆不抽取儿童表现、家庭或健康信息。

## 修改后的验证

按修改范围选择年龄班、解读、上下文、流式或审核离线回归。涉及真实生成质量时，再使用测试数据库和冒烟脚本验证三档输出；真实生成会产生模型费用，不属于文档整理检查。命令和前置条件见 [运行说明](../../backend/README.md#验证与测试)。
