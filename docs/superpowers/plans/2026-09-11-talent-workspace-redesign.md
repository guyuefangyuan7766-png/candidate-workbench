# 人才库全套前端改版实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 不因该技能再次要求用户确认已批准的设计；无需默认委派子代理。

**Goal:** 将已确认的 22 张设计图落实到现有八入口人才工作台，并统一候选人职业摘要为“最近”术语。

**Architecture:** 保留 React 组件、现有 API 和服务端数据逻辑，以统一 token、页面布局、共享列表、右侧详情和表单模式完成改版。先整理历史样式覆盖，再按业务页面渐进实现；不把生图作为网页背景或建立另一个 mock 产品。

**Tech Stack:** React 19、TypeScript 5、Vite 7、Lucide React、Express 5、SQLite、Node.js ≥24、Windows/PowerShell。

**Spec:** `docs/superpowers/specs/2026-09-11-talent-workspace-approved-design.md`（开工前全文阅读）。

## 全局约束

- 最新术语要求优先于 PNG：最近职位、最近公司、最近经历、最近经历与教育摘要。
- `current_title` / `current_company` 与数据库/API/导入兼容键不改名；正在查看的招聘职位不属于术语替换对象。
- 仅现有功能改版；真实业务接口、筛选分页、选择上限、确认机制、错误恢复全部保留。
- 主色 `#3370FF`、正文14px、元信息12px、桌面优先、右侧候选人详情、五个固定页签。
- 工作区不干净；HEAD `8470f1cdb3664948c5ca5f6650b2fe92b99c5c64` 仅供定位，不是可覆盖工作区的完整基线。
- 不 reset/clean/stash/revert 既有工作。不复制生产数据、真实简历或密钥到设计/测试资产，不上传它们。
- 当前任务只保存方案；下面所有复选项均为**新对话执行项**。

## 阶段 0：确认起点与建立可重复预览

**读取：** `README.md`、`docs/ARCHITECTURE.md`、`docs/UI_DESIGN.md`、`docs/API.md`、`docs/TESTING.md`、`docs/handoffs/2026-09-10-search-hybrid-delivery.md`、本规范、图册 manifest 和基线 JSON。

- [ ] 执行 `git status --short`、`git diff --stat`，记录本轮前端起始差异。基线 JSON 是交接时快照，不能证明更早的原始状态。
- [ ] 打开全部选定图片，按 manifest 精确选择修订图。`output/` 忽略状态不代表文件可删；新 worktree 要包含当前源码和资产，不能仅从 HEAD 起步。
- [ ] 阅读 `src/main.tsx` 的 CSS 加载顺序及 `styles.css`、`preview-theme.css`、`search.css`。`preview-theme.css` 虽叫 preview，实际被 main 导入，不能当废文件删掉。
- [ ] 记录 `npm run build` 和 `npm test` 的起始结果；旧失败分开记录，不把旧验收当新结果。
- [ ] 阅读 `tests/browser/anonymous-hybrid-server.mjs` 和 `tests/fixtures/anonymous-search.mjs`。在临时目录创建匿名库，显式关闭远程检索和 Agent 网关；补充虚构职位、人才库、履历、备注和附件。
- [ ] 在未占用端口启动匿名服务并通过该服务预览构建后的 dist。示例：`node tests/browser/anonymous-hybrid-server.mjs 4397`。Vite 默认代理指向4173，若用别的 API 端口必须明确配置，不能误连正式库。

**交付：** `docs/evidence/talent-redesign/baseline.md`，包括端口、匿名标记、源码起点、已有测试失败与预览方式。

## 阶段 1：统一词汇与全局框架

**文件：** `src/main.tsx`、`src/styles.css`、`src/preview-theme.css`、`src/search.css`、`src/App.tsx`；创建 `src/talent-labels.ts`，必要时创建作用域明确的 `src/talent-workspace.css`。

**接口：** 不改组件业务 props 与 API；集中显示标签可定义为：

```ts
export const TALENT_LABELS = {
  current_title: "最近职位",
  current_company: "最近公司",
  experience: "最近经历",
  experienceEducation: "最近经历与教育摘要",
  titleCompany: "最近职位 / 公司",
} as const;
```

- [ ] 全量搜索 `rg -n '当前职位|当前公司|当前经历' src server docs`，按候选人摘要、当前招聘职位、历史原文/兼容表头分类。只有第一类显示名改动；记录例外清单。
- [ ] 所有相关组件使用上述标签或一致的直接文案；表单、导入字段选项、附件差异、搜索证据、空值和 aria-label 一起覆盖。`server/constants.js` 等原始/导出兼容字段不要因全局替换改变契约。
- [ ] 将 token 收敛到一个权威定义。逐项迁移旧覆盖，删除被替代的具体规则，不持续叠加全局 `!important`。保留 AI 页面定位、导入全屏、移动端菜单、侧栏收起等已有依赖。
- [ ] 按设计统一品牌与8个导航入口；所有路由都有正确选中态，工具页不遮住/吞掉主导航和返回入口。标题、按钮、筛选、分页、错误区使用统一间距。
- [ ] 桌面收起/展开与 localStorage 异常回退仍可用；检查工作台、候选人、分组、职位及三个工具页切换和浏览器返回。

**验收：** 1536/1440桌面、768平板、390手机根页面无横溢出，导航不与标题重叠；岗位事实新文案全覆盖，技术字段名称未变。

## 阶段 2：工作台与候选人主列表

**图：** 01、02。**文件：** `Overview.tsx`、`CandidateTable.tsx`、`CandidateGroupedView.tsx`、`CandidateAvatar.tsx`、`App.tsx`、相关样式。

- [ ] 工作台保留真实统计/分布/最近更新点击跳转，采用克制的信息块与统一标题层级。数字不硬编码成设计示例。
- [ ] 列表按姓名头像、最近职位/公司、关联职位、人才库、地点/教育、标签、更新时间排列。长名称与无头像都有稳定回退，不使用设计图假头像填充真实档案。
- [ ] 复用当前筛选状态、服务端查询、分页、取消请求与选中集合。筛选 chips 可逐个移除；换页/筛选后的选择范围遵守原逻辑。
- [ ] “列表/按职位”两个视图全部可用；未分配职位分组仍显示；CSV/XLSX 导出保留当前筛选语义。
- [ ] 在库/归档/全部、选择/取消、批量归档/关联/永久删除入口、重试、空结果与加载逐项检查。

**验收：** 用匿名库查询一个存在和不存在的姓名、切换学历地点条件、切页、切视图、打开导出菜单与取消批量动作；结果与服务端分页一致。

## 阶段 3：人才库分组与成员关系

**图：** 03、17、21、22。**文件：** `TalentPoolPage.tsx`、`CandidatePickerDialog.tsx`、共享候选人列表、相关样式。

- [ ] 次侧栏采用分组名称/颜色/人数和搜索/归档范围；新建入口独立于范围 tabs，避免挤压。
- [ ] 保留分组和成员两套独立服务端分页、加载与错误区。不要把一次取到的50个分组误当全库。
- [ ] 显示名称、说明、真实人数、加入候选人主动作；编辑、归档、恢复与删除按对象状态显示。
- [ ] 复用 CandidatePickerDialog 搜索/排除已加入成员；确定加入后刷新双方计数；移出只解除关系。
- [ ] 继续执行活动与归档分组不能混选、单批100上限、版本冲突等现有保护。

**验收：** 在匿名库新建组→加入2人→打开档案→移出1人→确认档案仍在→编辑组→归档→恢复；超长组名与无成员状态正确。

## 阶段 4：候选人右侧详情、编辑与附件区

**图：** 09–14、20。**文件：** `CandidateDrawer.tsx`、`CandidateForm.tsx`、`AttachmentWorkflow.tsx`、`attachment-suggestion-display.ts`、`profile-section-display.ts`、相关样式。

- [ ] 详情保持稳定身份头和五页签：档案/履历/历史评估/备注与动态/高级信息。不要复制图片里的“概览/附件/关联职位”等页签变体。
- [ ] 档案标题使用“最近经历与教育摘要”；原字段绑定不变。基本信息、求职偏好、入职事实、关联职位、人才库及来源全部保留。
- [ ] 履历与结构化资料分层显示；历史评估只展示导入记录；备注可保存并刷新动态；高级资料通过现有显式加载获取，关闭时仍清除本次敏感显示状态。
- [ ] 长详情正文独立滚动、固定头/页签/底部操作；宽度不足就覆盖而非挤坏主表。移动全屏和键盘关闭、焦点返回完整。
- [ ] 新增与编辑沿用 CandidateDraft、现有字段校验、失败恢复、候选人创建后继续保存履历的逻辑。不要按生图添加不必要必填。
- [ ] 附件差异按原API展示建议/当前值、逐项勾选、确认写入；未选字段和历史内容不被覆盖。

**验收：** 五页签全部可达；空履历、超长段落、历史评估原文、敏感未加载/加载、添加备注、保存失败保留表单、只更新勾选差异分别验证。纯文字样式不新增机械快照测试。

## 阶段 5：职位列表、详情与表单

**图：** 04、15、16。**文件：** `PositionTable.tsx`、`PositionDetailPage.tsx`、`PositionFormDrawer.tsx`、`PositionStatusBadge.tsx`、`App.tsx`。

- [ ] 统一职位标题、真实状态 tabs、筛选/排序、行密度与分页。保留 draft/open/paused/closed，不增加阶段管道。
- [ ] 详情保持职位说明、基础字段、关联候选人、添加已有/新建、解除、导出和分页。
- [ ] 表单按基础信息、说明、来源字段组织，沿用真正必填字段和已有字数限制。
- [ ] 将候选人摘要中的“当前经历”改“最近经历”；职位详情自己的“当前职位”保留语境或称“该招聘职位”。

**验收：** 新增匿名职位→编辑→关联候选人→解除→确认人档案保留；各状态筛选和档案跳转可用。

## 阶段 6：表格导入与批次附件

**图：** 05、08、18–20。**文件：** `ImportWizard.tsx`、`AttachmentBatchWorkflow.tsx`、`AttachmentWorkflow.tsx`、`AssistantDrawer.tsx`、`import-task-state.ts`、相关样式。

- [ ] 用现有阶段状态渲染文件、映射、校验、提交、结果；北森与通用导入差异按真实流程，不能强行套成后端不支持的固定步骤。
- [ ] 字段映射明确最近任职/关联招聘职位/入职事实区别；新显示标签不损坏旧表头识别。
- [ ] 错误行、预览过期、重复提交、任务恢复、导入结果下载保持可操作；问题统计取真实返回值。
- [ ] 附件批次按上传/解析/待确认/失败等真实状态展示，定位候选人后展示差异；未知匹配和候选人新建入口保留。
- [ ] 只用临时虚构表格和简历验证；不提交真实北森数据。

**验收：** 合法CSV预览提交、必填缺失行、重复候选人、取消、任务恢复；匿名附件成功/失败/未定位/只确认两项差异，证明写入范围正确。

## 阶段 7：AI 助手与人才检索

**图：** 06、07。**文件：** `AssistantDrawer.tsx`、`AssistantMarkdown.tsx`、`search.css`、`attachment-suggestion-display.ts`，必要时仅修改 `api.ts` 的显示投影。

- [ ] 全站导航保留；会话栏和正文/输入框分区清晰。新建、切换、重命名、删除确认、加载更早消息、任务进度、取消重试维持。
- [ ] 输入即检索，不加入“计划确认”步骤；排序相似度不显示成能力百分比。本人能力证据和关联职位/分组证据继续区分。
- [ ] 保留旧请求取消隔离、上次结果标记、索引未就绪、降级、部分条件、完整性和分页状态。
- [ ] UI字段标签统一最近职位/公司；不凭展示文案改模型查询Schema或SQL映射。无配置状态仍可理解且不伪造成功答案。

**验收：** 匿名检索成功/空/取消/重试/条件变更/旧请求回包/降级/分页/打开详情；聊天本地受控测试或确定性桩，远程网关不可用则明确报告未测。

## 阶段 8：回归与交付

**创建：** `docs/evidence/talent-redesign/acceptance.md`、`coverage.json`、逐页截图。**更新：** `docs/UI_DESIGN.md`、`docs/TESTING.md`、`docs/ITERATION_LOG.md`、`CHANGELOG.md`，仅追加本轮内容。

- [ ] 先运行受影响现有用例，例如 `node --test tests/backend/candidate-profile-sections-ui.test.mjs tests/backend/candidate-demographics-ui.test.mjs tests/backend/attachment-workflow-ui.test.mjs tests/backend/assistant-v8-ui.test.mjs tests/backend/search-frontend-api.test.mjs`，检查用例是否有旧文案断言，按新需求合理更新。
- [ ] 运行 `npm run build` 和 `npm test`。新增测试仅覆盖新行为或实际风险：字段键不变、关联不误删、确认写入、异步旧结果隔离；不为纯颜色/圆角写实现镜像测试。
- [ ] 旧 `tests/browser/hybrid-search-qa.mjs` 锁定了旧 App.tsx 哈希，不能原样当新验收，也不能仅改哈希假装通过。为本轮新建 `tests/browser/talent-workspace-qa.mjs` 或通过当前允许的浏览器能力验证，保留其匿名库检查和关键断言。
- [ ] 比对22张图对应状态，在1536×1024捕获同视口样式；把参考与实现并排检查字体/间距/层级/颜色/文案，记录必要的业务纠偏。补测1440、1280、768、390；窄屏不要求复制桌面四栏。
- [ ] 在匿名库验证各核心动作、错误/空/加载/长文本，确认无控制台异常、请求失败或根页面横溢出；不要只看截图。
- [ ] `rg -n '当前职位|当前公司|当前经历' src` 的每个剩余命中必须有语境说明。实现中的候选人摘要旧标签应为零，招聘职位语境允许存在。
- [ ] 交付本地运行入口、源码差异、22项覆盖表、检查结果及限制。正式服务/真实数据部署不自动执行。不要把本轮外的修改混入提交。

## 风险与明确决策

1. **脏工作树**：当前源码包含搜索、附件、导入等尚未提交工作；以现有文件为基础，不从HEAD重建。
2. **历史CSS覆盖**：全面整理须逐规则验证，不只追加一层主题而保留相互矛盾的绝对定位和隐藏规则。
3. **生图偏差**：原图批准的是风格和结构。业务规则、字段名、新术语和固定五页签以规范为准。
4. **列表空间**：常见桌面使用右侧覆盖详情；仅空间足够时并排。表格内横滚可接受，根页面横滚不可接受。
5. **后台兼容**：本轮不新增数据库迁移/检索算法/向量维护，不改变导入文件契约和现有权限。
6. **已授权设计**：不再生成三方案让用户重选；不把常规实现选择当成停工审批点。
