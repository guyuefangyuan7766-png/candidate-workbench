# 拾才工作台

一个可在个人电脑上自托管、可继续二次开发的本地人才库。当前版本聚焦候选人档案、人才检索、人才库分组和职位关联，数据保存在本机 SQLite 中，不依赖付费招聘平台，也不是完整 ATS。

当前应用版本：`0.5.0`（开发中，尚未正式部署）；上一次已发布版本：`0.2.0`；数据库结构版本：`V13`；人才库领域版本保持历史 `V2`，没有独立产品版本字段。应用版本与数据库迁移版本相互独立：第十一轮视觉重校、第十二轮响应式适配、第十三轮检索/索引维护、第十四轮界面修复和 2026-09-18 AI 助手 A 方案增量均不新增主库结构迁移。第十四轮完成头像四态互斥、备注区单层容器、AI 助手居中会话布局、历史覆盖侧栏修复和永久无效 UI 清理；随后 2026-09-18 A 方案把主导航与历史栏改为显式互斥状态、将历史入口固定到左上角，并加入 Codex 风格执行时间线。历史栏在 721px 以上停靠时保持聊天输入和发送可用；Enter 发送、Shift+Enter 换行。验证证据见 [第十四轮 QA](docs/evidence/round14-ui-polish/qa-report.json)、[头像报告](docs/evidence/round14-ui-polish/avatar-report.json)、[隐藏节点审计](docs/evidence/round14-ui-polish/hidden-ui-audit.md) 与 [AI 助手 A 方案 QA](docs/evidence/assistant-a-20260918/qa-report.json)。

第十三轮修复了正式库规模下的检索超时：`self_docs` 的全量物化（单次 38.8s、被同一次检索反复引用）改为按倒排索引收窄候选域、单请求只物化一次，单次检索由 267s（必然 504）降到约 6–10s；向量索引维护由「每 5 分钟一次的全量重扫」改为「**每个开机周期执行一次**的增量维护」，单轮从 498–1003s 降到 19–20s；结果翻页不再逐页遍历（原先跳到靠后页码会串行发出数十次请求，实测一次 4 分钟）。本轮明确不改主库 schema；向量代际内的 `documents` 表新增 `revision` 列用于增量判断。详见 [CHANGELOG.md](CHANGELOG.md) 与 [运维记录](docs/OPERATIONS.md)。

2026-09-11 已按用户授权完成正式混合检索补充，作为应用 `0.2.0` / 数据库 `V13` 补充，不新增结构迁移。正式索引已发布并启用：`429,630` 份来源文档、`630,978` 个 chunks/vectors，`text-embedding-v4 / 1024`。2026-09-17 第十三轮完成增量维护改造后，实际启用代际为 `generation-2dfa743f-c1b4-4e41-8d9f-3d61c963e78a`，维护状态 `ready`，调度为每个开机周期一次。服务仍使用 [拾才工作台](http://127.0.0.1:4173)，实施细节、匿名质量限制和运维方式见 [补充交接记录](docs/handoffs/2026-09-10-search-hybrid-formal-supplement.md)；正式启用 smoke 证据见 [正式部署验证](docs/evidence/search-hybrid-formal-supplement-deployment.json)。

## 当前能力

- 候选人新增、编辑、搜索，以及按人才库、学历、学校、专业、求职状态、职位、来源、负责人和标签组合筛选
- 候选人基本资料、职业与教育摘要、求职偏好、来源历史、历史评估、授权记录和补充档案分区
- 独立人才库分组，支持新增、编辑、归档恢复和候选人多对多关联
- 职位新增、编辑、搜索、筛选、状态管理、软归档和恢复
- 候选人与职位多对多关联、事务式批量关联/解除和按职位导出
- 备注、真实活动记录、软归档和恢复
- 通用 CSV、XLSX、XLSM 和未加密 BIFF8 XLS 导入预览、字段映射、校验、去重和提交
- 北森 `应聘者ID` 专用增量导入，支持同一候选人跨批次补充字段，并按可选的申请和职位信息建立关系
- CSV、XLSX 导出，CSV 公式注入防护
- 候选人列表和默认详情采用隐私最小化投影，完整敏感资料只在本机显式加载
- PDF、DOCX、XLSX、XLSM、BIFF8 XLS、UTF-8 CSV/TXT 简历附件解析、身份定位、差异预览和确认保存
- 可选的 OpenAI-compatible 只读人才 Agent，包含互斥主导航/历史栏、会话持久化、安全 Markdown 和只展示已验证动作的执行时间线

附件解析先在本地完成确定性处理：PDF 文本按页面几何坐标重排为视觉行和列，表格/时间线等密集行保留标签、值、日期的行内顺序；只有确认两侧是独立的垂直栏时才按栏读取，无法稳定判断时保守地按视觉行输出。解析记录的 `raw_text` 保留这段完整的提取正文（包括供审计的 opaque token 和独立 `~` 噪声），只在公开 section、evidence 和 suggestion 投影中执行有界规则清洗。模型建议（如启用）只能补充结构化字段，不能替代或覆盖正文，也不会绕过用户确认写入候选人。扫描件或没有文本层的 PDF 仍不提供 OCR；本链路不依赖视觉模型或外部服务。

### 2026-08-25 V13 工作年限宽容处理

- `years_experience` 现在是可空数值投影，新增 `years_experience_raw` 保存非空来源原文，响应用 `years_experience_display` 提供展示文本。明确的 `0` 保持为 `0`；`经验不详`、范围或带修饰的文本保留原文且数值为 `null`；没有来源值时原文为空、数值为 `null`、展示为空白，不显示字面量 `null`。
- 通用/北森导入和附件预填充不再因工作年限格式单独拒绝行；新的非空来源值成对更新原文和数值投影，增量导入的空单元格不清除旧值。电话、邮箱及其他身份冲突仍按原有规则阻断。
- 档案、列表和导入预览优先显示原文，CSV/XLSX 既有“工作年限”列优先导出原文；数值排序/筛选仅使用安全数值投影。`/resume-search` 的 `min_years`、`max_years` 仍保留 API 文档所述的兼容查询输入限制，这不是存储或导入上限。
- schema V13 是加法且幂等的迁移 `(13, 'candidate_years_experience_raw')`。Task 7 已完成最多 100 条的历史只读样本预览，脱敏聚合记录见 [V13 工作年限导入证据](docs/evidence/v13-years-experience-import-20260825.json)；该条为 V13 历史验收记录；`0.2.0` 发布时正式库在本次启动前后均核对为 schema V1-V13。

### 2026-08-21 入职信息字段

- 候选人档案新增 `hire_status`（入职状态）、`hire_date`（入职日期）和 `hire_position`（入职职位）；三字段可在档案编辑区维护，并在详情、CSV/XLSX 导出中显示。
- 数据库通过幂等 schema V11/V12 增加三列和查询索引；升级不会重建、清空或自动改写既有候选人。`hire_date` 统一保存为 `YYYY-MM-DD`，允许未来日期；日期非空而状态为空时写入精确值 `不确定`。
- `hire_status` 保留来源系统的非空文本（最多 200 个字符），不强制枚举。它不替代 `candidate_preferences.employment_status`（求职偏好），也不把旧 `candidates.stage` 自动转换为入职状态。
- `hire_position` 保留来源职位文本并去除首尾空白（最多 300 个字符）。北森的 `入职雇佣关系` 只保留在来源快照，不当作 `hire_status`；`入职职位` 是入职事实，不代替招聘职位。
- 北森和通用表格导入识别入职字段；同一候选人增量导入时空值不会清除已有入职字段，且只传日期的 PATCH 不会覆盖已有明确状态。北森字段 `最后职位类投递的职位id` 用于招聘职位关系（必要时按候选人和投递时间匹配历史职位），不能用 `入职职位` 猜测关系；整份工作簿存在该专用表头时，单行空值不回退普通 `职位编号`，仅整表缺该表头才允许兼容回退。
- 批量清理脚本只保留入职状态非空且不等于精确文本“空”的源行，原始 `.xls` 文件保持不变；若源文件只有入职日期，导入预览会显示 `不确定`，不会把 `入职雇佣关系` 静默转换为状态。

工作区当前版本为应用 `0.5.0`（开发中，尚未正式部署），上一次已发布版本为 `0.2.0`；代码与正式库 schema 基线均为 `V13`，本轮没有新增结构迁移。V12 的历史正式 HTTP 导入记录保持不变；Task 7 只读样本证据是历史验收记录，不替代本轮正式批量导入证据。迁移、接口、字段映射、清理文件和验证命令见 [CHANGELOG.md](CHANGELOG.md)、[docs/DATA_MODEL.md](docs/DATA_MODEL.md)、[docs/API.md](docs/API.md)、[docs/FIELD_MAPPING.md](docs/FIELD_MAPPING.md)、[docs/IMPORT_GUIDE.md](docs/IMPORT_GUIDE.md) 和 [docs/TESTING.md](docs/TESTING.md)。

去重只使用标准化后的邮箱、手机号或 `source_system + source_record_id`。系统不会仅凭姓名自动合并候选人，身份键指向不同记录时会拒绝自动更新。

附件身份识别中，“未提取”只是页面根据空值显示的占位文案，不是手机号或邮箱。服务端会先过滤空值和精确的“未提取”，再分别验证、规范化并去重手机号和邮箱；一个真实身份值加占位值只计一个，两个不同的有效真实值仍会阻断自动定位。修复前已经生成的错误预览不会自动改写，升级后请重新上传原附件。

候选人的 `current_title` 表示其当前任职，招聘职位保存在独立的 `positions` 表中。候选人与职位可以多对多关联，但当前没有可运行的“职位申请流程”。旧 `candidates.stage` 仅为兼容历史数据而保留，默认页面、普通导入映射和 Agent 都不展示或使用它。

北森专用导入只要求第一张工作表包含大小写准确的 `应聘者ID`。相同 ID 可跨文件、跨批次用非空值补充或更新字段，包括用非空姓名纠正旧姓名；同一文件中后出现的非空标量覆盖先出现值，空单元格不会清除旧值，标签取并集且最多 50 个。姓名始终不是自动合并键。新 ID 仍必须有姓名，手机或邮箱命中其他候选人时会阻断并要求人工复核。系统不会按姓名或当前行序生成稳定身份。

`申请ID` 和职位信息为可选项。申请 ID 只有在职位关系可以建立或该行有真实面试/测评等评估载荷时才参与重复和归属校验；其余不完整关系只跳过，不阻断候选人资料。已归属另一候选人的有效申请 ID 绝不会改绑。重复提交同一文件不会重复创建候选人、职位或关系，但会更新候选人的 `updated_at`、`import_batch_id` 并追加导入更新活动，因此属于重放安全，不是严格状态幂等。

支持 `.xlsx`、`.xlsm`、UTF-8 `.csv` 和未加密的 Excel 97-2003 BIFF8 `.xls`。伪装扩展名、加密文件及非 BIFF8 `.xls` 会被拒绝。已审计的三份真实 `.xls` 中，前两份没有精确 `应聘者ID`，因此不能与第三份自动跨文件合并；正式分批迁移应重新导出带该字段的文件。

## 快速启动

前置条件：Windows 和 Node.js 24 或更高版本。

双击 `start.cmd`，或在 PowerShell 中运行：

```powershell
.\start.ps1
```

脚本会校验 Node.js 和依赖锁；只有首次启动、关键依赖缺失或锁文件变化时才安装依赖，然后构建前端并启动应用。完成首次安装后，日常候选人管理可离线使用。浏览器访问：

```text
http://127.0.0.1:4173
```

当前个人版强制只监听本机回环地址，不能作为部门共享服务器直接暴露到局域网或互联网。

## Agent 配置

模型密钥只通过服务端环境变量读取，不会写入浏览器代码：

```powershell
$env:AGENT_BASE_URL = "https://your-gateway.example/v1"
$env:AGENT_API_KEY = "your-key"
$env:AGENT_MODEL = "your-model"
# Only for an approved HTTPS gateway whose DNS answers are company-private.
# Use exact hostnames; never use an IP literal or wildcard.
# $env:ATTACHMENT_TEXT_TRUSTED_PRIVATE_HOSTS = "text.corp.example"
.\start.ps1
```

当前 Agent 提供 20 个只读工具，覆盖受控 SQLite 查询、业务聚合、候选人/职位/人才库检索、全业务字段 FTS、附件文本、互联网检索和本地 CSV artifact。数据库访问使用独立只读连接、实时字段目录与 SQLite authorizer；Agent 不能执行新增、修改、关联、归档、恢复、附件确认或删除操作。

若 `AGENT_BASE_URL` 指向远程网关，用户问题、最近对话和当前问题所需的受控工具证据会发送到该网关，因此 Agent 不属于完全离线功能。按当前产品授权，证据可能包含未打码的候选人业务字段；请只配置经批准的模型网关。核心候选人管理不配置 Agent 也可正常使用。

文本附件建议通道默认拒绝解析到私网的网关。只有 HTTPS 端点的精确 DNS 主机名列入 `ATTACHMENT_TEXT_TRUSTED_PRIVATE_HOSTS` 时，才允许其 DNS 结果全部为 RFC1918/IPv6 ULA 私网地址；该配置不接受 IP 字面量、通配符、后缀匹配或混合公网/私网结果。配置变更后需重启服务。

## 数据与备份

默认数据库位于 `data/recruitment.db`，其中同时保存候选人、人才库、职位、关系、档案分区、求职偏好、来源历史、评估、授权、备注、活动和导入批次。停止应用后复制整个 `data` 目录即可完成一致性备份；恢复前先备份当前目录，再用备份文件替换。

通常不要把真实候选人数据、`.env`、数据库文件或导出文件提交到 Git。为满足本次明确交付要求，7 份 `_已整理.xlsx` 暂作为受控本地导入准备文件保留；它们不是源码、备份或测试夹具，进入共享仓库前应按组织策略移出版本控制并单独保管。项目已默认忽略 `data/`、`.env` 和测试输出目录。

## 验证

```powershell
npm test
npm run build
npx tsc --noEmit
npm audit

node tests/browser/responsive-scale-qa.mjs
node tests/browser/surface-navigation-qa.mjs
node tests/browser/talent-workspace-qa.mjs
node tests/browser/avatar-component-qa.mjs
node tests/browser/workspace-polish-qa.mjs
node --test --test-concurrency=1 tests/backend/search-keyword-recall.test.mjs
```

当前人才库领域 V2 已通过自动化后端测试和生产构建。第十四轮 `npm test` 为 733 项、719 通过、7 个与基线一致的既有失败、7 跳过，没有新增失败；新增的混合检索修订回归包含无关写入不误伤和真实代际发布自动重试。头像组件 QA 和 375/768/1440 三视口匿名浏览器 QA 均通过且无新增 console error。第十二轮既有的 93/93 响应式矩阵、11/11 导航表面和 32/32 工作流证据继续保留在 [第十二轮验收](docs/evidence/talent-redesign/acceptance.md)。真实北森候选人文件的正式 dry-run 仍需在隔离数据库中单独执行。

## 文档

完整文档入口见 [docs/README.md](docs/README.md)，重点包括：

- [产品范围与验收](docs/PRODUCT_SPEC.md)
- [架构设计](docs/ARCHITECTURE.md)
- [本地 API 参考](docs/API.md)
- [数据模型](docs/DATA_MODEL.md)
- [界面设计规范](docs/UI_DESIGN.md)
- [候选人导入指南](docs/IMPORT_GUIDE.md)
- [Agent 安全边界](docs/AGENT_SECURITY.md)
- [隐私与数据治理](docs/PRIVACY.md)
- [启动、备份与恢复](docs/OPERATIONS.md)
- [测试与验收](docs/TESTING.md)
- [迭代路线图](docs/ROADMAP.md)
- [技术决策记录](docs/DECISIONS.md)
- [迭代记录](docs/ITERATION_LOG.md)
- [安全说明](SECURITY.md)
- [版本变更](CHANGELOG.md)
- [贡献与维护规范](CONTRIBUTING.md)
- [第三方依赖许可证](THIRD_PARTY_NOTICES.md)

## 许可证

项目代码采用 MIT License，第三方依赖遵循各自许可证。

## 2026-08-27 正式批量导入记录

A 组“人才库简历”18/18、B 组“应聘者数据”7/7 已按预览-确认-提交顺序完成正式导入。B 组实际结果为 1,390 行全部更新、0 导入/跳过/失败；详细汇总、失败表和脱敏证据见 `output/candidate-import-final-report-20260827.md`、`output/candidate-import-b-failed-rows-final-20260827.csv` 和 `docs/evidence/beisen-candidate-import-b-20260827.json`。原始文件只读，源文件哈希前后匹配。
