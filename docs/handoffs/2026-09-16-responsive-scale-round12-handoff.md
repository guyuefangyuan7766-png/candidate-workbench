# 响应式尺度与导航表面隔离（第十二轮）· 新对话交接

日期：2026-09-16。适用版本：应用 `0.3.0`，数据库 schema `V13`，**无新增迁移**。

复制下方「交接提示词」到**当前本地项目的新对话**。不要从默认分支新建空白工作区：工作区存在大量未提交成果，且 `src/workspace.css`、`src/views/`、`src/useDismissableLayer.ts`、`tests/browser/responsive-scale-qa.mjs` 等仍是未跟踪文件。

---

## 交接提示词（直接复制）

请接手 `C:/Users/cboy/Documents/北森` 的「响应式尺度与导航表面隔离」第十二轮收尾工作。实现阶段 0–5 已完成并实测通过，本轮只需要完成阶段 6：文档同步、计划勾选、匿名预览入口，并复跑一次门禁确认没有回归。

## 已经确认，无需重新问我

1. 22 张设计图仍是唯一视觉基准，本轮只做尺度与适配；不改视觉方向、不改 API 契约、不改数据库结构（保持 schema V13，无新增迁移）。
2. 目标版本 `0.3.0`，`package.json` 与 `package-lock.json` 已是 0.3.0。
3. 所有改动都是可逆实现，直接推进，不要反复询问是否改代码。
4. 验收口径按规范第 6 节 G1–G6；「无关词 0 条」是硬门槛，不得放松。

## 开工前按顺序阅读

- `docs/superpowers/specs/2026-09-15-responsive-scale-and-surface-isolation-design.md`（规范，冲突时以它为准）
- `docs/superpowers/plans/2026-09-15-responsive-scale-and-surface-isolation.md`（计划；勾选框尚未更新，只勾选真实完成项）
- `docs/evidence/talent-redesign/responsive-scale-report.json`（15 视口 × 6 页面实测矩阵）
- `src/workspace.css` 末尾「第十二轮」段落（尺度 token + 断点覆盖 + 列优先级）
- `src/App.tsx` 的 `Surface` 状态机、`src/useDismissableLayer.ts`、`server/hybrid-search.js` 的关键词召回段
- `README.md`、`docs/README.md`、`docs/UI_DESIGN.md`、`docs/TESTING.md`、`docs/ARCHITECTURE.md`、`docs/PRODUCT_SPEC.md`、`CHANGELOG.md`

## 本轮已实测通过的基线（2026-09-16，不要回退）

- `npx tsc --noEmit` 通过；`npm run build` 通过。
- `npm test`：730 项、715 通过、8 个既有失败、7 跳过。8 个失败与改动前基线完全一致（V8 catalog/authorizer、V12 maintenance launcher、docs hire fields），本轮未新增失败。
- `node tests/browser/responsive-scale-qa.mjs`：93/93（15 视口 × 6 页面 + 3 个抽屉断言），0 控制台错误。
- `node tests/browser/surface-navigation-qa.mjs`：11/11，0 控制台错误。
- `node tests/browser/talent-workspace-qa.mjs`：31/31，0 控制台错误。
- `node --test --test-concurrency=1 tests/backend/search-keyword-recall.test.mjs`：4/4。
- 多分辨率截图矩阵：`docs/evidence/talent-redesign/screenshots/viewport-<宽>x<高>-<页面>.jpg` 共 93 张（约 7MB），命名不与既有 22 张设计对照图冲突。

## 本轮已完成（逐项实测，不要重做）

1. **导航表面状态机**：`src/App.tsx` 用单一 `Surface` 联合类型替换并列的 `importOpen`/`assistantOpen`；URL ↔ 表面双向同步、前进后退、刷新恢复、重复点击关闭、Esc 逐层关闭；检索结果打开抽屉不清空工具表面。
2. **尺度系统**：`src/workspace.css` 末尾「第十二轮」段落集中放置 token 与媒体查询，按 `max-width` 降序 1919 / 1599 / 1365 / 1151 / 1023 / 720 覆盖。主标题 34/32/28/26/24/22/20，数据行 72/68/62/58/56/54/60，列表头像 52/48/44/40/36/36/40，详情头像 100/96/88/84/80/72/64，抽屉 500/500/460/全宽/全宽/全宽/全屏。
3. **表格列优先级**：候选人/成员表用 `tw-col-select|name|recent|positions|pools|place|tags|time|actions` 控制显隐；标签 ≤1599 隐藏、更新时间 ≤1365 隐藏、人才库分组 ≤1151 隐藏、关联职位 ≤1023 隐藏、最近职位与地点学历 ≤720 隐藏；职位表额外隐藏计划人数/负责人/部门/工作地点/候选人数。四张主表改为 `table-layout: fixed` + 显式列宽，任何验收视口下 `table.scrollWidth ≤ 容器 clientWidth + 2px`。
4. **并排抽屉两级**：`body.tw-drawer-inline` 在 ≥1600 隐藏标签与更新时间，1440–1599 再隐藏关联职位；旧的固定 `min-width: 860px` 已删除，履历检索表的 `th:nth-child` 百分比列宽已由更高优先级的类名规则覆盖。
5. **侧栏图标栏**：721–1365 由 CSS 强制降为 72/64px 图标栏（品牌文字、折叠按钮、底部说明隐藏），≤720 保持既有抽屉式侧栏。
6. **顶栏助手入口（D10）**：≥721 显示 40px 窄条，右对齐「AI 助手」入口（`.tw-topbar`）；≤720 保持既有粘性顶栏。
7. **单点修复**：D2 职位操作按钮不换行且不被压扁（`.tw-col-actions` nowrap + 按钮 `flex: 0 0 auto`）；D3 标签列不换行、列表行高唯一；D4 详情抽屉「显示」按钮回到卡片内（`dd` 默认 40px 缩进导致的越界，用 `.tw-row-inline` + `.tw-row-text` 修正）；D7 分组名有 `title` 且左栏更宽。
8. **弹层统一（D5/D6）**：新增 `src/useDismissableLayer.ts`（document 捕获阶段监听 Esc + 点击外部，最内层优先），接入导出菜单、更多筛选、职位行菜单、职位详情菜单、候选人选择器；删除 `src/App.tsx` 中监听失效 `.menu-wrap` 的逻辑与冗余 `exportOpen`。
9. **命名统一（D8）**：工具页标题改为「AI 助手」「履历检索」；附件解析页按钮改为「返回人才库」；人才库分组对话框改为「新建分组 / 编辑分组」。
10. **统计口径（D9）**：工作台指标卡文案改为「人才库分组（使用中）」。
11. **检索相关性（D1）**：`server/hybrid-search.js` 对未解析自由文本（`reason === 'ambiguous'`）执行本地关键词召回——每个条件取能命中的最长前缀、多条件取交集、无命中即空结果；补齐只在「有真实命中且不足一页」时启用，补齐项 `condition_status: "padding"`、`reasons: ["仅用于补足分页，不代表命中"]`、`score: null`；`pagination.total` 改为真实命中数。前端「部分匹配」只在 evidence 非空时渲染，补齐项显示「仅补足分页」，证据卡新增「关键词命中」标签。

## 剩余工作（阶段 6，仅此清单）

1. 给 `tests/browser/talent-workspace-qa.mjs` 增加 G4 浏览器断言（无关词 0 结果、命中项有证据、补齐项不出现「部分匹配」）。后端断言已在 `tests/backend/search-keyword-recall.test.mjs` 覆盖。
2. 更新 `docs/evidence/talent-redesign/baseline.md`（追加本轮小节：端口、匿名标记、起点结果、改前失败清单）与 `acceptance.md`、`coverage.json`（把 G1–G6 实测结果写入，引用 `responsive-scale-report.json` 与三份浏览器报告）。
3. 同步文档：`README.md`、`CHANGELOG.md`（0.3.0 条目补齐实际验证结果）、`docs/README.md`、`docs/UI_DESIGN.md`（顶栏助手入口、断点分档、列优先级）、`docs/TESTING.md`（新增脚本与命令）、`docs/ITERATION_LOG.md`、`docs/ARCHITECTURE.md`、`docs/PRODUCT_SPEC.md`。
4. 更新 `docs/superpowers/plans/2026-09-15-responsive-scale-and-surface-isolation.md`：把状态行改成真实进度，只勾选真实完成项（阶段 0–5 实现完成；阶段 6 视完成情况勾选）。
5. 复跑门禁并记录：`npx tsc --noEmit`、`npm run build`、`npm test`、三个浏览器脚本。
6. 启动匿名预览并给出 URL：`node tests/browser/anonymous-talent-workspace-server.mjs`（4398）+ `npx vite --config .codex-tmp/vite-anon.config.mjs`（4400，`/api` 代理到 4398）。

## 约束与坑（必须遵守）

- 工作区很脏：**禁止** `git reset --hard`、`git checkout --`、`git clean`、`stash`、按 HEAD 覆盖；不修改无关文件；`git diff --check` 的尾随空格来自既有文件，不要顺手处理。
- 浏览器验收**只能**连匿名库（`tests/browser/anonymous-talent-workspace-server.mjs`，只写临时目录）。不得连接正式 4173 服务或 `data/recruitment.db`，不得使用真实候选人数据或真实模型网关。
- 改前端源码后必须先 `npm run build` 再跑浏览器验收（浏览器脚本服务的是 `dist/`）。
- 浏览器脚本会各自 spawn 匿名服务：默认端口 responsive 4396、surface 4397、talent-workspace 4399；可用 `RESPONSIVE_QA_PORT` / `SURFACE_QA_PORT` / `TALENT_QA_PORT` 覆盖。
- 手工编辑用 `apply_patch`；PowerShell 里不要用 `Set-Content` 写中文文件（会丢 BOM/换行），批量机械替换用 `[IO.File]::WriteAllText` + `UTF8Encoding($false)`。
- 已知有意偏离：手机档（≤720）保留表格（隐藏次要列、行高 60px），未改造成卡片列表；S 档及以下候选人行内操作改为常显。文档中如实标注，不要写成「已完成卡片列表」。
- `src/workspace.css` 里第十/十一轮仍有大量硬编码尺寸，第十二轮段落靠源码顺序与更高的类名前缀覆盖它们；新增规则请追加在该段之后，不要把 token 覆盖写回前面。

## 常用命令

```powershell
npx tsc --noEmit
npm run build
npm test
node tests/browser/responsive-scale-qa.mjs
node tests/browser/surface-navigation-qa.mjs
node tests/browser/talent-workspace-qa.mjs
node --test --test-concurrency=1 tests/backend/search-keyword-recall.test.mjs
```

---

## 给接手者的补充说明

- 本轮所有结论都基于 2026-09-16 的实测，报告 JSON 在 `docs/evidence/talent-redesign/`（`responsive-scale-report.json`、`surface-navigation-report.json`、`qa-report.json`）。
- 断言与实现冲突时改脚本，但不得放松规范里的硬门槛（无关词 0 条、无横向溢出、列显隐与档位一致、0 控制台错误）。
- 不要把 `/api` 契约、数据库结构、导入/检索字段语义当作可改动项；本轮没有也不需要迁移。
