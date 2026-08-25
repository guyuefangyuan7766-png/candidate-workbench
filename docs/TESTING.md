# 测试说明

## 测试边界

自动测试覆盖个人版本地后端：

- 候选人 CRUD、身份去重、备注、活动、单条/批量归档、恢复和受控永久删除。
- 职位增量建表、CRUD、筛选、状态、单条归档和版本绑定的事务式批量归档。
- 候选人与职位多对多关联、事务式批量关联/解除和幂等重放。
- 人才库分组 CRUD、单条/批量归档与恢复、已归档分组单条/批量永久删除、候选人多对多关联和人才属性筛选。
- 人才档案分区、求职偏好及敏感/非敏感详情投影。
- `schema_migrations` V1-V13 幂等加法迁移、旧候选人兼容、证件照/人口字段回填、双实体最小删除审计、附件/清理/查询审计、持久会话/任务、全业务字段 FTS5 同步、入职字段索引和 V13 工作年限原文/数值投影。
- 按职位与未分配候选人筛选、仪表盘和候选人导出。
- 通用候选人表格导入导出、北森 `应聘者ID` 增量导入、招聘职位匹配/自动创建/歧义阻断、BIFF8 `.xls` 解析，以及可配置的大文件字节边界和解析资源限制。
- 候选人/职位一次性 token 单条与批量永久删除、事务回滚、附件物理清理入队和最小审计。
- Agent 独立 SQLite 全字段只读连接、authorizer、防绕过、结构化查询/聚合/导出、审计和 Top-K 上下文控制。
- Agent 回复的角色隔离 Markdown/GFM 渲染、raw HTML 禁用、危险 URL/远程图片阻断及安全外链属性。
- PDF、DOCX、XLSX、XLSM、BIFF8 XLS、UTF-8 CSV/TXT 简历附件，身份匹配、字段选择、SHA-256 幂等、清理重试和 FTS5 证据检索。
- V11/V12 入职字段：旧库加法迁移与幂等性，`hire_position`/`hire_status`/`hire_date` CRUD，长度、非法/未来日期、日期非空但状态为空时回退为精确文本 `不确定`，通用别名、北森导入、CSV/XLSX 导出和文档契约。
- V12 档案与北森关系语义：三项入职字段全空时只隐藏档案“入职信息”区块；`入职职位` 只写 `candidates.hire_position`，`最后职位类投递的职位id` 才建立 `candidate_positions`，`入职雇佣关系` 只保留在来源 `raw_payload`。
- 七份清理工作簿：`scripts/clean-hire-status-workbooks.mjs` 提供逐文件清理入口，`tests/backend/hire-status-workbooks.test.mjs` 提供生成物专项验证入口；两者检查只保留入职状态非空且不为精确文本“空”的行、表头顺序、行数守恒、日期/ID 对齐、日期格式和公式错误。该条描述验证范围，不预先宣称 fresh 通过数字。

测试使用内存 SQLite、临时 SQLite 文件和临时本地 HTTP 服务，不连接北森、真实模型服务或正式数据库。

当前没有提交到仓库的完整浏览器自动化套件。职位管理迭代和人才库 V2 均使用隔离数据库完成了 Playwright CLI 验收；V12 真实北森文件已完成服务端 100 人隔离预览与提交验证，但正式启动脚本双击体验、浏览器入口预览和正式数据库提交仍需真实环境验收。

## 环境要求

- Node.js 24 或更高版本。
- 已安装 `package-lock.json` 对应依赖。
- Windows PowerShell 或兼容终端。

## 自动检查命令

```powershell
npm test
npx tsc --noEmit
npm run build
npm audit --audit-level=low

# V11/V12 字段、导入/导出与文档契约
node --test tests/backend/hire-status-v11.test.mjs
# 候选人档案 UI 契约（含入职字段）
node --test tests/backend/candidate-demographics-ui.test.mjs
# 北森 BIFF8、入职字段映射与超长状态回归
node --test tests/backend/xls-import.test.mjs
# 清理后的七份工作簿（生成后运行）
$env:HIRE_STATUS_WORKBOOKS_REQUIRED = '1'
node --test tests/backend/hire-status-workbooks.test.mjs

node --check server/database.js
node --check server/candidates.js
node --check server/positions.js
node --check server/talent.js
node --check server/import-export.js
node --check server/import-file.js
node --check server/import-file-worker.js
node --check server/beisen-import.js
node --check server/agent.js
node --check server/readonly-query.js
node --check server/readonly-query-worker.js
node --check server/resume-search.js
node --check server/attachment-parser.js
node --check server/attachment-parser-worker.js
node --check server/attachments.js
node --check server/deletions.js
node --check server/app.js
node --check server/index.mjs
```

### V13 工作年限专项门禁（Task 7 已执行）

```powershell
node --test tests/backend/years-experience-import.test.mjs tests/backend/xls-import.test.mjs tests/backend/attachment-semantic-parsing.test.mjs tests/backend/attachment-candidate-prefill.test.mjs tests/backend/candidate-demographics-ui.test.mjs
npm test
npx tsc --noEmit
npm run build
git diff --check
```

专项测试覆盖原文保留、可空数值投影、明确 `0`、未知文本、空值、V12→V13 加法迁移与幂等、通用/北森导入、附件确认、API/UI 展示和 CSV/XLSX 导出。工作年限格式不能单独产生行错误；电话/邮箱错误或身份冲突仍须可见。Task 7 已完成指定工作簿最多 100 条只读预览，脱敏聚合记录见 [v13-years-experience-import-20260825.json](evidence/v13-years-experience-import-20260825.json)。该证据不表示 V13 已正式部署或迁移正式库；两项生产操作尚未执行。

2026-08-21 Task 4/5 focused fresh 结果：`node --test tests/backend/hire-status-v11.test.mjs` 为 5/5 通过，`node --test tests/backend/candidate-demographics-ui.test.mjs` 为 3/3 通过，`node --test tests/backend/xls-import.test.mjs` 为 7/7 通过；在 PowerShell 中设置 `$env:HIRE_STATUS_WORKBOOKS_REQUIRED = '1'` 后运行 `node --test tests/backend/hire-status-workbooks.test.mjs` 为 8/8 通过、0 跳过。后者覆盖七份工作簿逐文件表头、行数、日期/ID 对齐、公式错误、渲染结果和五类硬链接 alias 回归。本轮 focused 门禁合计 23/23。

## 2026-08-21 V11 最终门禁记录

已完成的专项结果：

- `hire-status-v11`：5/5 通过。
- `xls-import`：7/7 通过。
- 强制真实工作簿专项：8/8 通过、0 跳过；七份输出共保留 1,390 行、移除 61,471 行，4 行保留记录的入职日期为空，原始 `.xls` SHA-256 未变化。

- 完整门禁（在清除宿主预设的视觉/Agent 环境变量的清洁子进程中执行）：

- `npm test`：532 项，531 通过、0 失败、1 跳过。
- `npm run build`：退出码 0；TypeScript 与 Vite 通过，转换 1,858 个模块；仅有主 chunk 超过 500 kB 的常规提示。
- `git diff --check`：退出码 0、无输出。最终工作树审计确认用户原有附件改动保留，未回滚或纳入 hire-status 功能结论。

测试环境说明：视觉解析测试的“配置不完整”分支要求没有外部 `ATTACHMENT_VISUAL_*`/`AGENT_*` 变量；若宿主预设这些变量，必须在隔离子进程中清除变量后运行完整套件。变量名可记录，变量值（尤其 API key/endpoint）不得打印。

### 正式数据库 V11 迁移与完整性收尾（2026-08-21）

- 维护窗口先停止旧服务 PID `32716`，并将同一时点的 `recruitment.db`、`recruitment.db-wal`、`recruitment.db-shm` 备份到 `backups/pre-v11-hire-status-20260821-111600/data/`；正式库未用于自动化测试、工作簿生成、截图、删除或附件解析。
- 以 `data/recruitment.db` 为显式目标执行幂等 V11 加法迁移，迁移连接关闭后完成 checkpoint；该时点主库文件为 `22,021,361,664` bytes，关闭时 WAL/SHM 已清理，服务重启后出现的运行时 WAL/SHM 属于 SQLite 正常运行状态。
- 脱敏只读核对结果：`schema_migrations` 为 V1-V11；`candidates` 含 `hire_status TEXT`、`hire_date TEXT`；两个入职字段索引均存在；`PRAGMA integrity_check` 为 `ok`；`PRAGMA foreign_key_check` 为空（0 条异常）。
- 该核对只验证 schema、对象存在性和完整性，不读取或输出候选人姓名、联系方式、原始载荷、附件正文、会话正文或搜索命中内容；结构化记录见 [v11-formal-deployment.json](evidence/v11-formal-deployment.json)。
- 备份文件集 SHA-256 已在证据文件中逐项记录（`.db`、`-wal`、`-shm`），用于后续恢复核对；正式数据库只做加法迁移和健康检查。
- 迁移后服务 PID `22096` 监听 `127.0.0.1:4173`；`GET /api/health` 返回 HTTP 200、`status=ok`，启动 stderr 为空。该健康检查未执行业务写入、删除、搜索或候选人明文抽查。
- 工作簿专项完成后已删除 `.tmp-hire-status-artifact`（渲染 PNG、导出暂存和 inspect sidecar）；该目录不作为交付物或备份，复跑专项前由清理脚本按需重新生成。

## 2026-08-21 V12 入职信息与 100 人隔离验收

V12 `candidate_hire_information` 是在 V11 基础上的加法迁移：新增 `candidates.hire_position TEXT` 和 `candidates_hire_position_idx`，保留既有 `hire_status`、`hire_date`、旧候选人及其索引，不重建、不清空候选人表。专项测试覆盖迁移幂等、300 字符职位上限、200 字符状态上限、日期规范化、显式状态保护、空增量值不清除旧值，以及三项全空时档案区块不展示但候选人仍保留。

脱敏真实文件验证使用 BIFF8 `.xls` 的首个工作表：191 列、10,000 行，其中 135 行有 `入职日期`；源文件没有精确 `入职状态` 表头，但有 `入职职位` 和 `入职雇佣关系`。从中选取 100 条有日期且通过现有校验的记录，在隔离流程完成预览和提交：

- 预览为 `profile=beisen_talent`、100 行有效、0 行无效，36 行具有非空 `最后职位类投递的职位id`。
- 提交目标仅为 `:memory:` SQLite：导入 100 位候选人，创建 31 个职位和 36 条 `candidate_positions` 关系。
- 提交后 100 位候选人均具备完整入职字段、人才库关系和来源记录；36 条候选人职位关系与非空关系键逐行对应。
- `入职职位` 只进入 `hire_position`；日期有值但源文件没有显式状态时写入精确状态 `不确定`；`入职雇佣关系` 仅保留在 `raw_payload`。
- `PRAGMA integrity_check=ok`，外键异常 0 条；证据不含姓名、联系方式、候选人 ID、原始载荷或预览 token。

脱敏结构化记录见 [v12-hire-information-import-20260821.json](evidence/v12-hire-information-import-20260821.json)。其中 `formal_database_commit=false`：上述结果证明当前代码和 100 人样本可在隔离库正确导入，不证明这些记录已写入 `data/recruitment.db`。2026-08-24 已由绑定正式 `data/recruitment.db`、后台写入暂停的维护服务完成正式 HTTP 预览/提交；文件 SHA-256 为 `7D92DB6C37B892F3237E490E5424CC367CE14C9CAAE3F3584FB3083AD0A6C741`，预览为 100/100/0、`existing_duplicates=100`、职位 create/match/link/conflict 为 0/32/36/0，提交为 0 导入/100 更新/0 失败/0 跳过/100 候选人、`positions_created/matched=0/32`、`links_created=0`、`pools_created=0`、`application_count=0`。前 20 条预览的入职职位/日期/`不确定` 状态及人才库、来源预览通过。脱敏证据见 [v12-hire-information-formal-import-20260824.json](evidence/v12-hire-information-formal-import-20260824.json)。用户明确豁免 22GB 全库摘要、100 行逐项字段查询、`integrity_check`/外键后检与恢复演练；这些不是已完成结论。

以下 42/42 是进入 V6 前的 V5 收尾基线，不能用来宣称 V6 已验收。V6 最终结果必须在全部代码收敛后重新执行并记录在后续章节：

- `npm test`：42/42 通过。
- `npx tsc --noEmit`：通过（并由 `npm run build` 再次执行）。
- `npm run build`：通过。
- `npm audit --audit-level=low`：0 个已知漏洞。
- Playwright 1440x900 / 390x844：通过；控制台 0 错误、0 警告，根页面无横向溢出。

## 2026-08-05 V5 历史最终验收

- 自动化：`npm test` 42/42 通过；永久删除、归档事务、职位自动创建/匹配/重放/歧义阻断和事务回滚均通过。`npx tsc --noEmit`、`npm run build` 通过，`npm audit --audit-level=low` 为 0 个已知漏洞；服务端关键模块 `node --check` 全部通过。
- 匿名环境：服务使用 `http://127.0.0.1:4188`，数据库为 `output/playwright/delete-autoposition-redesign-final/e2e.db`；正式数据库未用于自动化、截图、导入或永久删除测试。
- 职位导入浏览器验收：首次导入创建 1 个草稿职位并建立 2 条关系；重复导入匹配既有职位且创建职位/关系均为 0；歧义职位预览将行标记为失败并只生成失败批次，不写入候选人、职位或关系。
- 浏览器：桌面 `1440x900` 与移动 `390x844` 均通过，控制台 0 错误、0 警告，根页面 `scrollWidth === innerWidth`。截图：
  - `output/playwright/delete-autoposition-redesign-final/candidates-desktop-1440x900.png`
  - `output/playwright/delete-autoposition-redesign-final/candidates-mobile-390x844.png`
  - `output/playwright/delete-autoposition-redesign-final/positions-desktop-1440x900.png`
  - `output/playwright/delete-autoposition-redesign-final/positions-mobile-390x844.png`
  - `output/playwright/delete-autoposition-redesign-final/import-preview-desktop-1440x900-final.png`
  - `output/playwright/delete-autoposition-redesign-final/import-preview-mobile-390x844-final.png`
- 当时正式数据库：V5 加法迁移完成，schema `[1,2,3,4,5]`；候选人 57、归档 0、职位 0、人才库 14、照片 42，`integrity_check=ok`、`foreign_key_check=0`。V5 前备份为 `backups/pre-v5-formal-20260805-102510/`，`.db`、`-wal`、`-shm` 三件文件 SHA-256 逐项一致；正式库未被测试数据污染。后续历史状态见 V6/V7 章节，V8 当前状态见最新章节。

## 历史 31 项后端自动测试

下表是人才库 V2 与证件照迭代的历史基线，不是本轮完整套件计数。

测试集中在 `tests/backend/api.test.mjs` 和 `tests/backend/xls-import.test.mjs`。

| # | 测试主题 | 主要覆盖 |
| ---: | --- | --- |
| 1 | 职位表增量创建 | 旧候选人保持不变；新增两表、复合主键和外键 |
| 2 | 职位和关系完整流程 | 职位校验/CRUD/筛选、准确候选人数、全局阶段不变、职位筛选与导出、关联冲突、关闭/归档限制、暂停职位关联、事务式批量解除、活动和仪表盘 |
| 3 | 候选人查询边界 | 重复参数、非法枚举、超长文本和越界分页返回安全 `400 invalid_query` |
| 4 | 搜索、标签和导出一致性 | 搜索覆盖来源/职位，标签精确匹配，LIKE 转义，CSV 集合与列表一致 |
| 5 | 稳定分页与导出排序 | 同排序值使用候选人 ID 作为稳定次级键 |
| 6 | 候选人生命周期 | 创建、更新、备注、活动、归档恢复、候选人统计和非姓名去重 |
| 7 | CSV/XLSX 导入导出 | 中文表头、规范化、预览令牌、批次提交和两种导出 |
| 8 | 无效行去重污染 | 无效行不占用文件内身份键 |
| 9 | 导入身份冲突 | 预览和提交时跨候选人 `identity_conflict` 均拒绝更新 |
| 10 | CSV 公式注入 | CSV 中和危险首字符，XLSX 保留字符串 |
| 11 | V2 历史 Agent 工具白名单 | 当时固定的最小只读工具且无写工具；工具数量和禁止 SQL 的旧结论已由 V6 全字段只读层取代 |
| 12 | V2 历史 Agent PII 最小化 | 当时验证联系方式脱敏及薪资/备注/活动不外发；该读取范围已由 V6 用户授权的未打码全字段按需读取取代 |
| 13 | 结构化兼容导入 | 重放幂等，同名不同邮箱可共存 |
| 14 | 人才库 V2 与头像增量迁移 | V1-V4 迁移幂等，旧候选人和旧 `stage` 不被改写；v3 增加 `photo_url`，v4 只从合法既有来源值回填空字段且活动不含 URL；八张领域表和外键保持完整 |
| 15 | 人才库与安全投影 | 人才库 CRUD/关联/筛选、档案分区、求职偏好、活动记录，以及默认详情与显式敏感详情的字段边界 |
| 16 | 北森完整关系 XLSX 导入 | 以候选人 ID 预览和提交，提供申请/职位信息时保留申请血缘、创建或匹配职位，并验证重放不重复创建实体或关系 |
| 17 | 北森候选人分批增量 | 只要求精确 `应聘者ID`；同文件和跨批次合并稀疏字段、非空姓名纠正、空值不清除、标签并集、原始载荷非空合并，关系信息可选 |
| 18 | 北森新增与冲突边界 | 新 ID 必须有姓名；已有 ID 可省略姓名；手机或邮箱命中其他候选人时阻断 |
| 19 | BIFF8 `.xls` 通用预览 | 匿名 Excel 97-2003 工作簿进入正常预览流程 |
| 20 | BIFF8 `.xls` 北森识别 | 含精确 `应聘者ID` 的匿名工作簿进入北森增量轮廓 |
| 21 | 伪 `.xls` 拒绝 | 仅改扩展名、没有 OLE2 文件签名的输入返回安全 `422` |
| 22 | 损坏 `.xls` 拒绝 | 有 OLE2 签名但容器损坏的输入返回安全 `422` |
| 23 | 同职位编号多行聚合 | 合并同一职位编号的非空职位元数据，并将职位正确关联到相应候选人 |
| 24 | 申请 ID 归属与竞态 | 文件内跨候选人冲突、数据库既有归属及预览后提交竞态均阻断，既有申请绝不改绑 |
| 25 | 行计数与标签上限 | 导入/更新/跳过/失败源行计数守恒；`candidate_count` 按成功候选人去重；跨批次标签有序并集最多 50 个 |
| 26 | 无效候选人行隔离 | 失败行不污染同 ID 有效行的候选人字段、职位、关系或来源 `raw_payload` |
| 27 | 无效申请行隔离 | 重复或冲突申请行不污染有效行聚合出的职位元数据和候选人关系 |
| 28 | 可选申请 ID | 没有可建立的职位关系和真实评估载荷时，重复申请 ID 只作为未使用信息跳过，不阻断候选人 |
| 29 | 评估字段分类 | `自我评价` 写入 `self_summary`；Offer/录用仅作来源留档；只有真实面试等评估载荷进入历史评估 |
| 30 | 证件照头像安全投影 | 校验 HTTP/HTTPS 协议及 `.jpg`/`.jpeg`/`.png`/`.webp` 路径扩展名并允许签名查询参数；普通列表/详情只返回 `has_photo`，敏感详情才返回原始 URL；头像端点 302、private cache、no-referrer；默认导出排除照片 |
| 31 | 北森证件照分批增量 | 相同 `应聘者ID` 可在后续批次非空补充证件照；预览只返回 `has_photo` 且不泄露签名参数 |

第 2 项还验证：

- 同一候选人职位关系不会改变全局 `stage`。
- `Candidate.positions[].candidate_count` 是该职位真实关系计数。
- 重复关联返回已有数量，不重复创建关系或活动。
- 批量关联和批量解除接受 1 至 100 个 ID，在事务内全成全败。
- 批量解除不存在关系时幂等，任一候选人不存在时整批关系保持不变。
- 已关闭或已归档职位不能新增关系，暂停职位可以关联和解除。
- 仪表盘返回职位统计、未分配候选人数和最近 7 天更新数。

## V5 历史新增自动化场景

新增测试文件为 `tests/backend/candidate-deletion.test.mjs` 和 `tests/backend/import-position-autocreate.test.mjs`，至少覆盖：

1. 批量归档 ID 校验、100 人上限、输入去重、整批原子性和每位候选人的活动记录。
2. 已归档候选人拒绝编辑、备注、偏好/履历更新以及职位/人才库关系变更。
3. 活动候选人永久删除返回 `409`；旧单条接口曾校验确认词和显式版本。该协议已由 V6 一次性预览 token 取代。
4. 永久删除级联清除候选人主档及全部从属表，同时保留共享职位、人才库和导入批次。
5. `deletion_audits` 只含随机 ID、候选人 ID 的 SHA-256 和时间；不含候选人 ID 明文或测试 PII。
6. 删除后详情、列表、搜索、统计、导出、职位/人才库详情和 Agent 受控查询均不可再找到候选人。
7. 通用 CSV/XLSX/XLSM/BIFF8 `.xls` 的职位预览、稳定来源键匹配、标准化名称/部门/地点匹配、唯一同名匹配和草稿自动创建。
8. 歧义和归档职位冲突阻断；`current_title` 不产生招聘职位；重复提交不重复创建职位或关系。
9. 职位创建、候选人提交和关系写入事务回滚，不留下孤立职位或部分关系。

所有永久删除测试只使用 `:memory:` 或系统临时目录中的匿名隔离库，禁止把 `DB_PATH` 指向 `data/recruitment.db`。

## V6 自动化与浏览器验收矩阵

V6 测试集中在 `tests/backend/deletion-v6.test.mjs`、`position-deletion-api-v6.test.mjs`、`agent-readonly-v6.test.mjs`、`agent-api-v6.test.mjs`、`agent-attachment-suggestions-v6.test.mjs`、`resume-search-v6.test.mjs`、`attachments-v6.test.mjs`、`security-v6.test.mjs` 和既有回归文件。最终总数以当次 `npm test` 输出为准，不得根据源码中的 `test()` 数量推断。

| 领域 | 必须通过的场景 |
| --- | --- |
| 候选人删除 | 已归档单条/批量预览和提交；1-100 上限；活动目标 `409`；token 操作/ID/版本绑定、过期和重放；单条 URL ID 必须与 token 唯一目标一致且不能消费批量 token；任一目标不存在、恢复或版本变化整批回滚；所有从属、附件元数据、FTS/向量清理；共享职位/人才库/批次保留；物理清理失败可重试 |
| 职位删除 | 已归档单条/批量；活动职位 `409`；单条 URL ID 与 token 唯一目标一致；并发和原子回滚；职位/关系/从属清理；候选人、附件、备注、人才库完整；受影响候选人活动；职位最小审计；删除后所有读取面不可见 |
| 职位批量归档 | 1-100 个活动职位按 `expected_updated_at` 提交；成功、已归档、缺失、版本冲突、101 条和运行时写入失败；任一异常整批回滚且候选人/关系保持完整 |
| 人才库分组批量操作 | 活动分组归档、已归档分组恢复/永久删除；V6.1 UI 单条/批量均发送版本，服务端对批量及永久删除强制版本，旧单条归档/恢复允许无版本兼容但状态冲突仍为 `409`；缺失、状态/版本冲突、101 条及运行时失败全成全败；删除只移除分组和成员关系，候选人及其所有资料保持完整 |
| Agent Markdown | 标题、强调、列表、引用、链接、行内/块代码和 GFM 表格结构正确；仅 Agent 消息渲染；raw HTML、脚本、危险 URL、远程图片和提示注入文本不执行；外链 `noopener noreferrer` |
| 只读 SQLite | 文件型独立 `readOnly` 连接；`query_only` / `trusted_schema` / 禁扩展；SELECT、只读 CTE、聚合、排序、分页；INSERT/UPDATE/DELETE/DDL/ATTACH/写 PRAGMA 拒绝；多语句、注释、CTE 写入、未知表/列/函数和字段注入拒绝；100 行/1 MB/超时/页码/导出上限；审计不含结果正文 |
| Agent 全字段 | 匿名候选人的未打码手机、邮箱、薪资、照片地址、备注、活动、raw payload、履历、评估、授权和附件正文可按需读取；18 工具白名单；不存在写/删除/附件确认工具；大结果分页/聚合/导出，模型只接收 Top-K |
| FTS5 | 主档、工作/项目/教育/技能区块和附件文本同步；从全量匿名履历召回正确候选人；候选人级去重；得分、字段、片段、原因和分页；结构化地点/年限/关系筛选；FTS5 不可用明确失败 |
| 附件格式 | 匿名文本 PDF、DOCX、XLSX、XLSM、BIFF8 XLS、UTF-8 CSV/TXT 正常解析；宏不执行；表格逐行记录；原文件名清洗和随机私有路径 |
| 附件安全失败 | 伪扩展名、MIME/签名不匹配、`.doc`、加密/损坏文件、扫描/无文本 PDF、非法 UTF-8、路径穿越、ZIP bomb/ZIP64、页/表/行/列/文本/时间上限安全失败且无候选人写入 |
| HTTP 安全边界 | 不允许的 Origin 对 JSON 和 multipart 写请求均在请求体解析前返回 `403 origin_not_allowed`；不允许的预检返回 `403`；缺少 Origin、回环/配置 Origin 兼容；正常应用响应包含 `nosniff`、禁止 framing、no-referrer、受限 Permissions Policy 和含 `frame-ancestors 'none'` 的 CSP |
| 身份与确认 | 邮箱唯一、电话唯一、双字段一致、双字段冲突、多候选冲突、归档目标和无匹配；姓名不参与自动合并；预览不修改候选人；确认只写选择项；空值不清除；身份字段二次冲突；标签并集、履历去重/替换确认；版本/token 过期/重放；SHA-256 重复文件幂等；生产建议最多 120,000 字符/100 条记录、strict JSON Schema 且无 tools，网关失败保留本地建议；预览确认/取消/过期后擦除临时正文和记录 JSON |
| 浏览器 | 匿名文件型数据库和独立端口；活动职位选择/批量归档；人才库分组归档/恢复/永久删除；Agent Markdown 标题/列表/表格/代码；桌面侧栏展开、收起及刷新持久化；移动导航不回归；1440x900 和 390x844；控制台 0 error/0 warning；根节点无横向溢出 |

## 2026-08-05 V6 代码、匿名门禁与正式迁移验收

- 完整后端套件：`npm test` 78/78 通过；使用匿名内存/临时文件型数据库，没有连接正式数据库。
- 附件聚焦套件：`node --test tests/backend/attachments-v6.test.mjs` 10/10。测试使用匿名临时目录中的实际格式文件，覆盖文本 PDF、DOCX、XLSX、XLSM、BIFF8 XLS、UTF-8 CSV 成功解析（DOCX/XLSM fixture 使用 deflate），以及伪扩展名、损坏文件、无文本 PDF、加密输入、非法 UTF-8 和 15 MB + 1 字节输入安全失败；未使用真实候选人简历。
- 安全聚焦套件：`node --test tests/backend/security-v6.test.mjs` 2/2。第一项覆盖不允许的跨域 JSON/multipart 写请求在请求体解析前返回 `403 origin_not_allowed`、恶意预检返回 `403`、无 Origin 本机写入保持兼容，并断言正常响应的 `X-Content-Type-Options`、`X-Frame-Options`、CSP `frame-ancestors`、`Referrer-Policy` 和五项受限 `Permissions-Policy`；第二项伪造 Office ZIP 的声明大小，确认解析器按实际 inflate 结果返回 `422 zip_size_mismatch`。
- 实现核对：Office worker 复核 central/local entry，使用 `maxOutputLength` 并按实际单条、累计 64 MB 和压缩比限制输出。附件解析 worker 的 60 秒解析超时、空 `execArgv` 和 V8 `resourceLimits`（old generation 256 MB、young generation 64 MB、code range 32 MB、stack 4 MB）同样已核对；视觉适配器另有默认 15 秒出站请求超时，附件服务外层视觉调用预算默认 45 秒。这些限制不是整个 Node 进程的 RSS 硬上限。
- TypeScript：`npx tsc --noEmit` 通过。
- 生产构建：`npm run build` 通过；Vite 7.3.6 转换 1598 个模块。
- 供应链审计：`npm audit --audit-level=low` 返回 0 vulnerabilities。
- 服务端语法：`server/` 下 18 个 `.js` / `.mjs` 文件全部通过 `node --check`。
- 浏览器：在此前匿名文件型 SQLite 完整流程验收基础上，最终 1440x900 和 390x844 Playwright 复验修复 `.bulk-action-bar` 负 margin 导致的移动端遮挡；两种视口均为根节点宽度等于 viewport，控制台 0 error、0 warning。候选人和职位删除预览连接真实 API，但没有在正式库提交永久删除。
- V6 最终截图：`output/playwright/final-v6-security-20260805/desktop-1440x900-fixed.png`、`output/playwright/final-v6-security-20260805/mobile-390x844-fixed.png`。
- 正式数据库迁移显式绑定 `data\recruitment.db` 并成功完成；schema `[1,2,3,4,5,6]`，9 个 V6 预期表/虚表无缺失，履历同步 trigger 11 个，`candidate_resume_documents` 112 条并覆盖 70 位候选人，`candidate_attachments=0`、`candidate_resume_vectors=0`，`integrity_check=ok`、`foreign_key_check=0`。核对没有输出候选人行、附件正文或 `raw_payload`。

永久删除、附件解析、自动化和截图仍必须使用匿名隔离数据。正式 V6 加法迁移及不含明文的只读核对现已完成；正式库未上传测试附件、未提交候选人/职位永久删除，后续验收仍不得输出候选人明文。

## 2026-08-05 V6.1 批量操作、Markdown 与侧栏验收门禁

V6.1 不含数据库迁移。本轮浏览器验收使用显式匿名临时 SQLite 和独立服务 `http://127.0.0.1:4397`；正式服务 `http://127.0.0.1:4173` 未停止、未改写，也未用于归档、删除、自动化或截图。

- 完整自动化：`npm test` 84/84 通过。新增 `tests/backend/batch-archive-talent-pools.test.mjs` 覆盖职位批量归档和人才库分组归档/恢复/永久删除的成功、状态/版本/缺失/101 条冲突、运行时事务回滚及候选人资料保留；`tests/backend/assistant-markdown.test.mjs` 覆盖 Markdown/GFM 结构、角色隔离、raw HTML、危险 URL、远程资源和提示注入文本。
- TypeScript 与构建：`npx tsc --noEmit` 通过；`npm run build` 通过。构建唯一警告是 Vite 主 JavaScript chunk 为 556.32 kB，超过默认 500 kB 提示阈值；不影响构建产物生成，但后续可评估按路由或重型依赖拆包。
- 供应链与语法：`npm audit --audit-level=low` 返回 0 vulnerabilities；`server/app.js`、`server/positions.js`、`server/talent.js` 的指定 `node --check` 均通过。
- 1440x900：真实 API 完成活动职位选择与批量归档、人才库分组归档/恢复/永久删除；删除分组后匿名候选人仍为 3 位。Agent 标题、列表、表格、代码和安全 URL 策略显示正确。侧栏收起为 72px，刷新后保持；`clientWidth=scrollWidth=1440`，控制台 0 error、0 warning。
- 390x844：职位批量归档确认可用；人才库批量恢复入口可见并成功执行，永久删除确认可用；Agent Markdown 正确，移动导航与桌面收起按钮隔离。无页面横向溢出：常态 `clientWidth=scrollWidth=390`；弹窗前页面出现纵向滚动条时两者均为 375。控制台 0 error、0 warning。
- 桌面截图：`output/playwright/sidebar-collapsed-final-1440x900.png`、`output/playwright/positions-batch-archive-confirm-1440x900.png`、`output/playwright/talent-pools-delete-confirm-1440x900.png`、`output/playwright/agent-markdown-1440x900.png`。
- 移动截图：`output/playwright/positions-batch-archive-confirm-390x844.png`、`output/playwright/talent-pools-batch-actions-390x844.png`、`output/playwright/talent-pools-delete-confirm-390x844.png`、`output/playwright/agent-markdown-390x844.png`。
- 上述自动化、事务操作和截图全部使用匿名隔离数据；没有读取、输出或修改正式候选人资料、附件、模型凭据或其他敏感配置。

## 2026-08-05 V7 大文件导入与候选人人口字段验收门禁

V7 自动化使用 `tests/backend/large-candidate-import.test.mjs`、`candidate-demographics-v7.test.mjs`、`candidate-demographics-ui.test.mjs`、`import-file-security.test.mjs`、`import-service-guards-v7.test.mjs`、既有 `batch-archive-talent-pools.test.mjs` 和全部历史回归。以下数字均来自 2026-08-05 最终实际运行结果。

| 领域 | 必须通过的场景 |
| --- | --- |
| 上传配置 | 默认 `CANDIDATE_IMPORT_MAX_BYTES >= 64 MiB`；配置端点返回实际字节上限和资源限制；刚低于限制可进入解析、超过限制返回 `413` 与实际上限；简历附件仍为独立 15 MiB |
| 大文件资源安全 | 候选人上传使用随机磁盘临时文件；Office ZIP 的 central/local header、路径、加密、ZIP64、压缩方法、CRC、声明/实际解压大小和压缩比受控；解析 worker 可由父线程按墙钟超时终止；同实例限制解析并发；失败和超时后临时文件清理 |
| 数量语义 | 不存在候选人数或源行数业务硬上限；超过约 10,000 位但低于字节/资源限制的匿名文件不会因数量被拒绝；预览响应最多 20 行，统计覆盖全文件；提交事务失败不留下半批记录或关系 |
| 人口字段迁移 | V7 重复打开幂等；新增 `gender`、`birth_date`、`age` 和性别索引；既有北森来源载荷只填空值回填且不改变非空值或 `updated_at`；完整性和外键检查通过 |
| 人口字段 API/导入 | 性别别名、有效生日、0-120 年龄校验；CSV/Excel/北森导入保留三字段和外部 `source_record_id`；内部 UUID 不作为应聘者编号；有生日时计算展示年龄，否则回退来源年龄 |
| 筛选与导出 | `gender` 使用服务端参数化 SQLite 条件；列表、分页总数和导出一致；页面不显示专业筛选但 `major` 数据/API/导入/导出保持兼容 |
| 人才库删除回归 | 现有单条/批量永久删除路由对已归档分组可用；活动、缺失和版本冲突返回 `409`，最多 100 个且事务全成全败；只删除容器和成员关系，候选人所有资料保持完整；成功后前端不再请求已删除分组成员 |
| 浏览器 | 仅用匿名文件型 SQLite 和独立端口，在 1440x900 / 390x844 验证导入预览、已归档分组删除、详情人口字段和性别筛选；控制台 0 error/0 warning，根节点无横向溢出 |

大文件性能基准必须记录 fixture SHA-256、字节数、候选人数、预览/提交时间、进程峰值 RSS/heap、数据库计数、`integrity_check`、`foreign_key_check` 和临时目录清理结果。正式数据库不得用于生成 fixture、上传、提交、删除、截图或性能采样。

最终结果：

- `npm test`：107/107 通过；附件套件在与其他高内存门禁并行时曾有一次测试子进程退出，单独重跑 10/10 后再串行执行完整套件为 107/107，没有断言失败。
- `npx tsc --noEmit`：通过。`npm run build`：通过，Vite 7.3.6 转换 1852 个模块；主 JavaScript chunk 561.15 kB 的既有拆包提示仍存在。
- `npm audit --audit-level=low`：0 vulnerabilities。`server/` 下 20 个 JavaScript/ESM 文件全部通过 `node --check`。
- 匿名容量 fixture：`output/large-import-v7/anonymous-candidates-10241.csv`，50,908,096 bytes（48.5497 MiB），10,241 位候选人，SHA-256 `4d6c6bcc63e27843c6e2eb40ffb63273e45588c124179add955369458230a948`。
- 容量基准：预览 1,598.65 ms，提交 24,731.31 ms；预览响应 20 行但全文件汇总/提交均为 10,241。峰值 RSS 516.94 MiB，峰值 `heapUsed` 153.64 MiB，峰值 `heapTotal` 266.07 MiB。
- 基准数据库：候选人 10,241、来源记录 10,241、活动 10,241、导入批次 1；数据库 70.5469 MiB，`integrity_check=ok`、`foreign_key_check=0`，上传临时目录残留 0。整个基准使用临时文件型 SQLite，结束后删除隔离数据库。
- Playwright CLI 使用匿名服务 `http://127.0.0.1:4497` 和匿名模型网关 `4498`。1440x900 与 390x844 均完成 48.55 MiB 上传预览、服务端性别筛选、人口字段详情和已归档分组永久删除；移动端删除含 2 位成员的分组后候选人总数仍为 3。两种视口控制台均为 0 error/0 warning，根节点 `scrollWidth === clientWidth`。
- 截图：`output/playwright/v7-desktop-candidate-details.png`、`v7-desktop-large-import-preview.png`、`v7-desktop-talent-pool-delete-confirm.png`、`v7-mobile-candidate-details.png`、`v7-mobile-large-import-preview.png`、`v7-mobile-talent-pool-delete-confirm.png`。
- 正式库没有参与上传、提交、删除、性能或截图。加法迁移前的 `.db/-wal/-shm` 文件集位于 `backups/pre-v7-demographics-large-import-20260805-175449/`，逐文件哈希匹配且隔离恢复副本完整；迁移后 schema 为 V1-V7，三个人口字段及性别索引存在，`integrity_check=ok`、`foreign_key_check=0`。

## 2026-08-06 V8 持久会话、全业务字段检索与浏览器验收

V8 自动化、10,000 人性能基准和 1440x900/390x844 Playwright 阶段只使用匿名内存/临时文件型 SQLite 与匿名独立服务，没有读取或修改正式数据库。匿名门禁通过后，正式收尾只执行同一时点文件集备份、可丢弃恢复副本 V7→V8 门禁、正式加法迁移和无明文聚合核对；正式数据没有用于自动化、截图、性能、删除、上传或搜索内容验证。

新增或扩展的 V8 回归文件包括：

- `tests/backend/business-search-v8.test.mjs`
- `tests/backend/agent-sessions-v8.test.mjs`
- `tests/backend/agent-readonly-policy-v8.test.mjs`
- `tests/backend/assistant-v8-ui.test.mjs`
- `tests/backend/frontend-pagination-v8.test.mjs`
- 既有 `tests/backend/resume-search-v6.test.mjs` 兼容回归

覆盖范围：

| 领域 | 已自动验证的行为 |
| --- | --- |
| 加法迁移 | V8 对象幂等创建，旧候选人列与 V6 `candidate_resume_fts` 保留，不重建业务表 |
| 全字段覆盖 | 政策表全部非隐藏、非 BLOB 且未排除字段进入目录；手机号、邮箱、薪资、日期、数字、ID和嵌套 `raw_payload` 路径可搜索 |
| 长值与中文 | 4,000 Unicode code point 确定性分段可无损拼回；中文二元/三元 token 可召回 |
| 增量一致性 | INSERT/UPDATE/DELETE dirty trigger、pending/ready checkpoint、分批回填、表级/字段级 coverage、更新/删除后的旧证据清理 |
| 关系映射与 Top-K | 职位和人才库命中映射到同一候选人并去重；BM25、字段路径、段坐标、实际命中词、同义词扩展与重叠高亮正确 |
| 失败关闭 | FTS/coverage 未 ready 时返回 `search_index_not_ready`，不静默全表正文扫描 |
| 只读政策 | 业务敏感字段和审计可按需读取；会话/消息/摘要、附件预览/清理、迁移账本、搜索内部表、FTS shadow、附件路径和向量 BLOB 被目录与 authorizer 拒绝 |
| Agent 工具与审计 | 18 个白名单工具包含跨实体 `search_all_records` 和候选人级 `search_candidate_resumes`；SQL/FTS、索引同步、模型等待、工具执行和响应组装均生成不含问题、回复或敏感正文的分段审计 |
| 持久会话 | 会话 CRUD、活动/归档状态、消息游标分页、SQLite 级联删除、幂等完成/处理中重放、并发 busy、陈旧锁失败恢复、失败请求重放冲突和异步摘要 |
| 前端契约 | 只把活动会话 UUID 与历史面板开关写入 `localStorage`；会话 API、`client_request_id`、`before_sequence`、加载更早消息、重命名/删除和敏感正文不落浏览器存储的静态契约 |

实际结果：

- `node --test tests/backend/business-search-v8.test.mjs`：9/9 通过。
- V8 搜索与旧履历检索联合执行：14/14 通过。
- `npm test`：141/141 通过。
- `npx tsc --noEmit`：通过。
- `npm run build`：通过。
- `npm audit --audit-level=low`：0 vulnerabilities。
- 服务端 `node --check`：通过。
- `git diff --check`：通过（V8 实现、测试与文档阶段）。

### 匿名 10,000 人检索基准

最终快照时间为 `2026-08-06T04:07:27Z`。基准使用 `tests/performance/v8-anonymous-benchmark.mjs` 生成的临时文件型 SQLite。除全量回填为总耗时外，查询数字均为中位数；同一命令跨运行会受操作系统文件缓存和系统负载影响，应按同环境重复采样比较：

| 指标 | 结果 |
| --- | ---: |
| 匿名候选人 | 10,000 |
| 政策字段 coverage | 191/191，100% ready |
| 进入索引的源记录 | 40,641 |
| 最终 FTS 文档 | 446,259 |
| 全量回填总耗时 | 100.995 s |
| 候选人分页服务层 | 1.524 ms |
| 跨实体全字段检索（含证据） | 4.945 ms |
| 跨实体全字段只读 Worker 端到端 | 186.826 ms |
| 多概念候选人混合检索（进程内） | 1291.348 ms |
| 多概念候选人混合检索（只读 Worker 端到端） | 1432.082 ms |
| SQLite 结构化问答 | 11.341 ms |
| 结构化问答只读 Worker 端到端 | 106.051 ms |
| SQLite 文件 | 511.48 MiB |
| 主基准进程峰值 RSS | 150.297 MiB |
| 临时目录残留 | 0 |

多概念候选人混合检索的最终实现先为召回 Top-20 构建候选人范围关系子集，再为每个概念优先选择真实命中证据。基准同时覆盖进程内与只读 Worker 端到端路径；返回候选人数、每候选人 evidence 上限和 512 KiB 模型上下文限制均未扩大。

### 匿名双视口 Playwright

- 1440x900 与 390x844 均验证候选人列表和人才库成员为 20 条/页，45 条匿名数据共 3 页；桌面端页内全选后翻页会清空选择。
- Agent 刷新后恢复 4 条历史消息，后续提问携带并使用跨轮上下文；Markdown 历史布局保持稳定。
- Unity 全字段检索召回 45 条，每页 20 条，证据显示真实 `table` / `field`，命中内容使用安全 `<mark>` 高亮。
- 桌面侧栏在 72 px / 224 px 间切换，刷新后保持；移动端继续使用独立导航。
- 两种视口控制台均为 0 error、0 warning；根节点无横向溢出。
- 桌面截图：
  - `output/playwright/v8-candidate-pagination-1440x900.png`
  - `output/playwright/v8-talent-pool-pagination-1440x900.png`
  - `output/playwright/v8-agent-markdown-1440x900.png`
  - `output/playwright/v8-full-field-highlight-1440x900.png`
- 移动截图：
  - `output/playwright/v8-candidate-pagination-390x844.png`
  - `output/playwright/v8-talent-pool-pagination-390x844.png`
  - `output/playwright/v8-agent-history-390x844.png`
  - `output/playwright/v8-full-field-highlight-390x844.png`
- 侧栏截图：`output/playwright/v8-sidebar-collapsed-1440x900.png`。

### 正式备份、迁移与运行核对

2026-08-06 在匿名门禁全部通过后完成正式收尾。旧 PID `17212` 收到 SIGINT，日志记录 `Received SIGINT, shutting down`，进程退出后 `4173` 释放。正式源文件与 `backups/pre-v8-agent-history-full-search-20260806-122427/data` 中备份逐项一致：

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `recruitment.db` | 253,931,520 | `05b304c291caee6e859be9ad8f5fa3e5cfea63d3707a7eab1f71c5759b0bee8c` |
| `recruitment.db-wal` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `recruitment.db-shm` | 32,768 | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |

恢复副本先执行 V7→V8 门禁，候选人 8,209、职位 312、人才库 35、候选人职位关系 9,980、候选人人才库关系 6,224 在迁移前后均保持；19/19 张政策表和 191/191 个字段 ready，业务源记录 120,806、FTS 文档 2,629,351、dirty 0，`integrity_check=ok`、`foreign_key_check=0`。副本门禁约 813.2 秒，迁移后主库文件为 4,183,703,552 bytes。

正式库得到相同核心计数、coverage、文档数、dirty、完整性和外键结果，schema 为 `[1,2,3,4,5,6,7,8]`；记录的 `migration_ms=746418.831`（746.419 秒），最终主库文件为 4,183,719,936 bytes。该核对只读取 schema、状态和聚合计数，没有查询或验证候选人搜索内容。

新服务 PID 为 `7232`，仅在 `127.0.0.1:4173` 监听；health、会话和 schema 工具请求均返回 200。状态核对为 `readonly_connection=true`、`persistent_sessions=true`、`full_readonly=true`、18 个工具；向量检索关闭，fallback 为 `sqlite_fts5`，stderr 为 0。匿名基准和浏览器结果仍不能替代正式升级门禁，本节聚合核对也不能解释为正式候选人内容搜索验收。

## 2026-08-06 V9 Agent 大数据任务与故障隔离门禁

V9 的容量目标是约 100,000 位候选人，并使用 120,000 位匿名用例验证不存在人数硬上限。所有容量、故障注入和浏览器场景必须使用临时文件型 SQLite 与独立回环端口；正式库不得用于搜索压测、造数、截图或模型故障注入。

新增或扩展的回归包括：

- `tests/backend/agent-v9-async.test.mjs`：异步 `202`、`client_request_id` 幂等重放、无固定总工具调用/deadline、递增阶段超时、数据库证据门禁、超大快照重查、SQL 语义重复收敛、partial 上下文隔离、取消和任务自动恢复。
- `tests/backend/business-search-v8.test.mjs`：fast Top-K 不计算精确总数、`has_more`、分页和 FTS 有界命中过采样，并断言 dirty 刷新后 `checkpoint.document_count` 与搜索文档表保持一致；文件名保留 V8 是因为其同时覆盖 V8 索引兼容。
- `tests/backend/formal-v9-migrate-safety.test.mjs`：嵌入式正式迁移与仓库 schema 一致、缺失前置条件时完整回滚、checkpoint 边界、目录互斥、源码闭包、maintenance sentinel、启动阻断和提交后恢复要求。
- `tests/performance/v8-anonymous-benchmark.mjs --capacity`：分批生成高密度匿名候选人、经历和关系，回填全字段 FTS，测量结构化、FTS、混合检索、响应字节及主进程/只读 Worker RSS；脚本名保留 V8 是因为它继续验证同一索引格式。

2026-08-06 已完成的历史聚焦门禁：

| 命令 | 结果 |
| --- | --- |
| `node --test tests/backend/business-search-v8.test.mjs tests/backend/agent-v9-async.test.mjs tests/backend/assistant-v8-ui.test.mjs tests/backend/database-migration-idempotence-v9.test.mjs tests/backend/formal-v9-migrate-safety.test.mjs` | 39/39 通过，0 fail/cancel/skip，12,499 ms |
| `node --test tests/backend/business-search-v8.test.mjs tests/backend/agent-v9-async.test.mjs tests/backend/formal-v9-migrate-safety.test.mjs` | 当日重跑 30/30 通过（13 + 9 + 8），0 fail/cancel/skip，14,516.990 ms |
| `tests/backend/business-search-v8.test.mjs` | 13/13 通过，包括 all-record page/evidence 有界 posting SQL 契约 |
| `npm test` | 169/169 通过，0 fail/cancel/skip，119,530 ms；预期故障注入的 Error 堆栈不计为失败 |
| `npx tsc --noEmit` / `npm run build` | 通过；构建 1,852 modules，只有 599.27 kB JS chunk size 非阻断提示 |
| `npm audit --audit-level=low` | 0 vulnerabilities |
| 22 个 `server/*.js`，以及 `server/index.mjs`、`scripts/formal-v9-migrate.mjs` 的 `node --check` | 全部通过 |

2026-08-07 本轮实现收敛后的当前验证证据：

| 命令/门禁 | 结果 |
| --- | --- |
| `npm test` | 202/202 通过，fail 0，125,393 ms；使用串行后端测试脚本，不连接正式数据库 |
| 6 个 Agent 专项文件 | 44/44 通过，0 fail/cancel/skip，29,862 ms |
| Agent V8 / V9 定向套件 | 9/9、19/19 通过 |
| 附件解析与工作流专项 | 32/32 通过 |
| `node --check`（本轮修改的 2 个 Agent 实现与 2 个测试文件） | 4/4 通过 |
| `npm run build` | 通过；Vite 转换 1,853 个模块；主 JavaScript chunk 612.70 kB（gzip 177.36 kB），仍是非阻断拆包提示 |

匿名超时故障注入按层验证，不把所有路径笼统归为同一种“请求超时”：

| 超时层 | 已验证结果 |
| --- | --- |
| 模型 planning | 每次重试递增阶段额度；超过首次额度的正常慢请求可在后续尝试完成，持续停滞达到明确上限后才稳定进入 `failed/model_timeout` |
| 模型 composing | 数据库证据已保存后模拟持续回答超时，任务进入 `partial`；恢复时证据充分可直接回答，证据不足或 notice-only 快照则继续执行只读工具 |
| SQL 只读 Worker | 匿名长查询触发 `query_timeout`，第二次工具尝试获得递增额度；持续超时后工具与分段审计保留同一错误码且不会伪造数据库证据 |
| 无整体 deadline | 模拟执行时间超过旧整体限制后任务保持可执行并最终完成；状态端点的 `deadline_ms` 与 `max_tool_calls` 均为 `null` |
| 快照与重复保护 | 超过 200 KB 的 notice-only 快照不计为 retained evidence，重试会重新查询；SQL 的空白、注释、大小写和尾分号变体按同一调用收敛 |
| FTS 底层 Worker | 与 SQL 共用的只读 Worker 超时机制由既有 V6 匿名注入覆盖并返回 `query_timeout`；这项证据不表述为 100k FTS 端到端超时注入 |

V9 最终匿名门禁已记录并通过；100,000/120,000 是验收规模，不是候选人数硬上限：

| 门禁 | 必须记录的结果 |
| --- | --- |
| 完整自动化 | `npm test` 的实际通过数 |
| 静态/构建/供应链 | `npx tsc --noEmit`、`npm run build`、`npm audit --audit-level=low`、修改文件 `node --check` |
| 100,000 匿名容量 | 候选人、经历、关系、FTS 文档、数据库大小、生成/回填耗时、冷/热检索、响应字节、主进程与 Worker 峰值 RSS |
| 120,000 容量余量 | 确认不按候选人数拒绝，并记录相同核心指标 |
| 并发/取消/故障 | 4 个宽泛任务时健康检查与业务 API 可用；SQL/FTS/模型超时、取消、`partial`、基于已保留证据完整续跑和刷新恢复 |
| Playwright 1440x900/390x844 | 真实阶段、首批证据、取消、partial、刷新恢复、Top-K/分页/高亮；控制台 0 error/0 warning，根节点无横向溢出 |
| 正式收尾 | 匿名门禁后才允许备份 `.db/-wal/-shm`、哈希核验、恢复副本 V8→V9、正式加法迁移和回环健康检查 |

### V9 匿名容量实测（2026-08-06）

所有数据库均为临时目录中的匿名文件型 SQLite，`formal_database_used=false`、`model_gateway_invoked=false`。基准采用 `--capacity --batch-size=5000 --commit-batch=2000` 分批写入，未设置按候选人数拒绝的业务上限。脱敏后的结构化结果、原始日志文件名/大小/哈希和已知限制见 [v9-capacity-results.json](evidence/v9-capacity-results.json)；该证据文件不含候选人正文、查询正文、绝对数据库路径或凭据。

| 指标 | 100,000 位 | 120,000 位余量 |
| --- | ---: | ---: |
| 候选人 / 活跃候选人 | 100,000 / 99,000 | 120,000 / 118,800 |
| 经历 / profile sections（总数 / active） | 500,000 / 495,000 | 600,000 / 594,000 |
| 候选人-职位关系（总数 / active） | 500,000 / 495,000 | 600,000 / 594,000 |
| 候选人-人才库关系（总数 / active） | 500,000 / 495,000 | 600,000 / 594,000 |
| source records | 20,000 | 24,000 |
| `source_rows` | 1,655,938 | 1,987,084 |
| `checkpoint.queued_rows / checkpoint.processed_rows` | 1,655,938 / 1,655,938 | 1,987,084 / 1,987,084 |
| `checkpoint.document_count` | 12,307,691 | 14,768,819 |
| 业务 FTS 文档（base/FTS） | 12,307,691 / 12,307,691 | 14,768,819 / 14,768,819 |
| 履历文档（base/FTS） | 600,732 / 600,732 | 720,878 / 720,878 |
| `checkpoint.status / dirty_rows` | `ready` / 0 | `ready` / 0 |
| 字段 coverage | 191/191（100%） | 191/191（100%） |
| SQLite 主文件 | 16,394,866,688 bytes（15,635.363 MiB） | 19,687,194,624 bytes（18,775.172 MiB） |
| open DB / fixture insert / ANALYZE | 468.025 / 422,180.126 / 2,829.661 ms | 756.141 / 445,292.839 / 3,572.351 ms |
| FTS 回填 / 批次数 | 5,081,607.932 ms / 332 | 5,614,112.093 ms / 398 |
| 主进程峰值 RSS | 437,821,440 bytes（417.539 MiB） | 457,011,200 bytes（435.84 MiB） |

针对大规模回填的 checkpoint 修复中，`flushBusinessSearchDirty()` 不再在每个批次对持续增长的搜索文档表和 dirty 表执行全表 `COUNT(*)`；`checkpoint.document_count` 改为按本批实际删除/新增文档数增量维护，full backfill 直接用 `queued_rows - processed_rows` 推导剩余队列。定向回归和两档 postcheck 均确认 `queued_rows=processed_rows`、`checkpoint.document_count=业务文档数=FTS 文档数`。

容量基准查询中位数（DB / 服务或 Worker）为：100k 分页 7.482 / 83.176 ms、结构化问答 148.508 / 251.317 ms、全业务 FTS 55.081 / 260.211 ms、候选人混合检索 589.423 / 837.529 ms；120k 分页 8.687 / 88.083 ms、结构化问答 181.856 / 279.348 ms、全业务 FTS 66.795 / 285.952 ms、候选人混合检索 2,829.138 / 3,094.828 ms。两档 fast Top-K Worker 分别为 256.636 ms 和 329.936 ms。

100k 原始容量任务的 wide matrix 必须与修复后结果分开解释：原始 `high_frequency_or` 和 `multi_keyword_and` 均以 `resume_search_failed` 结束，只有无匹配场景成功；这些失败记录保留，不能被后续成功结果覆盖。修复后只读 postcheck 的候选人 OR/AND fast Top-K 均成功。120k 原始 wide matrix 的 OR、AND、无匹配分别为 2,151.039 ms、1,774.650 ms、97.959 ms，三者均完成并返回正确的 `has_more`/空结果语义。

当前代码的只读 postcheck 另行记录 process-cold / same-process warm median / isolated Worker first / isolated Worker subsequent median：100k 的宽泛 fast 为 368.371 / 340.338 / 453.515 / 445.422 ms，候选人 OR 为 541.118 / 544.650 / 656.831 / 669.223 ms，候选人 AND 为 736.160 / 744.740 / 883.495 / 870.675 ms，混合候选人为 449.839 / 437.341 / 538.276 / 541.924 ms，复杂聚合为 967.270 / 971.101 / 1,039.862 / 1,126.908 ms，五场景响应分别为 2,106 / 2,306 / 2,326 / 2,346 / 218 bytes，Worker RSS 约 56–57 MiB。120k 对应结果为宽泛 fast 428.939 / 399.787 / 511.121 / 517.965 ms，候选人 OR 635.858 / 635.903 / 754.190 / 756.880 ms，候选人 AND 911.996 / 878.805 / 979.424 / 997.235 ms，混合候选人 533.260 / 513.051 / 649.254 / 644.903 ms，复杂聚合 1,137.278 / 1,174.476 / 1,247.728 / 1,240.335 ms，五场景响应分别为 2,106 / 2,306 / 2,326 / 2,346 / 219 bytes，Worker RSS 最高 54.500 MiB。这里的 process-cold 只表示新进程和新只读连接，未清除操作系统文件缓存，不是物理冷盘测试；100k 与 120k 也在不同时间运行，数字不可按人数线性比较。两个 postcheck 只读访问匿名源库，查询 Worker 保持只读且源文件集前后未改变。

### V9 并发、恢复与浏览器结果

100k 匿名并发探针在源库的可丢弃工作副本上验证 `max_active=2`、2 个运行任务加 2 个排队任务；排队和运行取消均成功。真实 FTS 查询期间 health、Agent status、候选人分页 API 均 HTTP 200，`search_candidate_resumes` 与 `search_all_records` 各 1 次且 0 错误。当前 `retry-answer` 是基于持久证据恢复完整编排：证据充分时可以直接生成回答，证据不足时允许继续调用只读工具，超大 notice-only 快照会重新查询；因此工具审计计数只在确实补查时增加。服务关闭或进程中断使活动任务保持 `queued` 并在启动后自动续跑，只有用户显式取消才进入 `cancelled`。120k 只完成容量与只读 postcheck，没有运行 Agent 并发探针；容量基准未调用模型网关，并发探针使用本地模拟网关，因此这些结果不证明真实模型延迟或吞吐。

100k 修复后 postcheck 与 120k postcheck 均通过 `integrity_check=ok`、外键 0、源文件未改变。匿名 Playwright 已通过 1440x900 与 390x844：当前代码双视口证据为 `output/playwright/v9-agent-desktop-workflow-final.png` 和 `output/playwright/v9-agent-mobile-workflow-final.png`；步骤条、阶段/总耗时、首批证据、结果数、Markdown/XSS 防护、控制台 0 error/0 warning 及根节点无横向溢出均已核对。`output/playwright/v9-agent-desktop-completed.png`、`output/playwright/v9-agent-desktop-partial.png` 和 `output/playwright/v9-agent-mobile-search.png` 分别保留为完成/恢复、partial/续跑入口和移动 Top-K 搜索专项证据。截图哈希及不能由截图单独证明的控制台/overflow 断言见 [v9-browser-acceptance.json](evidence/v9-browser-acceptance.json)。

### V9 正式恢复副本、迁移与运行验收（2026-08-07）

匿名门禁全部通过后才进入正式维护窗口。旧 PID `7232` 已退出且 `4173` 已释放；同一时点 `recruitment.db/-wal/-shm` 三件套备份到 `backups/pre-v9-agent-capacity-20260807-103130/`，源/备份长度和 SHA-256 逐项一致。备份清单 SHA-256 为 `0413357a756b92cb961aa98bf04cb905ae908278f48c04a890aacd1408a984f0`，61/61 文件源码清单 SHA-256 为 `33675750da369e50fbbad32ed769d7915be8959decb50cf862edaaa959c3d39e`，迁移脚本 SHA-256 为 `8d84504e841da7e096525116d995551a56f5f8514ff9327ffdfa16dd70a58ac9`。

恢复副本先成功完成 V8→V9，marker SHA-256 为 `68bdc480d230afcac462213599a82d3e8a2c07b72076f3bc0b225f08e7bed96a`，DDL `migration_ms=416.783`；随后正式迁移 `exit=0`、`ok=true`，DDL `migration_ms=151.37`，含迁移前后全量摘要/完整性核验的墙钟为 264.7 秒。两次 WAL checkpoint 均为 `busy/log/checkpointed=0/901/901`，恢复副本与正式 before/after 完全一致。

schema 从 `[1,2,3,4,5,6,7,8]` 加法升级为 `[1,2,3,4,5,6,7,8,9]`，V9 登记名为 `agent_async_tasks_and_phase_audits`。迁移前后候选人 8,209、职位 312、人才库 35、活动 34,742、履历区块 221、来源记录 32,834、两类关系 9,980/6,224、履历 base/FTS 8,430/8,430、全业务 base/FTS 2,629,388/2,629,388 均不变；checkpoint 保持 `ready`（queued 120,806、processed 120,823、documents 2,629,388）、dirty 0、coverage 19/19 表和 191/191 字段、`integrity_check=ok`、外键异常 0，搜索元数据行数与摘要哈希不变。V9 的 `agent_tasks` 定义、三列审计字段和六个索引均与恢复门禁一致。

正式主文件从 4,187,049,984 增至 4,187,590,656 bytes（+540,672），checkpoint 后 WAL 为 0，SHM 为 32,768 bytes。新 PID `22904` 于 `2026-08-07 11:00:40+08:00` 启动且 `4173` 只有 `127.0.0.1` 监听；health、Agent status 和普通根页面均返回 200，`async_tasks=true`、18 个只读工具已加载、向量关闭并回退 `sqlite_fts5`，stderr 为 0。health-only 后的空闲服务 Working Set 为 66.8 MiB、Private 为 73.1 MiB；它不是 100k/120k 并发 RSS。

本次正式验收没有执行候选人搜索、模型问答、截图、负载、写入、删除、上传或故障注入，也没有读取候选人正文或命中内容。完整文件哈希、聚合摘要和限制见 [v9-formal-deployment.json](evidence/v9-formal-deployment.json)；运维主记录见 `docs/OPERATIONS.md` 10.7 节。

容量命令示例：

```powershell
node --expose-gc tests/performance/v8-anonymous-benchmark.mjs --candidates=100000 --iterations=3 --readonly-iterations=1 --batch-size=5000 --commit-batch=2000 --capacity --keep
node --expose-gc tests/performance/v8-anonymous-benchmark.mjs --candidates=120000 --iterations=3 --readonly-iterations=1 --batch-size=5000 --commit-batch=2000 --capacity --keep
```

基准脚本会分批提交生成事务，不把全部 fixture 保存在内存。高密度模式每位候选人生成 5 条经历、5 个职位关系和 5 个人才库关系；100,000 人预期至少 500,000 条经历、1,000,000 条关系/业务明细，并可能产生数百万以上 FTS 分段。实际数字必须以脚本 JSON 输出为准，不以预估代替结果。

## 自动测试未覆盖

- React 组件级测试和完整浏览器自动化。
- 北森增量导入尚未形成仓库内可重复执行的 Playwright 测试规格；后端已有匿名工作簿自动化和 V12 真实文件 100 人隔离验证，浏览器仍需覆盖真实 `.xls` 上传、候选人增量摘要、可选关系提示和正式提交结果。
- `start.cmd` 双击启动体验和异常提示。
- 正式文件集在提交后失败场景中的实际回退演练；V9 已在可丢弃恢复副本验证同一迁移和完整性，但没有破坏性替换正式文件集来演练恢复。
- 远程明文 HTTP 证件照来源的长期可用性、签名过期和离线缓存；证件照仍不是本地简历附件。
- “新建候选人并关联职位”两个请求之间的失败恢复。
- 除本轮已审计的 V12 BIFF8 文件及 100 人隔离样本外，其他真实北森导出版本的表头、编码、枚举和数据分布仍未覆盖；通用自动测试主要使用人工构造的匿名 XLSX 和 MIT 样本 BIFF8 工作簿。
- 合法的 `<x:workbook>` / `<x:worksheet>` SpreadsheetML 前缀、跨 parser chunk 的长前缀及 OPC worksheet target 已有匿名自动化；错误命名空间、wrapper 走私和缺失/重复/近似 target 会受控返回 `422 import_xlsx_invalid`。其他第三方 OOXML 生成器和超大前缀文件的真实分布仍未覆盖，V7 大容量成功基准使用 UTF-8 CSV，不能据此宣称所有变体兼容。
- 批量导入仍不支持多工作表选择、加密或非 BIFF8 `.xls` 和 GBK CSV；简历附件对这些输入也明确失败。
- 批量导入在多种真实数据分布和长期连续运行下的压力、附件 1000 行及大量候选人/职位/履历性能。约 50 MiB 的匿名单次基准不能替代长时间稳定性测试；15 MiB + 1 byte 的附件拒绝边界仍由 V6 定向自动化覆盖。
- 断电、WAL 恢复、长期备份和灾难恢复。
- 多进程写入、登录、RBAC、租户隔离，以及基于认证会话/token 的完整 CSRF 测试；V6 已覆盖本机版 Origin 写保护。
- 真实模型差异、费用限额和网关故障；Agent 提供全字段只读查询但不提供写工具。
- 正式数据库候选人级搜索内容、敏感字段返回、模型问答和命中证据的业务抽查；正式收尾仅记录 schema、状态、聚合计数、迁移耗时、文件增长和回环服务健康，不读取或输出候选人明文。
- V9 100,000/120,000 位匿名容量、四任务并发和双视口浏览器门禁已在本节记录；正式数据内容级搜索仍明确不在验收范围内。

## 手工 E2E 准备

禁止使用正式数据库。使用独立测试数据库和虚构数据：

```powershell
$env:DB_PATH = Join-Path $env:TEMP ("candidate-workbench-e2e-{0}.db" -f [guid]::NewGuid())
npm run build
npm start
```

浏览器访问 `http://127.0.0.1:4173`。不要使用真实姓名、电话、邮箱、简历或备注。Agent E2E 使用测试网关和专用测试 Key。

## 手工 E2E 范围

### 1. 启动和空库

- 空数据库显示候选人和职位空状态，不生成演示数据。
- 刷新后仍为空，工作台统计均来自 API。
- Agent 未配置时显示未配置且不发起模型请求。

### 2. 候选人与人才档案

- 创建、编辑、搜索、人才库/学历/学校/性别/求职状态组合筛选、备注、归档和恢复；另以 API 回归确认旧 `major` 条件仍兼容。
- 同名不同身份键可共存，重复邮箱或电话明确拒绝。
- 列表、人才库分组和职位入口引用同一候选人记录。
- 默认详情不返回联系方式、薪资、旧阶段、高敏档案或原始来源值；点击加载敏感信息后才从本机 API 获取。
- 普通列表和详情只看到 `has_photo`，不包含原始 URL；有照片时统一头像位显示图片，无照片、断网或加载失败时回退首字母且布局不跳动。
- 历史面试与测评只作为档案记录展示，不形成可运行的 ATS 流程。

### 3. 职位生命周期

- 新建草稿职位，填写部门、地点、负责人、计划人数、标签和描述。
- 编辑并切换草稿、招聘中、暂停、关闭状态。
- 搜索、筛选、排序、分页、进入详情、归档和恢复。
- 在活动职位筛选结果中单选、当前页全选和取消选择；批量栏显示准确数量，最多 100 个职位经一次确认后归档，候选人与既有关系不变。
- 制造目标已归档、缺失和 `updated_at` 变化，确认接口返回 `409` 且同批其他职位均未归档。
- 关闭不等于归档；归档职位默认隐藏，恢复后可见。

### 4. 候选人职位关系

- 从候选人详情关联已有职位、解除并打开职位详情。
- 从职位详情添加已有候选人、新建并关联、单条和批量解除。
- 一个候选人关联多个职位，在多个分组视觉出现但 ID 和资料保持一致。
- 重复关联不产生重复关系；未关联候选人进入“未分配职位”。
- 关联和解除活动出现在候选人时间线。
- 已关闭或已归档职位不能新增关系；暂停职位允许关联。
- 已归档候选人不能新关联，已有关系保留。
- 模拟“创建成功、关联失败”，确认新候选人仍可在未分配列表找到并给出清晰错误。

### 5. 导入与导出

- 使用 UTF-8 CSV、首工作表 XLSX/XLSM 和未加密 BIFF8 `.xls` 完成上传、映射、预览和提交。
- 读取 `/api/candidates/import/config`，确认页面显示当前字节上限；使用匿名大文件验证真实上传进度、最多 20 行 DOM 预览、全量汇总和事务提交，不得出现候选人数型拒绝提示。
- 验证前 20 行展示不会掩盖全部行汇总。
- 验证 `identity_conflict`、文件内重复和超限错误。
- 按具体职位和未分配条件分别导出 CSV/XLSX，候选人范围正确。
- 确认导出不包含职位列、关系、备注或活动，不能作为完整数据库备份。
- 使用只含候选人字段的通用文件确认不会创建职位；再显式映射招聘职位名称/编号/部门/地点，确认预览显示匹配、新建、歧义、无效、归档冲突和拟新增关系。任何情况下 `current_title` 都不能自动建立招聘职位关系。
- 分别使用“仅候选人字段”和“候选人 + 申请 + 职位”文件验证北森专用预览；核对候选人、可选申请/职位、跳过关系和冲突计数。
- 重放相同 ID 的稀疏文件，验证非空字段更新、空值不清除、标签并集、已有 ID 可无姓名，新 ID 必须有姓名。
- 使用同一 ID 多行且部分行无效的文件，验证后出现的非空标量覆盖先出现值，同时失败行不贡献候选人、职位、关系或来源 `raw_payload`。
- 核对 `imported_rows + updated_rows + skipped_rows + failed_rows = total_rows`，并确认 `candidate_count` 是成功处理的唯一候选人数而不是源行数。
- 验证同一职位编号多行的非空元数据合并；验证申请 ID 跨候选人冲突和预览后归属竞态均阻断且不改绑。
- 验证没有职位关系和真实评估载荷时申请 ID 保持可选；`自我评价`、Offer/录用不进入历史评估。
- 重放相同文件后确认候选人、职位和关系不重复创建；同时确认当前仍会更新 `updated_at`、`import_batch_id` 并追加导入更新活动，因此属于重放安全而不是严格状态幂等。
- 验证标准化电话/邮箱冲突阻断；验证真实 BIFF8 `.xls` 可预览，伪装扩展名、加密或非 BIFF8 `.xls` 明确拒绝且不修改源文件。
- 使用相同 `应聘者ID` 的后续文件只补充“证件照”，验证预览仅显示 `has_photo`、提交更新 1 位候选人、空照片不清除旧值，默认 CSV/XLSX 不含 `photo_url`。
- 导入匿名性别、出生日期、年龄和应聘者 ID；详情核对应聘者编号来自 `source_record_id`、生日优先年龄计算和缺失生日时的年龄回退。按性别筛选后，列表总数和 CSV/XLSX 导出范围一致；专业筛选不在页面出现但旧 `major` API 仍可调用。

### 6. 全量只读 Agent

- 状态显示 `full_readonly=true`、18 个工具、独立只读连接和 FTS5/向量状态。
- 匿名数据的未打码联系方式、薪资、旧阶段、备注、活动、原始来源、履历、附件、评估和授权按明确问题正确返回。
- `search_all_records` 可跨候选人、职位、人才库、来源、附件和最小删除审计定位实体；`search_candidate_resumes` 返回候选人级 Top-K。只读 SQL、结构化关联、聚合、分页和本地导出与 SQLite 一致，大结果不整批进入模型。
- SQL/FTS、`business_search_sync`、`model_gateway_wait`、`agent_tool_call:<name>` 和 `agent_response_assembly` 审计存在且不含匿名问题、Agent 回复、工具结果或敏感正文。
- 要求修改、建立关系、归档、恢复、确认附件更新或删除时，不得产生业务写入或新增工具。
- Agent 回复中的标题、强调、列表、引用、分隔线、链接、代码块和 GFM 表格呈现为结构化内容，不裸露控制符；用户消息仍是纯文本。
- 输入 raw HTML、事件属性、危险 URL、远程 Markdown 图片和“忽略系统要求”等提示注入文本，确认其不执行、不加载资源且不触发额外工具；宽表格和代码块只在消息内滚动。

### 7. 错误与恢复

- 无效字段、归档冲突和批量目标不存在时界面说明明确，数据库不部分写入。
- 预览令牌重放和服务重启后失效。
- 网关超时不改变业务数据。
- 使用升级前备份恢复测试库，核对候选人、职位、关系、备注和活动。

### 8. 归档与永久删除

- 单条归档后默认列表消失，Toast 可撤销；批量归档显示人数且一批不超过 100。
- 已归档视图可查看、恢复或进入危险操作，不能编辑、备注或调整关系。
- 已归档候选人和职位均可单选、全选及最多 100 条批量永久删除；活动与归档记录不能混合删除。
- 弹窗不含确认词，只展示一次数量、影响、不可恢复和外部边界；点击“确认永久删除”提交服务端预览 token。
- 制造 `updated_at`、恢复、缺失、过期或 token 重放冲突后，整批不删除并要求重新预览。
- 删除成功后所有候选人入口立即消失；弹窗明确提示不影响北森来源系统和历史备份。
- 删除职位后候选人和附件仍完整，候选人动态出现“关联职位已永久删除”。
- 活动人才库分组可单选/全选并批量归档；已归档分组可单条/批量恢复和永久删除，活动与归档分组不能混选执行。
- 人才库删除弹窗显示分组数、候选人数和解除关系影响且不要求确认词；删除后分组与关系消失，逐项核对候选人、职位、附件、备注、活动和履历仍完整。
- 上传六种匿名简历格式，完成身份匹配、逐字段/区块选择和确认；取消、失败、过期、重复文件和长文件名状态清晰。

### 9. 浏览器与布局

- 1440x900：侧栏、工具栏、候选人表格、职位表格、详情工作台和抽屉布局稳定。
- 1440x900：侧栏展开时显示品牌/导航/工作区文字；收起后稳定为图标栏，图标对齐、选中态和 Agent 状态保留，主内容同步重排。刷新后保持收起，再展开后状态同样持久化。
- 390x844：无根页面横向滚动，表格自身滚动或切换移动条目。
- 390x844：不显示桌面收起按钮，覆盖式移动导航仍显示完整图标和文字，不受已保存桌面状态影响。
- 1440x900 和 390x844 的候选人列表、详情、职位关联场景均使用统一头像；加载失败回退首字母。
- 长姓名、职位、邮箱、标签和动态文本不重叠。
- 键盘可以完成主要导航、打开详情、表单和关闭弹窗。
- 浏览器控制台零错误、零警告。

## 2026-08-04 历史记录：职位管理迭代 Playwright 验收

> 本节只证明上一轮“候选人库 + 职位管理”界面的验收结果，不代表当前人才库 V2 已通过浏览器验收。

- 代码：当前工作区；浏览器由 Playwright CLI 隔离会话 `qafinal` 驱动。
- 数据库：`output/playwright/positions-workbench/e2e-utf8-20260804.db`，仅含虚构测试数据；正式数据库未用于浏览器操作。
- 功能：候选人组合筛选/职位分组/阶段看板、候选人创建编辑备注与职位关系、职位创建编辑归档恢复、职位详情添加/批量解除、候选人归档恢复和当前职位 XLSX 导出通过。
- 回归：混合档案视图归档记录只显示查看/恢复；职位详情导出请求只包含当前 `position_id` 与 `archived=include`；负责人可输入建议外新值；候选人固定表头滚动后位置不变。
- 视觉：1440x900 和 390x844 的候选人、职位、详情和表单截图均检查；各页面根节点横向溢出为 0。
- 运行：浏览器控制台 0 错误、0 警告；测试服务 stderr 为空。
- 截图：保存在 `output/playwright/positions-workbench/`，该目录只用于本地验收产物。

## 2026-08-04 历史记录：职位管理空库迁移验收

> 本节记录照片迁移前的职位管理版本空库状态，不代表当前正式库；当前状态见下一节“人才库 V2 与证件照头像验证记录”。

- 正式库迁移前：`integrity_check=ok`，候选人/备注/活动均为 0，`positions` 与 `candidate_positions` 尚不存在。
- 升级前备份恢复副本：执行 `openDatabase()` 后候选人仍为 0，新增职位和关系表均为空，复合主键顺序为 `candidate_id, position_id`，两个外键存在，外键异常 0 条。
- 正式库迁移后：候选人/职位/关系均为 0，`integrity_check=ok`，外键异常 0 条；隔离浏览器数据未进入正式库。
- 最终运行：`http://127.0.0.1:4173/api/health` 返回 `ok`，正式服务 stderr 为空。

## 2026-08-04 人才库 V2 与证件照头像验证记录

- 后端自动化测试 31/31 通过，覆盖北森候选人分批增量、证件照更新、头像 URL 校验和安全投影、v4 既有来源照片回填、可选申请/职位、联系方式冲突、职位聚合、申请归属与竞态、源行计数守恒、失败行隔离、评估分类和 BIFF8 文件边界。
- 生产构建通过，依赖审计为 0 个已知漏洞。
- 隔离旧库重复打开并执行迁移后，`schema_migrations` 包含版本 1-4；v3 增加 `photo_url`，v4 仅在字段为空且来源值合法时回填，既有照片不被覆盖。
- 迁移前后既有候选人、职位及关联记录数量保持不变，`integrity_check=ok`，外键异常 0 条。
- 正式迁移前备份为 `backups/pre-photo-avatar-20260804-164342/recruitment.db`：候选人 57 位、schema `[1,2]`、`integrity_check=ok`。
- 正式迁移后候选人仍为 57 位，照片 42 张、照片回填活动 42 条；schema `[1,2,3,4]`、`foreign_key_check=0`、`integrity_check=ok`。服务已在 `http://127.0.0.1:4173` 重启。
- Playwright 使用 `output/playwright/talent-v2/talent-v2-e2e.db` 隔离数据库完成：人才库新建/编辑/归档/恢复、候选人创建、敏感资料显式加载、加入人才库、职位创建与关联，以及人才库和职位组合筛选均通过。
- 另使用隔离数据库和匿名稳定 ID `.xlsx` 完成完整关系导入闭环：上传后直达北森预览，提交创建候选人、职位及人才库关系；详情中职位、有效/首末来源、履历、历史评估和授权留档正确。重复提交同一文件后候选人数保持不变、职位由新建变为匹配、关系新建数为 0。候选人分批增量和 BIFF8 `.xls` 的浏览器闭环需按本轮清单补验。
- 1440x900 和 390x844 截图已人工检查；两种视口的 `body` 与根节点横向溢出均为 0。
- 浏览器控制台 0 个错误、0 个警告，验收期间记录的业务请求均为成功的 2xx 响应。
- 证件照头像已在 1440x900 与 390x844 验收，图片失败场景回退首字母；两种视口控制台均为 0 错误、0 警告。
- 截图保存在 `output/playwright/talent-v2/`；正式数据库未用于浏览器操作。
- 正式服务重启后 `http://127.0.0.1:4173/api/health` 返回 `200`，空库工作台在 1440x900 下横向溢出为 0，控制台 0 个错误、0 个警告。

## 验收记录

每次 E2E 至少记录日期、代码版本、Node/浏览器版本、视口、匿名测试数据库路径、场景结果、控制台情况和失败截图。必须明确测试数据库与正式数据库隔离。

## 2026-08-12 0.1.1 附件身份修复验收

- 自动化：附件身份聚焦 30/30；附件批量、UI 和中文文件名相关 24/24；完整 `npm test` 共 320 项，319 通过、0 失败、1 项按设计跳过
- 构建：`npm run build` 通过 TypeScript 与 Vite 生产构建；现有主 chunk 大于 500 kB 提示不影响构建成功
- 隔离环境：Node.js `v24.18.0`、Playwright CLI `0.1.18`、`output/playwright/attachment-identity-011/e2e.db`、`127.0.0.1:4491`；隔离进程不配置模型，未读取或写入正式数据库
- 桌面/API 流程：虚构 TXT/PDF/DOCX 文本中“手机号：未提取”、唯一匹配邮箱、空格/换行标签和“项目邮箱”正文噪声均得到“单一身份字段唯一匹配”；日期/版本/序号数字噪声不产生多个手机号/邮箱提示，两个真实手机号仍保持歧义
- 现场 PDF 隔离重放：识别“移动电话”和行内“电 子 邮 箱”标签，知乎链接中的 11 位文章编号不再作为手机号候选；真实手机号与邮箱命中同一候选人
- 启动恢复：待确认批次引用的预览过期后转为明确失败，不再恢复旧匹配结论
- 文件名：中文 TXT 原名在预览、已保存附件和下载入口中完整显示；确认事务成功，隔离服务 stderr 为空
- 移动端：390×844 下页面、`body` 和根节点宽度均为 390，截图人工检查无重叠；本地工作台页面 console 0 error/0 warning
- 清理：浏览器会话和隔离服务均已停止，端口 `4491` 已释放。测试输出为本地忽略目录，不包含真实候选人资料
- 正式运行：旧 PID `8024` 停止后，当前 `master` 工作区以显式 `data/recruitment.db` 启动为 PID `21232` 并监听 `127.0.0.1:4173`；仅只读核对 health=`ok`、Agent model=`kimi-k3`、`configured/full_readonly/async_tasks=true`

## PDF 双通道附件解析本地验收矩阵

本矩阵只允许匿名合成 PDF、临时目录、内存或临时文件型 SQLite，以及临时本地 HTTP 网关。不得使用真实简历、真实姓名、真实文件名、正式数据库、生产网关或实际凭据。下列命令是本地验收入口；本节不把命令列出解释为本次已经通过：

```powershell
node --test tests/backend/attachment-visual-parsing.test.mjs
node --test tests/backend/attachment-visual-lifecycle.test.mjs
node --test tests/backend/attachment-visual-hardening.test.mjs
node --test tests/backend/attachment-avatar.test.mjs tests/backend/attachments-v6.test.mjs
git diff --check
```

| 场景 | 必须断言的契约 |
| --- | --- |
| 文本、扫描、混合 PDF | `pdf_content_type` 分类正确；视觉页仅为瞬时 PNG；扫描件在视觉可用时可保留附件记录，确定性文本为空时不伪造文本。 |
| 视觉资源降级 | 页数、像素、PNG 字节、渲染超时或缺失 canvas renderer 触发稳定 `pdf_visual_*` code（含 `pdf_visual_renderer_unavailable`），确定性文本仍完整，视觉页清空。 |
| 能力与配置 | 仅在显式 `image_input` 声明和本地配置完整时进入实际视觉请求；没有标准化主动探测。`disabled`、配置不完整、网络/HTTP、超时、超大响应、无效 JSON 和无效 schema 均返回安全 fallback；禁用时不渲染页也不调用视觉提供者。 |
| 分层时间与适配器边界 | 默认适配器请求 15 秒，附件服务外层视觉调用预算 45 秒；分别注入两层超时并断言 `visual_timeout`、中止信号和瞬时页字节清理。断言适配器的 4,000,000 像素、3 MiB/页、12 MiB 总图像、8,000 字符/页、单 span 1,000 字符、100 记录和 512 KiB 响应上限；高于硬上限的 override 必须 clamp。 |
| 网关发送边界 | 只发送有界 PNG 页、最小元数据和不可信附件数据；strict JSON Schema、`stream:false`、禁止重定向，没有 tools/tool choice；endpoint 仅允许 `http/https`，生产拒绝明文 HTTP，非生产 loopback HTTP 仅限隔离测试；私网默认拒绝，只有精确列入 `ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS` 的 DNS 主机名、HTTPS 端点且（若配置）通过普通主机 allowlist 时，才允许全量 DNS 结果为 RFC1918/IPv6 ULA；IP 字面量、通配符/后缀、`.localhost`/`.internal`/`.local`/metadata 保留主机名、混合公网/私网、metadata/loopback/link-local/multicast/IPv6 未指定或组播/DNS 危险结果、URL 用户信息、未许可主机、PNG magic/IHDR 不一致和超出 `maxRecords` 均拒绝；测试替身不记录真实凭据。 |
| 溯源与冲突 | 视觉建议具有 `source: visual`、页码、最小证据、`evidence_status` 和置信度；`unverified` 默认不勾选且不能替换确定性区块；电话/邮箱仍由确定性通道决定；字段冲突与视觉替换区块都携带稳定冲突 code。 |
| 结构化履历关系 | 视觉区块 `structured_data` 只允许 `organization`、`role`、`start_date`、`end_date`、`period`；只有同一条文本层已核对证据逐字包含值时才接受，否则保留人工候选且不写结构化关系。 |
| bbox | 只有受 PDF 文本 span 校验的证据可附 bbox；模型返回 bbox 或未知字段必须以 `visual_invalid_schema` 降级。 |
| 生命周期 | 成功、失败、取消与视觉超时都会清空瞬时页字节；预览完成、取消、过期的隔离文件和临时正文遵循既有清理契约；重复确认返回稳定 replay/幂等结果，不恢复已消费正文。 |
| 格式回归 | 非 PDF 保持视觉 `not_applicable`；文本模型未 fallback 时 `review_required=false`，文本模型 fallback 时仍必须为 `true`。文本型、双栏/三列表格/时间轴、扫描型和混合 PDF，以及 DOCX、XLSX、XLSM、BIFF8 XLS、UTF-8 CSV/TXT 的既有确定性解析、安全失败和确认流程不回归；扫描 PDF 的头像恢复路径也必须保留 `allowTextlessPdf`。三列密集行按标签、值、日期的行顺序保留，普通双栏仍按列顺序读取。 |
| 独立通道状态 | `pipeline.text`、`pipeline.text_model`、`pipeline.visual` 分别保留成功、pending、fallback、错误码、schema mode 和 retryability；扫描/混合 PDF 或视觉 fallback 必须返回 `review_required=true`，不能只显示“解析完成”。 |
| 网关兼容配置 | `ATTACHMENT_TEXT_SCHEMA_MODE`/`ATTACHMENT_VISUAL_SCHEMA_MODE` 默认 strict；compat 仅显式开启，仍本地严格校验且不标记 strict；文本端点 invalid/insecure 错误不可重试。 |

若需要浏览器验收，使用独立回环端口和匿名 SQLite，检查 `202 -> parsing -> ready|failed` 轮询、`pipeline`/证据/冲突显示、视觉 fallback 后仍可人工确认确定性结果，以及取消/过期后无法恢复预览。浏览器控制台、服务日志、HAR、截图和失败工件不得包含正文、页图、token、文件路径、网关地址或凭据。

### 历史验证记录（已被本轮 fresh 命令 supersede）

本节的旧测试数字和旧构建模块数属于 2026-08-19 基线，不能作为本轮完成证据；本轮最终数字必须以当前工作区重新运行的专项测试、`npm test`、构建、静态检查输出为准。旧记录不再声称当前通过，也不应据此判断视觉请求已实际发送。依赖审计中的基线 advisory 同样需要在本轮重新执行后单独报告。

### 历史真实样本记录（需本轮重新核对）

此前记录的隔离上传、窄屏检查和视觉未发送结论仅是历史背景；本轮最终汇报必须重新说明是否运行真实样本、是否使用合规视觉端点，以及临时 SQLite/附件目录是否已清理。真实正文、页图、HAR、截图、个人信息或可恢复临时内容不得写入仓库。

### 2026-08-20 本轮 fresh 附件验收

- 附件专项清单（文本建议、候选人预填、语义区块、UI、生命周期、视觉解析、视觉生命周期、视觉 hardening、附件确认）共 `181` 项，`181` 通过、`0` 失败、`0` 跳过；pinned lookup 取消竞态与通用 PDF 页数/解析超时硬上限回归均先 RED 后 GREEN，确保 endpoint 错误不覆盖取消语义且 parser limits 不可扩张。
- 完整 `npm test`：`487` 项，`486` 通过、`0` 失败、`1` 按设计跳过；`npm run build` 和 `npx tsc --noEmit` 退出码均为 `0`；Vite 转换 `1,858` 个模块，仅有主 chunk 大小提示；`node --check` 检查 `server/` 下 `35` 个 `.js/.mjs` 文件，`git diff --check` 通过。
- 匿名合成 PDF parser 结果：单栏 `text/1 页/1 页图`；双栏 `text/1/1` 且几何阅读顺序断言通过；表格/时间轴 `text/1/1`；扫描 `scanned/1/1` 且确定性文本长度为 `0`；混合 `mixed/2/2`。表格、时间轴、OCR 空格/粘连归属的 OCR 断言为语义层测试，不等同于内嵌中文字体扫描 PDF 的端到端 OCR。
- 隔离回环服务使用临时 SQLite、附件目录和匿名替身网关：替身实际收到普通文本、`strict:true`、显式 `strict:false` 及 `image_url` 请求；请求均为 `stream:false`、无 tools。匿名 API 上传覆盖 PDF/DOCX/XLSX/CSV/TXT，扫描/混合 PDF 返回 `review_required=true`，非 PDF 返回 `visual=not_applicable`；重复确认返回 `attachment_preview_replayed`，重复 SHA 确认返回 `duplicate_records=1`，取消和过期状态可观察且临时数据清空。
- Playwright 隔离浏览器验收：桌面 `1440x900` 与窄屏 `390x844` 均检查附件来源、页码、证据、置信度、通道状态和失败提示；两种视口 `body`/根节点无横向溢出，详情抽屉在窄屏宽度与视口一致，控制台错误/警告为 `0/0`。关闭替身网关后上传扫描 PDF，UI 明确显示文本/视觉各自降级、错误码、可重试和人工核对，不显示“解析完成”假成功。
- 本轮未上传或保存真实简历，未确认真实样本；当前环境的真实 Agent 配置为非回环明文 HTTP 且未声明 `ATTACHMENT_VISUAL_CAPABILITY=image_input`，因此真实文本/视觉出站请求均未运行。仅匿名 loopback 替身用于协议验证；合规 HTTPS/image-input 网关仍需部署方提供。
- 验收结束后停止浏览器、应用和替身网关，回环端口均已释放；两个精确隔离根目录（含 SQLite、附件、PNG 和脚本）以及本轮测试日志/Playwright YAML 均已删除并验证不存在。正式 `data/recruitment.db`、`-shm`、`-wal` 的修改时间仍停留在本轮之前。

### 2026-08-20 最终 fresh 安全验收（私网 HTTPS 例外）

- 视觉专项最终结果：`attachment-visual-parsing` `29/29`、`attachment-visual-lifecycle` `18/18`、`attachment-visual-hardening` `50/50`，均为 `0` 失败、`0` 跳过；新增的公网 IPv4-mapped、NAT64 和 6to4 DNS 回归测试先按预期失败，再在局部地址分类保护加入后通过。
- 完整 `npm test`：`515` 项，`514` 通过、`0` 失败、`1` 按设计跳过，耗时 `227228.6345 ms`。`npm run build` 退出码 `0`（Vite 转换 `1858` 个模块，仅有常规 chunk 大小提示）；`npx tsc --noEmit` 退出码 `0`；`node --check` 检查 `server/` 下 `35` 个 `.js/.mjs` 文件并全部通过；`git diff --check` 通过。
- 真实匿名视觉探针只在内存生成带随机验证码的合成 PNG，并在子进程中临时批准当前端点的精确 hostname 以验证例外路径，未写回用户环境。请求实际发送，内部断言确认包含 PNG `image_url`、`stream:false`、无 `tools`/`tool_choice`；HTTP 未收到状态码，结果为 `status=fallback`、`schema_mode=strict`、`error_code=visual_unavailable`、`retryable=true`、结构化记录 `0`，分类为 `DNS/network`。未输出 URL、凭据、完整请求、PNG 或原始响应。
- 由于真实探针未成功，按前置条件未运行真实视觉浏览器验收；匿名替身服务和隔离浏览器验收仍只能作为既有协议测试，不能替代合规 HTTPS/image-input 网关的真实可达性验收。
- 收尾检查确认本轮 Node 服务已停止、今天生成的 Playwright 快照为 `0`、本轮匿名 SQLite/附件临时根目录已删除，正式 `data/recruitment.db`、`-shm`、`-wal` 的大小和修改时间未变化；用户级 `ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS` 保持未配置。
