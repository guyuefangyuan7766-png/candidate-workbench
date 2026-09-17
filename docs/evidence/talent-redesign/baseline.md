# 人才库前端改版 · 阶段 0 基线

日期：2026-09-14。范围：`C:\Users\cboy\Documents\北森`（拾才工作台 0.2.0 / schema V13）。

## 源码起点

- 分支 `test22`，HEAD `b0aae7c85842515b12d7f6d3018a76a1c86471d`（"混合检索"）。
- `git status --porcelain` 与 `git diff --stat` 均为空：本轮开工前工作区干净；交接文档（2026-09-11）中的“工作区不干净 / HEAD 8470f1c”已过时，以本记录为准。
- 交接快照 `docs/handoffs/2026-09-11-talent-redesign-baseline.json` 记录的源码哈希为交接时状态；差异以本轮实测为准。
- 22 张批准设计图逐文件 SHA-256 与基线 JSON 全部一致（22/22，0 处不符）；09/11/13 使用 `-v2` 修订图。

## CSS 加载结构

- `src/main.tsx` 导入 `styles.css` 后导入 `preview-theme.css`（后者虽名为 preview，实际生效，不可删除）。
- `src/components/AssistantDrawer.tsx` 导入 `src/search.css`。
- 当前主题主色来自 `preview-theme.css`（紫蓝 `#5b65d8` 覆盖），目标设计主色为 `#3370FF`。

## 基线构建与测试（改动前实测）

- `npm run build`：通过（tsc --noEmit + vite 7.3.6，1860 模块，5.87s）。
- `npm test`：726 项，711 通过、8 失败、7 跳过。8 项失败均为既有历史失败，与本轮改版无关：
  1. `tests/backend/agent-readonly-policy-v8.test.mjs` — 父用例 “V8 read-only catalog and authorizer expose business data but isolate internal state” 与 4 个子用例（catalog/直查/注释 CTE/策略排除）失败，根因相同：`rejectsWithCode`（第 128/319 行）期待的策略拒绝未发生。
  2. `tests/backend/hire-status-v11.test.mjs` — “public documentation describes the hire fields and migration” 期待 README 仍声明“未正式部署/未正式库迁移”，与 0.2.0 已发布文档不再匹配。
  3. `tests/backend/hire-status-v11.test.mjs` — “V12 maintenance launcher and verifier require the v2 paused-writer contract” 依赖根目录一次性脚本 `.tmp-v12-paused-server.mjs`（不在库中）。
  4. `tests/backend/import-task-resilience.test.mjs` — “a failed V12 runtime sentinel acquisition …” 同因缺少 `.tmp-v12-paused-server.mjs`。
- 完整日志：`.codex-tmp/baseline-test.log`（本地，未入库）。本轮验收口径：除上述 8 项外不得有新增失败。

## 匿名预览（可重复）

- 数据集：`tests/fixtures/anonymous-talent-workspace.mjs`（全新，48 位虚构候选人、13 个职位含 1 归档、7 个活动人才库 + 1 归档分组、履历区块、求职偏好、备注、4 份已解析附件文本、6 位归档候选人）。全部虚构，禁止填入真实数据。
- 服务：`node tests/browser/anonymous-talent-workspace-server.mjs 4398`。临时目录建库，`SEARCH_REMOTE_ENABLED=false`、Agent 网关为空，附件写入同一临时目录 `private/attachments`。
- 当前运行实例：`http://127.0.0.1:4398`（本轮开工期间保持运行；重启同一命令即可，库为临时库、数据可重建）。
- Vite 开发代理默认指向 4173 正式端口；使用匿名预览时必须显式指定或直接预览 `dist`。

## 预览截图（改动前）

- `output/playwright/talent-redesign/before-01-overview.png`
- `output/playwright/talent-redesign/before-02-candidates.png`
- `output/playwright/talent-redesign/before-03-groups.png`
- `output/playwright/talent-redesign/before-04-positions.png`

## 已确认的已知偏差（以规范为准）

- 生图内旧文案“当前职位/公司/经历”不重新生成，实现直接使用“最近”术语。
- 11/12 图中的页签变体（概览/关联职位/附件）不采纳；固定五页签为档案、履历、历史评估、备注与动态、高级信息。
- 设计图为 1536×1024 基准，验收补测 1440×900、1280×800、768×1024、390×844。

## 第十二轮：响应式尺度与导航表面隔离（2026-09-16）

### 匿名环境与安全边界

- 应用 `0.3.0`、数据库 schema `V13`，无新增迁移。工作区沿用既有未提交成果，未执行 `reset`、`clean`、`stash` 或按 HEAD 覆盖。
- 匿名数据源为 `tests/fixtures/anonymous-talent-workspace.mjs`：48 位虚构候选人、7 个活动人才库分组 + 1 个归档分组、12 个活动职位 + 1 个归档职位；候选人 ID 全部以 `anon-tw-candidate-` 开头。
- 长期预览使用 `node tests/browser/anonymous-talent-workspace-server.mjs 4398`，临时 SQLite 与附件目录均在系统 Temp 下；Vite 预览为 `npx vite --config .codex-tmp/vite-anon.config.mjs`（4400，`/api` 代理 4398）。
- 自动浏览器脚本按门禁各自启动匿名服务：响应式 4396、导航表面 4397、人才库完整 QA 4399；三个脚本均拒绝非本机目标及非 `anon-tw-candidate-*` 数据。
- 浏览器验收不连接正式 `4173`、`data/recruitment.db`、真实模型网关或真实候选人附件。

### 改前审计失败清单

原始审计产物保存在 `.codex-tmp/audit/`（临时目录，不进入版本控制）。可复核的失败集合如下：

- G1 尺度：15 档视口的主标题恒为 `34px`、导航项 `16px`、指标数字 `34px`、列表头像 `52px`；1024–820px 仍使用 208px 侧栏；390×844 工作台出现 4 个 `tw-bar-value` 横向越界。
- G1 列与并行抽屉：1536px 并排抽屉下候选人表实际 1029px、可用 848px，`更新时间`与`操作`落在抽屉后；履历检索的`操作`列也被遮住，分页条右侧越界。
- G2 导航表面：桌面顶栏助手入口不可见；助手与导入页可同时渲染；切页后高亮/URL 已变化但内容仍停留旧表面。
- G3 布局与弹层：职位操作按钮被压到约 22px；导出菜单在 Esc 和点击外部后仍保持打开；“显示”按钮曾越出详情卡片约 21px。
- G4 检索相关性：自由文本`产品设计`与无关词均返回 48 位全库候选人，且都显示“部分匹配”；旧证据文本为“满足已执行的结构化条件”，没有真实关键词命中证据。

### 阶段 6 开工前基线

- `npx tsc --noEmit`、`npm run build` 通过。
- `npm test`：730 项、715 通过、8 个既有失败、7 跳过；失败集合为 V8 只读/搜索策略（catalog/authorizer 与 business-search，共 5）、docs hire fields（1）、V12 maintenance launcher/sentinel（2），与改动前基线一致。
- `node tests/browser/responsive-scale-qa.mjs`：93/93，0 控制台错误。
- `node tests/browser/surface-navigation-qa.mjs`：11/11，0 控制台错误。
- `node tests/browser/talent-workspace-qa.mjs`：31/31，0 控制台错误；阶段 6 扩展 G4 后为 32/32。
- `node --test --test-concurrency=1 tests/backend/search-keyword-recall.test.mjs`：4/4。
- 多分辨率截图矩阵：90 个 `viewport-<宽>x<高>-<页面>.jpg` 页面用例 + 3 个 `viewport-<宽>x<高>-candidates-drawer.jpg` 抽屉断言，共 93 张 JPG；与既有 22 张设计图对照图及 `round10-*` 文件分开命名。
