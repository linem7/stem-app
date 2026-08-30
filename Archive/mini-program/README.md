# 归档：微信小程序那一路

2026-08-30 归档。决定与理由见 `docs/adr/ADR-002-pivot-to-web.md`。

**这里的东西不再维护，也不要从主线 import 它。** 留着的唯一理由是：
这条路走到过「差一个企业主体就能发布」，中间踩的坑和量过的数是真的，
web 端重做时有一部分能直接用。

## 里面是什么

| 文件 / 目录 | 是什么 | web 端还用得上吗 |
|---|---|---|
| `frontend-uniapp/` | uni-app Vue3 + Vite 工程，10 个页面全部接过真后端 | **部分**：`src/api/`（6 个文件）、`src/stores/`（4 个）、`src/styles/tokens.scss`、`src/utils/typography.js` 原样可搬；页面模板要重写 |
| `CLAUDE-mp-lessons.md` | 小程序那一路踩过的坑（从主 `CLAUDE.md` 搬出来的） | 否，但值得读一遍 |
| `PRD-miniprogram.md` | 2026-08-16 的产品需求，写的是小程序 | 被 `docs/PRD-web.md` 取代 |
| `deployment-wxcloudrun.md` | 微信云托管部署方案 | 否 |
| `微信小程序服务器部署、备案与异地内测手册.md` | 部署 / 备案 / 异地内测调研 | **部分**：ICP 备案那几节 web 端一样要用 |
| `新企业主体小程序最省事行动清单.md` | 借朋友公司做主体变更的行动清单 | 否，这正是转向要甩掉的东西 |

## 已经删掉、不在这里的

`docs/others/` 里的主体材料 —— 朋友公司的营业执照扫描件、小程序主体变更申请函、
小程序上传私钥、fingerprint.png。这个仓库是公开的，而那是**别人公司的证照**。
作者本地另存，仓库里一份都不留。

## 还留在主线、但迟早要跟着走的

- `backend/src/services/wechat.js`（`code2Session` + `msgSecCheck`）——
  现在还有 10 个文件 import 它，动它等于动代码。留到代码那一批，
  连同「换成腾讯云文本内容安全」一起处理
- `backend/Dockerfile` + `.dockerignore` —— 写的时候是给云托管的，但它本身是一个
  普通的 Node 镜像，改两行就能给轻量服务器用。**留在主线**

## 几个不该被这次转向带走的数

`frontend-uniapp/` 里有一些量出来的东西，web 端重做时不用重新量：

- 色彩：`$mint-deep` 必须压到 `#327648`、`$ink-3` 压到 `#736D62` 才过 WCAG，
  这两个值是逐对算过比值的（`scripts/contrast-test.mjs`）
- 字号：八级梯子，正文三档 15 / 17 / 20px，下限 12px（`src/utils/typography.js`）
- 装饰性发丝线**故意不满足 3:1** —— 真提到 3:1，这套设计会变成一张硬灰格子
- 选中态不能只靠颜色：选中胶囊的黄底和未选中的奶油底亮度差只有 1.51:1，
  所以选中的一律多一个打勾
