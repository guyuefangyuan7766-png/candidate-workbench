# 响应式尺度与导航状态隔离：实施计划

> 状态：**阶段 0–6 已完成（2026-09-16）**。下列复选项只勾选已由代码、报告或命令实际验证的项目；既有 8 项后端失败保留并如实记录。

**目标：** 让界面在 1024–3840px 全部分辨率下尺度合理、列不缺失，让 AI 助手 / 导入候选人 / 业务页面成为互斥且可关闭的独立表面，并修掉 2026-09-15 审计中确认的 D1–D10。

**架构：** 保留 React 19 + TypeScript + Vite + Express + SQLite 与全部现有 API；改动集中在 `src/workspace.css`（尺度 token 与断点覆盖）、`src/App.tsx`（表面状态机）、`src/views/*`（列类名与文案）、`src/components/*`（弹层关闭、按钮换行、显示按钮）、`server/hybrid-search.js`（检索补齐语义）。

**技术栈：** React 19、TypeScript 5、Vite 7、Lucide React、Express 5、SQLite、Node.js ≥24、Windows/PowerShell、Playwright（浏览器验收）。

**规范：** `docs/superpowers/specs/2026-09-15-responsive-scale-and-surface-isolation-design.md`（开工前全文阅读，冲突时以规范为准）。

**目标版本：** 应用 `0.3.0`；数据库保持 schema `V13`，**无新增迁移**。

## 全局约束

- 不改 API 契约、不改数据库结构、不改导入与检索的字段语义。
- 不引入 UI 框架、CSS-in-JS、PostCSS 插件；只用原生媒体查询与 CSS 变量。
- 22 张设计图仍是唯一视觉基准；本轮不改视觉方向，只做尺度与适配。
- 不为通过测试回退既有结构；断言不匹配时改脚本。
- 工作区当前不干净（存在大量未提交改动与 `.codex-tmp/` 临时文件），**不 reset / clean / stash / revert 既有工作**，不提交真实候选人数据。
- 浏览器验收只能连匿名库（`tests/browser/anonymous-talent-workspace-server.mjs`），不得连正式 4173 服务或 `data/recruitment.db`。

## 阶段 0：建立可重复的基线

**读取：** `README.md`、`docs/UI_DESIGN.md`、`docs/TESTING.md`、`docs/ARCHITECTURE.md`、本规范、`tests/browser/talent-workspace-qa.mjs`。

- [x] 记录起始状态：`git status --short`、`git diff --stat`，确认不改动既有未提交改动。
- [x] 启动匿名环境：`node tests/browser/anonymous-talent-workspace-server.mjs 4398` + `npx vite --config .codex-tmp/vite-anon.config.mjs`（4400）。
- [x] 跑通起点门禁：`npx tsc --noEmit`、`npm run build`、`node tests/browser/talent-workspace-qa.mjs`（交接时为 31/31；阶段 6 扩展 G4 后为 32/32），把结果写入本轮基线记录。
- [x] 创建 `tests/browser/responsive-scale-qa.mjs` 与 `tests/browser/surface-navigation-qa.mjs` 骨架，先输出失败清单（预期：分辨率矩阵与表面互斥大面积失败），作为"改前证据"。

**交付：** 基线记录（沿用 `docs/evidence/talent-redesign/baseline.md` 追加本轮小节），含端口、匿名标记、起点测试结果、改前失败清单。

## 阶段 1：导航表面状态机（先修最影响使用的问题）

**文件：** `src/App.tsx`、`src/views/AppShell.tsx`。

- [x] 定义 `Surface` 联合类型（规范 4.1），用单状态替换并列的 `importOpen` / `assistantOpen`。
- [x] 实现交互规则：点击已激活入口即关闭并回到 `from`；切换入口不叠加（规范 4.2）。
- [x] 侧栏高亮改为由 surface 派生；删除 `importOpen` 优先逻辑。
- [x] URL 与 surface 双向同步（含 `popstate`、`/import` 路径），保持 `/assistant`、`/resume-search`、`/attachment-parser` 既有行为。
- [x] 保留「存在可恢复导入任务时默认打开导入页」的既有行为。
- [x] 导航时清理抽屉/弹层状态；`openCandidateById` 从检索结果打开抽屉时不清空当前 tool。
- [x] 自检：`/assistant` 与 `/import` 直接访问、刷新、前进后退均与显示内容一致。

**验收：** `surface-navigation-qa.mjs` 5 场景全通过；任一时刻可见 `h1` 数 = 1；高亮 = URL = 标题。

## 阶段 2：尺度 token 与断点分档

**文件：** `src/workspace.css`。

- [x] `:root` 增加尺度 token（规范 3.2），现有规则改为引用 token。
- [x] 追加「第十二轮」段落：`@media (max-width: 1919px / 1599 / 1365 / 1151 / 1023 / 720)` 降序覆盖 token（规范 3.1 分档表）。
- [x] 垂直空间治理：页面头部、卡片内边距与间距、工作台指标卡列数与最小高度（规范 3.3）。
- [x] 保证正文 ≥13px、元信息 ≥12px，不越下限。

**验收：** `responsive-scale-qa.mjs` 断言主标题字号落在档位区间 ±1px；候选人列表首屏可见行数达标；无根节点横向溢出。

## 阶段 3：列优先级与并排抽屉

**文件：** `src/views/CandidatesView.tsx`、`src/views/CandidatesGroupedView.tsx`、`src/views/PositionsView.tsx`、`src/components/TalentPoolPage.tsx`、`src/components/AssistantDrawer.tsx`（检索结果表）、`src/workspace.css`。

- [x] 为「关联职位」「人才库分组」列补 `tw-col-positions` / `tw-col-pools` 类名，统一使用类名而非 `nth-child` 控制显隐。
- [x] 按规范 3.4 实现各档位列集；S 档及以下行内操作常显。
- [x] 并排抽屉按可用宽度分两级（≥1600 / 1440–1599），保证 `table.scrollWidth ≤ 容器 clientWidth + 1`；否则给出可见横向滚动条且默认可见 `操作` 列。
- [x] 修复 D3（标签列换行与行高不一致）、D2（职位操作按钮竖排）、D4（显示按钮溢出卡片）、D7（分组名截断无提示）。

**验收：** 15 视口 × 6 页面无被裁列；同一列表行高唯一；上述单点断言通过。

## 阶段 4：弹层与命名一致性

- [x] 抽出 `useDismissableLayer`（Esc + 点击外部 + 表面切换关闭），接入导出菜单、更多筛选、模态框、候选人/职位选择器（D5、D6）。
- [x] 删除 `src/App.tsx` 里监听 `.menu-wrap` 的失效逻辑与冗余 `exportOpen` 状态。
- [x] 命名统一（D8）：履历检索、AI 助手、返回人才库、新建分组。
- [x] 统计口径标注（D9）；顶栏助手入口按规范 D10 恢复或同步文档（本轮按恢复入口实施）。

**验收：** Esc / 点击外部可关闭全部弹层；命名断言通过。

## 阶段 5：检索相关性修复（服务端）

**文件：** `server/hybrid-search.js`。

- [x] 补齐逻辑仅在「已有真实命中且不足一页」时启用；无真实命中时返回空结果并给出明确空态（规范 D1）。
- [x] 补齐项标注为「仅用于补足分页」而非「部分匹配」；`score` 改为真实相关性得分或 `null`。
- [x] 前端「部分匹配」只在存在非空 `evidence` 时渲染。

**验收：** 无关词 0 条；命中项证据非空；结构化条件查询结果不变；既有降级提示保留。需要定向后端测试覆盖三类输入。

## 阶段 6：全量验证与文档同步

- [x] `npx tsc --noEmit`、`npm run build` 通过；`npm test` 执行完成且无新增失败（715 通过、8 个既有失败、7 跳过）。
- [x] `responsive-scale-qa.mjs`（93/93）、`surface-navigation-qa.mjs`（11/11）、`talent-workspace-qa.mjs`（32/32）全通过；控制台 0 error。
- [x] 生成多分辨率截图矩阵到 `docs/evidence/talent-redesign/screenshots/`（90 个矩阵页 + 3 个抽屉断言，共 93 张 JPG；不覆盖既有 22 张设计图对照图）。
- [x] 更新 `docs/evidence/talent-redesign/baseline.md`、`acceptance.md` 与 `coverage.json`。
- [x] 同步文档：`README.md`、`CHANGELOG.md`、`docs/README.md`、`docs/UI_DESIGN.md`、`docs/TESTING.md`、`docs/ITERATION_LOG.md`、`docs/ARCHITECTURE.md`、`docs/PRODUCT_SPEC.md`。
- [x] 版本：`package.json` 与 `package-lock.json` 记录 `0.3.0`；`CHANGELOG.md` 的 `0.3.0` 条目补齐实际验证结果；确认数据库仍为 `V13`、无新增迁移。

## 验收门禁（与规范第 6 节一致）

| 门禁 | 通过条件 |
| --- | --- |
| G1 | 15 视口 × 6 页面：无根节点横向溢出、列可见性与规范一致、标题字号在区间内、首屏行数达标 |
| G2 | 5 场景下可见 `h1` 数为 1，高亮 = URL = 标题，重复点击可关闭 |
| G3 | 行高唯一、按钮不换行、显示按钮不越界、弹层可关闭 |
| G4 | 无关词 0 结果，命中项有证据，补齐项不冒充命中 |
| G5 | 构建/类型/后端测试不新增失败，现有 30 项浏览器验收保持通过 |
| G6 | 全部受测流程 0 console error / 0 pageerror / 0 个 ≥500 响应 |

## 风险与回滚

- 阶段 2、3 会改动大量选择器与尺寸：先合阶段 1（改动小、收益最大），再逐档实施并每档跑一次门禁。
- 阶段 5 是行为修正，可能影响既有检索断言与降级提示：需要同步更新相关后端测试，但不得放松「无命中必须为空」这一条。
- 无数据库迁移；各阶段可按文件回滚。版本回滚只需恢复版本行与 `CHANGELOG`。
