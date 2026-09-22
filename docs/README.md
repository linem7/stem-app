# 文档导航

2026-09-23 整理。先区分当前规范与历史记录：当前实现以源码和迁移核对，功能状态与待办只维护在 [CLAUDE.md](../CLAUDE.md)。

## 按任务阅读

| 任务 | 文档 |
|---|---|
| 了解项目与本地运行 | [项目入口](../README.md)、[后端运行说明](../backend/README.md) |
| 接着开发与协作 | [当前状态和开发约定](../CLAUDE.md)、[协作记忆](../MEMORY.md) |
| 理解需求 | [Web PRD](PRD-web.md)、[运营体系](design/operations.md) |
| 修改接口或数据库 | [API 约定](design/api-spec.md)、[数据库设计](design/db-schema.md)、[完整迁移](../backend/src/db/migrations/) |
| 修改教师网页 | [前端设计规格](design/frontend-design-spec.md)、[设计令牌](design/design-tokens.md) |
| 修改教学与提示词 | [年龄班适配](design/age-band-adaptation.md)、[教案结构与模式](design/lesson-structure-and-modes.md)、[提示词设计](design/system-prompts.md) |
| 查教学来源及评价标准 | [框架提炼](design/framework-extraction.md)、[评价量规](design/lesson-evaluation-rubric.md) |
| 配置或排查审核 | [内容安全操作说明](design/content-safety.md) |

专题文档中的历史示例不代表完整当前实现；数据库示意 SQL 不作为建库脚本。修改接口时先更新契约，再修改代码。

## 决策与替代关系

| 记录 | 阅读边界 |
|---|---|
| [ADR-001 技术栈](adr/ADR-001-technology-stack.md) | 初期决定；平台与云厂商以后续 ADR 为准 |
| [ADR-002 转 Web](adr/ADR-002-pivot-to-web.md) | 平台转向仍有效；新建空库方案后来改为迁移 022，云厂商由 ADR-003 替代 |
| [ADR-003 阿里云](adr/ADR-003-switch-to-aliyun.md) | 云厂商决策；对象存储后来弃用，图片改存磁盘，部署细节以有日期的交接为准 |
| [ADR-004 开放名单](adr/ADR-004-open-up-the-roster.md) | 有效码不限定园所，支持名单外自填；自填地区后续扩为全国省市表，以 API 与代码为准 |

## 近期交接

交接描述当时发生的事，保留原文，不据此断言当前线上状态。

| 记录 | 关键结果／后续替代 |
|---|---|
| [09-21 Word 与配图](handoff/2026-09-21-导出-word-与配图方案.md) | Word 文件下载、配图方案与磁盘压缩；替代旧的“导出未实现／待接 OSS” |
| [09-22 收假登录](handoff/2026-09-22-收假登录与拆微信残留.md) | 假登录移除；后续内容安全接入后 wechat.js 完整删除 |
| [09-22 HTTPS](handoff/2026-09-22-IP-HTTPS与备案.md) | 以开头最终结果为准，“等待 443 放行”等为实施过程 |
| [09-22 内容安全](handoff/2026-09-22-内容安全上线.md) | 有部署与接口验证记录；整份教案真实生成未在该轮验收 |
| [09-22 退出登录](handoff/2026-09-22-退出登录.md) | 页面清理、竞态保护、多标签同步及部署记录 |
| [09-22 双网站入口](handoff/2026-09-22-双网站端口隔离.md) | 问卷入口仅占位，公网放行与项目部署未确认 |
| [09-23 整理前快照](handoff/2026-09-23-整理前开发约定.md) | 累积开发约定、早期前端设计任务书和提示词草案的历史参考，含过时说法 |
| [09-23 文档整理](handoff/2026-09-23-文档整理.md) | 本次修改、清理及验证边界 |

其余 [历史交接](handoff/) 保留用于追查。早期假登录、微信换绑、空库重建和 HTTP 入口等操作步骤不再适用于当前版本。

## 原型与归档

[可点击原型](../prototype/index.html)、[设计定稿](../design-demos/direction-approved.md) 用于讲设计，不与每轮产品更新同步。[小程序归档](../Archive/mini-program/README.md) 是历史实现，不能作为 Web 的安装说明。

维护约定：功能进展更新 CLAUDE；产品行为更新 PRD／专题规范；过程写入交接并在本页补索引。已经被替代的决定保留日期和替代关系，不在当前入口继续维护旧待办。
