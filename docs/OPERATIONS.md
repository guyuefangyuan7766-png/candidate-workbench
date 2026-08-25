# 人才库工作台运维手册

## 1. 适用范围与部署边界

本手册以当前 `talent-library v2 / schema V12` 代码为准，并保留旧版本升级和回退要求；代码版本不等于正式数据库已执行的版本。当前 V12 已完成代码和 100 人隔离验收，但正式库升级与导入仍须按本手册的备份、副本验证、入口预览和确认门禁执行。应用默认地址为：

```text
http://127.0.0.1:4173
```

> 当前没有登录、认证、RBAC、多用户隔离或 SQLite 静态加密，并且程序拒绝非回环监听地址。它不是部门服务器，不应通过端口转发、反向代理、共享 Windows 会话或改监听地址提供给其他人。

应用不是 Windows 服务。运行 `start.cmd` 后需要保留终端窗口；窗口关闭或电脑休眠后服务不可用。

## 2. 当前版本和 schema

数据库通过 `schema_migrations` 记录：

| version | name | 当前含义 |
| --- | --- | --- |
| 1 | `candidate_workbench_baseline` | 候选人、备注、活动、导入批次、职位和职位关系基线。 |
| 2 | `talent_library_domain` | 人才库、履历、求职偏好、来源、历史评估、授权和职位申请来源。 |
| 3 | `candidate_photo_avatar` | 候选人受保护证件照 URL。 |
| 4 | `candidate_photo_backfill` | 从既有来源记录只回填合法且原字段为空的照片。 |
| 5 | `candidate_deletion_audits` | 候选人最小永久删除审计。 |
| 6 | `readonly_agent_attachments_fts_deletion` | 简历附件/预览/字段来源/清理队列、职位删除审计、Agent 查询审计、履历文档/FTS5和可选向量元数据。 |
| 7 | `candidate_demographics_and_large_import` | 候选人性别、生日、年龄和性别索引。 |
| 8 | `agent_sessions_and_full_business_search` | Agent 会话/消息/摘要、全业务字段搜索文档/FTS5、dirty/checkpoint/coverage 及查询辅助索引。 |
| 9 | `agent_async_tasks_and_phase_audits` | Agent 持久任务、追踪/阶段审计和候选人查询辅助索引。 |
| 10 | `durable_attachment_import_batches` | 持久附件导入批次、批次项目和导入查询索引。 |
| 11 | `candidate_hire_status_and_date` | 候选人可空 `hire_status`/`hire_date` 列及状态/日期查询索引。 |
| 12 | `candidate_hire_information` | 候选人可空 `hire_position` 列及职位查询索引；保留 V11 状态/日期列。 |

v2 新增八张表：

- `talent_pools`
- `candidate_talent_pools`
- `candidate_profile_sections`
- `candidate_preferences`
- `candidate_source_records`
- `candidate_assessments`
- `candidate_consents`
- `candidate_position_sources`

迁移在数据库打开时自动幂等执行，并在 `BEGIN IMMEDIATE` 事务中只增加列、表、索引和触发器。V8 首次打开还会同步回填全业务搜索文档并核验表级/字段级 coverage，后续打开只同步 dirty 项。V9 只新增 Agent 任务表、审计列和辅助索引，不重建 FTS 或业务表。V10 只新增持久附件导入批次及其索引；V11 只增加两个可空入职字段和索引；V12 只增加可空 `hire_position` 和 `candidates_hire_position_idx`。V11/V12 均保留既有候选人数据，不重建、清空或从旧 `stage` 回填。当前没有自动 down migration；回退必须恢复旧代码和升级前数据库文件集。FTS5 不可用、索引回填失败或 coverage 未 ready 时明确失败，不能忽略后继续运行。

## 3. 运行要求

- Windows 10/11 或 Windows Server 上可用的 PowerShell。
- Node.js 24 或更高版本，`node`、`npm` 在 `PATH` 中。
- 首次安装、关键依赖缺失或锁文件变化时需要 npm 软件源或完整本地缓存。
- 候选人、人才库和职位管理在依赖完整后可本机离线运行。
- 启用 Agent 时，需要可访问 OpenAI-compatible 模型网关；远程网关可能接收用户问题、最近对话、未打码敏感字段和履历片段。数据库扫描仍在本机完成，模型只接收分页、聚合或 Top-K 结果。

检查环境：

```powershell
node --version
npm --version
```

Node 主版本必须至少为 24，因为后端使用 Node 内置 `node:sqlite`。

## 4. 首次启动和日常启动

双击 `start.cmd`，或在项目根目录运行：

```powershell
.\start.ps1
```

启动脚本依次：

1. 检查 Node.js/npm。
2. 检查关键运行依赖是否存在，包括 ExcelJS、`xls-reader`、`pdfjs-dist` 和 `mammoth`；仅在缺失或锁文件变化时安装锁文件中的依赖。
3. 执行 `npm run build`。
4. 执行 `npm start`。
5. `openDatabase()` 打开数据库并幂等应用 V1-V12 schema；首次 V8 启动会同步完成全业务搜索回填，数据库较大时启动时间和文件体积可能明显增加；V9-V12 迁移本身不再次全量回填或改写既有候选人资料。
6. Express 在回环地址提供 React 静态文件和 `/api`。

监听日志形式为：

```text
Recruitment API listening on http://127.0.0.1:4173
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:4173/api/health
```

响应 `status` 应为 `ok`。健康检查只证明进程和基础数据库查询可用，不代表导入、Agent 或全部业务操作已通过。

## 5. 配置

`server/index.mjs` 从项目根目录读取 `.env`，进程环境变量优先。`.env` 已被 Git 忽略，不得提交密钥。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `4173` | 本机 HTTP 端口。 |
| `HOST` | `127.0.0.1` | 只接受 `127.0.0.1`、`localhost` 或 `::1`。 |
| `DB_PATH` | 未设置 | SQLite 文件绝对或项目相对路径，优先级最高。 |
| `APP_DATA_DIR` | 未设置 | 未设置 `DB_PATH` 时使用该目录下的 `recruitment.db`。 |
| `AGENT_BASE_URL` | 未设置 | OpenAI-compatible 基础地址或 chat completions 地址。 |
| `AGENT_API_KEY` | 未设置 | 模型网关密钥，只在后端使用。 |
| `AGENT_MODEL` | 未设置 | 网关接受的模型名。 |
| `AGENT_SYNC_RESPONSE_WINDOW_MS` | `650` | 短同步等待窗口；超出后返回持久任务供轮询，允许 50-1000 ms。 |
| `AGENT_MAX_CONCURRENT_TASKS` | `2` | 单进程 Agent 并发任务数，允许 1-8。 |
| `AGENT_MAX_QUEUED_TASKS` | `20` | 有界排队任务数，允许 1-100；超出返回 `task_overloaded`。 |
| `AGENT_SQL_TIMEOUT_MS` | `3000` | 非 FTS 只读工具阶段超时，最大 15 秒。 |
| `AGENT_FTS_TIMEOUT_MS` | `8000` | FTS 工具阶段超时，最大 15 秒。 |
| `AGENT_MODEL_PLANNING_TIMEOUT_MS` | `90000` | 模型规划阶段首次尝试超时，允许 1-120 秒；重试单次最多 120 秒。 |
| `AGENT_MODEL_COMPOSITION_TIMEOUT_MS` | `90000` | 模型回答阶段首次尝试超时，允许 1-120 秒；重试单次最多 120 秒。 |
| `CORS_ORIGIN` | 未设置 | 可追加浏览器源；不是认证，也不会开放监听。 |

数据库路径优先级：

1. `DB_PATH`
2. `APP_DATA_DIR\recruitment.db`
3. `data\recruitment.db`

不要同时设置 `DB_PATH` 和 `APP_DATA_DIR`。修改配置后停止并重新启动应用。

## 6. 停止服务

在运行窗口按 `Ctrl+C`，等待进程关闭 SQLite 并返回命令提示符，再备份、移动或恢复数据库。

不要把任务管理器强制结束作为常规方式。SQLite 使用 WAL，强制结束会增加恢复时处理 `-wal` / `-shm` 的复杂度。

## 7. 数据文件与安全边界

默认数据库：

```text
data\recruitment.db
```

运行时同目录可能存在：

```text
recruitment.db-wal
recruitment.db-shm
```

不要在应用运行时单独删除、覆盖或复制这些文件。数据库包含候选人敏感资料、历史评估、原始来源载荷、授权、人才库和职位关系。

当前没有应用级静态加密。数据库文件、WAL、备份和导出中的敏感值是明文数据；必须依靠 Windows 账户权限、全盘加密和受控存储保护。界面默认隐藏敏感字段不等于数据库已加密。

候选人批量导入先写入随机命名的非公开磁盘临时文件，再由独立 Worker 解析；预览完成或失败后清理上传文件，完整结构化预览 token 默认在进程内存保留 30 分钟。简历附件是独立流程：上传先进入数据库目录旁的 `private\attachments\quarantine`，确认后随机命名文件进入 `private\attachments\files`；目录不由 Express 静态服务公开。附件预览默认 15 分钟，原 token 只在内存；进程重启后旧预览不能确认。Agent CSV 导出默认写入项目 `exports\agent`，同样按高敏文件保护。

浏览器写请求的 Origin 检查注册在 JSON 和 multipart 请求体解析之前。不允许的 Origin 对非 `GET` / `HEAD` 请求以及预检请求返回 `403 origin_not_allowed`；缺少 Origin、回环 Origin 和 `CORS_ORIGIN` 明确追加的 Origin 继续兼容。正常接受的应用响应设置 CSP、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 和受限 `Permissions-Policy`。这只是一层本机浏览器防护，不能替代登录、RBAC、会话或多人版 CSRF 设计。

附件解析 worker 的硬化包括：60 秒解析超时、空 `execArgv`、V8 old generation 256 MB / young generation 64 MB / code range 32 MB / stack 4 MB 的 `resourceLimits`；视觉适配器另有默认 15 秒出站请求超时，附件服务外层视觉调用预算默认 45 秒。这些不是 Node 进程总 RSS 上限。PDF visual renderer 仅在显式视觉能力启用并确实需要页面图像时懒加载；模块缺失或加载失败以 `pdf_visual_renderer_unavailable` 降级，不影响禁用视觉时的文本解析。Office ZIP 会实际读取 stored entry 或 inflate deflate entry，并对实际单条大小、累计 64 MB、声明长度一致性和压缩比执行限制；加密、ZIP64、未知压缩方法和 `zip_size_mismatch` 均安全失败。

`attachment_cleanup_jobs` 每 60 秒尝试处理待删除路径，单轮默认最多 25 个；取消、失败、过期、确认后的隔离文件和候选人永久删除后的正式文件都使用该失败重试机制。预览进入 `confirmed`、`cancelled` 或 `expired` 后还会清空数据库中的临时 `extracted_text` 与 `records_json`，确认正文只保留在正式附件记录。不得手工删除仍被数据库引用的 `files`，也不得把清理队列当作附件备份。

## 8. 导入运行手册

### 8.1 普通导入

普通导入支持：

- `.xlsx`
- `.xlsm`
- 未加密的 Excel 97-2003 BIFF8 `.xls`
- `.csv`

限制：

- `.xls` 必须有有效 OLE2 文件签名；不支持加密文件、BIFF5 等非 BIFF8 工作簿或仅修改扩展名的伪文件。
- `.csv` 必须为 UTF-8，不自动转码 GBK/GB2312。
- 候选人批量导入单文件上限由 `CANDIDATE_IMPORT_MAX_BYTES` 配置，默认 `67108864` bytes（64 MiB）；简历附件继续使用独立 15 MiB 上限。
- 不按候选人数或数据行数设置业务硬上限；容量由文件字节数以及工作表、列、单元格、解压后体积、文本量、Worker 内存和 180 秒解析时限共同约束。
- Excel 只把第一个工作表作为候选人数据源，第一行为表头；其余工作表仍会被扫描以执行工作表、单元格和文本资源限制。CSV 必须是 UTF-8 文本且不能包含 NUL 字节。
- 单实例同时只接收一份候选人导入预览；并发请求返回 `429 import_busy`。先预览，再用 `preview_token` 提交；token 默认 30 分钟过期，进程内最多保留 2 份预览。

### 8.2 北森正式导入

北森专用增量导入的唯一必需稳定表头是大小写准确的 `应聘者ID`。相同 ID 可以跨文件、跨批次补充不同字段：非空值补充或更新，同一文件后出现的非空标量覆盖先出现值，非空姓名可纠正旧姓名，空值不清除旧值，标签取并集且最多 50 个；姓名仍不参与自动合并。已有 ID 的后续批次可以省略姓名，新 ID 必须提供姓名；手机或邮箱属于其他候选人时阻断。

V12 入职字段规则如下：`hire_position` 去首尾空白、最多 300 个字符；`hire_status` 去首尾空白、最多 200 个字符并保留来源任意文本；`hire_date` 规范为 `YYYY-MM-DD` 且允许未来日期。非空日期对应的显式状态为空时写入精确文本 `不确定`，但不得覆盖候选人已有的显式状态。增量文件中的空职位、状态或日期均不清除旧值。三项全空只会让档案隐藏“入职信息”区块，不会删除、过滤或隐藏候选人主记录。

北森字段必须按来源事实分开处理：`最后职位类投递的职位id` 是候选人与招聘职位的关系键，非空时必须建立 `candidate_positions`；工作簿有该专用表头时行空不建立关系、不得回退普通 `职位编号`，仅整表缺表头时才允许兼容回退；`入职职位` 只写 `candidates.hire_position`，不得作为招聘职位关系键；`入职雇佣关系` 只保留在来源 `raw_payload`，不得投影为 `hire_status`。源文件没有精确 `入职状态` 表头时，不能以“入职雇佣关系”代替，日期非空行按上述规则使用 `不确定`。

`申请ID` 和职位信息是可选项。完全没有招聘职位字段时只跳过候选人职位关系；显式职位字段无效、歧义或命中归档职位时，受影响源行失败且不写入候选人、职位、关系或原始载荷。职位编号能够匹配已有职位，或同时有职位名称可创建职位时，系统才写候选人职位关系；同时有 `申请ID` 时再写申请血缘。没有职位关系但有真实面试/测评等评估载荷时，申请 ID 仅用于评估来源及归属校验。两者都不具备时，重复或已使用的申请 ID 也只作为未使用信息跳过，不阻断候选人资料。参与校验的申请 ID 如果已属于另一候选人则阻断，绝不改绑。

三份已审计 `.xls` 中，前两份没有精确 `应聘者ID`，因此不能和第三份自动跨文件合并。正式分批迁移应重新导出每份都带该字段的版本，禁止按姓名、行号或当前行序拼接。

正式操作顺序：

1. 停止应用并备份数据库文件集。
2. 检查文件格式、第一张工作表和精确 `应聘者ID` 表头；按需要检查可选申请和职位字段。
3. 在导入向导上传文件。
4. 核对预览中的候选人 ID 数、缺少 ID/姓名记录、申请/职位跳过数、匹配职位和待创建职位；预览 ID 数不等于最终成功候选人数。
5. 确认申请记录数没有被当作候选人数。
6. 对缺少身份或重复申请 ID 的行先修正源文件，不生成占位候选人。
7. 确认提交并保存批次结果与错误报告；核对导入、更新、跳过、失败四类行数之和等于总行数，`candidate_count` 只表示成功处理的唯一候选人。
8. 抽查候选人、人才库、职位、履历和来源关系。

北森提交在服务端事务中按稳定键处理候选人、职位、人才库、关系和来源资料。失败行不得贡献候选人、职位或原始载荷。重放不会重复创建候选人、职位或关系，但会更新候选人的 `updated_at`、`import_batch_id` 并新增导入更新活动，可能改变最近更新排序，因此不是严格状态幂等。预览未通过时不得绕过 API 直接改数据库。

## 9. 备份

### 9.1 停止式备份

最稳妥方式是停止应用后复制整个数据目录。默认路径示例：

```powershell
$backupStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path (Get-Location) "backups\$backupStamp"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Copy-Item -LiteralPath ".\data" -Destination (Join-Path $backupRoot "data") -Recurse
Write-Output "Backup created: $backupRoot"
```

`backups/` 被 Git 忽略不代表受访问控制。备份应移入受控企业存储，限制访问，并按公司留存策略清理。

使用 `APP_DATA_DIR` 时复制整个目录；使用 `DB_PATH` 时确认绝对路径，并把同时间点的 `.db`、`-wal`、`-shm` 视为一个文件集。

### 9.2 完整性检查

在应用停止时，对备份执行只读 SQLite 完整性检查：

```powershell
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(db.prepare('PRAGMA integrity_check').get()); console.log(db.prepare('PRAGMA foreign_key_check').all()); db.close();" ".\backups\YYYYMMDD-HHMMSS\data\recruitment.db"
```

预期 `integrity_check` 为 `ok`，`foreign_key_check` 为空。该检查不等于恢复或迁移演练。

## 10. 迁移验证（V2-V13）

### 10.1 已完成的自动化验证

当前已在系统临时目录的隔离 `legacy.db` 上反复调用 `openDatabase()`，确认：

- 旧测试候选人行及 legacy stage 保持不变。
- `schema_migrations` 只有 v1/v2 各一条。
- 八张新增表和候选人新列存在。
- `PRAGMA foreign_key_check` 返回空结果。
- 重复打开数据库不会重复迁移。

已将 `backups/pre-positions-20260804-095605/data` 的 `.db`、`-wal`、`-shm` 文件集复制到 `output/playwright/talent-v2/migration-copy/` 并在该可丢弃副本上执行 v2 迁移。迁移前候选人、备注和活动均为 0，尚无职位表；迁移后 schema 版本 1/2 和八张 v2 表存在，候选人/职位/关系/备注/活动计数均为 0，`integrity_check=ok`、`foreign_key_check=0`。该记录验证的是一份空数据升级前备份，不能替代未来含真实数据备份的恢复演练。

2026-08-04 14:07，在停止正式服务后，已将正式 SQLite 的 `recruitment.db`、`recruitment.db-wal` 和 `recruitment.db-shm` 完整复制到 `data/backups/pre-talent-v2-20260804-140759/`。该备份在只读模式下验证为候选人/职位/关系均为 0、`integrity_check=ok`、`foreign_key_check=0`。随后正式空库执行 v2 加法迁移：`schema_migrations` 仅包含版本 1 和 2，八张 v2 领域表及候选人/职位新增列完整，全部业务表仍为 0。最终服务在 `http://127.0.0.1:4173` 健康运行。该记录只证明空正式库升级成功，仍不能替代未来含真实数据时的备份恢复演练。

### 10.2 备份副本验证步骤

必须在**可丢弃副本**上运行，不能把测试路径指向正式 `data\recruitment.db`。V6 Agent 只读服务要求文件型 SQLite；不要用 `:memory:` 替代只读连接测试：

```powershell
$sourceDb = Resolve-Path ".\backups\YYYYMMDD-HHMMSS\data\recruitment.db"
$verifyRoot = Join-Path (Resolve-Path ".\output").Path "migration-verify"
New-Item -ItemType Directory -Path $verifyRoot -Force | Out-Null
$verifyDb = Join-Path $verifyRoot "recruitment-v2-check.db"
Copy-Item -LiteralPath $sourceDb -Destination $verifyDb

node --input-type=module -e "import { openDatabase } from './server/database.js'; const db = openDatabase(process.argv[1]); console.log(db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()); console.log(db.prepare('PRAGMA integrity_check').get()); console.log(db.prepare('PRAGMA foreign_key_check').all()); db.close();" $verifyDb
```

验证时只输出 schema 版本和 PRAGMA 结果，不输出候选人行。还需在隔离应用实例中核对总量和关系计数，但不得展示真实姓名、电话、邮箱或原始载荷。

预期版本：

```text
1 candidate_workbench_baseline
2 talent_library_domain
3 candidate_photo_avatar
4 candidate_photo_backfill
5 candidate_deletion_audits
6 readonly_agent_attachments_fts_deletion
7 candidate_demographics_and_large_import
8 agent_sessions_and_full_business_search
9 agent_async_tasks_and_phase_audits
10 durable_attachment_import_batches
11 candidate_hire_status_and_date
12 candidate_hire_information
13 candidate_years_experience_raw
```

验证完成后将副本标记为测试产物，不能把它误当作正式数据库或长期备份。

### 10.3 2026-08-05 正式 V5 收尾记录

该段是 V5 历史记录。正式服务停止后，曾将同一时点的 SQLite 文件集备份到 `backups/pre-v5-formal-20260805-102510/`；`recruitment.db`、`recruitment.db-wal`、`recruitment.db-shm` 三件文件 SHA-256 逐项一致。随后正式库完成 V5 加法迁移，schema `[1,2,3,4,5]`，候选人 57、归档 0、职位 0、人才库 14、照片 42，`integrity_check=ok`、`foreign_key_check=0`。自动化、截图、导入和永久删除测试均使用匿名隔离数据库，正式库未被测试数据污染。后续历史状态见 10.4/10.5，V8 当前边界见 10.6。

### 10.4 2026-08-05 V6 正式备份、迁移与只读核对

正式回环服务已停止，同一时点文件集复制到：

```text
backups/pre-v6-agent-attachments-delete-20260805-120858/
```

源文件与备份 SHA-256 逐项相同：

| 文件 | SHA-256 |
| --- | --- |
| `recruitment.db` | `929F49D76A00C44F440185AEC40D61849CC48C6FC9D3321A0F9749293676FE47` |
| `recruitment.db-wal` | `54803EA79F94B32E2D94B8D31C657D08BA1D52A5432F4F1492335D62E6A8D282` |
| `recruitment.db-shm` | `11707529AEEF55233013A5730EB44F3C0BA3B6B404F4835ACEABA778002567D6` |

运行时数据库路径优先级是 `DB_PATH > APP_DATA_DIR > data\recruitment.db`。本次在不读取或输出凭据的前提下，由操作者显式确认目标为 `data\recruitment.db`；没有仅凭默认目录猜测。V6 在匿名文件型隔离数据库完成 `npm test`、TypeScript、构建、依赖审计、关键文件语法和 1440x900/390x844 浏览器门禁后，才执行正式加法迁移。正式库没有上传测试附件或执行候选人/职位永久删除，正式数据不用于自动化或截图。

迁移后的只读核对只记录 schema、对象存在性和不含明文的聚合结果：

- schema 为 `[1,2,3,4,5,6]`。
- 9 个 V6 预期表/虚表无缺失：`candidate_attachments`、`attachment_update_previews`、`candidate_field_sources`、`attachment_cleanup_jobs`、`position_deletion_audits`、`agent_query_audits`、`candidate_resume_documents`、`candidate_resume_fts`、`candidate_resume_vectors`。
- 履历同步 trigger 共 11 个。
- `candidate_resume_documents` 为 112 条，覆盖 70 位候选人；未输出候选人行或正文。
- `candidate_attachments=0`、`candidate_resume_vectors=0`，与正式库未上传测试附件、向量检索未启用的边界一致。
- `integrity_check=ok`、`foreign_key_check=0`。

后续核对仍不得输出候选人行、附件正文或 `raw_payload`。若 schema、对象、完整性或外键检查异常，应立即停止新版本并恢复整套旧代码与同一时点文件集。

### 10.5 2026-08-05 V7 正式备份与加法迁移

在匿名 48.55 MiB 容量基准、完整自动化和双视口浏览器门禁全部通过后，正式数据库显式绑定 `data\recruitment.db`。由于本轮要求不得停止 PID `7744`，备份时先确认源三件套在复制窗口内长度和修改时间不变，再使用允许共享写入的只读文件流逐项计算 SHA-256；源文件与备份逐项一致。备份目录：

```text
backups/pre-v7-demographics-large-import-20260805-175449/
```

| 文件 | SHA-256 |
| --- | --- |
| `recruitment.db` | `c22bc2c3e70deab39c9ed3fa33e26cefb9dfe57289a19f92e16ba6f38ecedcc7` |
| `recruitment.db-wal` | `21c3020db9bb30829b47b2e786c7fbc0a3867e16daccbcd82f788d1304949d34` |
| `recruitment.db-shm` | `934b0a30cec5beee756cacc0c13c693a0c1888e3236cde89c110300a802fefaf` |

在临时目录复制该备份文件集并让 SQLite 执行 WAL 恢复后，副本 schema 为 V1-V6、`integrity_check=ok`、`foreign_key_check=0`。随后正式库只执行 V7 加法迁移，结果为 schema `[1,2,3,4,5,6,7]`，`gender`、`birth_date`、`age` 和 `candidates_gender_idx` 存在，`integrity_check=ok`、`foreign_key_check=0`；没有上传测试文件、永久删除、截图或输出候选人行。

数据库迁移不等于运行中 Node 进程热更新。V7 迁移当时 PID `7744` 按“不停止正式服务”约束未重启，因此该时点仍未加载 V7 新路由；这项历史待办已在 2026-08-06 V8 受控维护窗口通过正常停止旧服务并启动当前代码完成，当前运行状态见 10.6。

### 10.6 2026-08-06 V8 正式备份、迁移与重启

V8 已在匿名内存/临时文件型 SQLite 完成迁移、持久会话、全业务字段索引、只读政策自动化、10,000 人性能基准和双视口浏览器验收。当前完整测试为 141/141，V8 搜索聚焦 9/9，与旧履历检索联合 14/14；`npx tsc --noEmit`、`npm run build`、`npm audit --audit-level=low`（0 vulnerabilities）和服务端 `node --check` 均通过。

匿名最终基准快照（`2026-08-06T04:07:27Z`）覆盖 191/191 个政策字段（100%），处理 40,641 个源记录并生成 446,259 份 FTS 文档；回填 100.995 秒，数据库 511.48 MiB，主基准进程峰值 RSS 150.297 MiB，临时残留 0。查询中位数为：分页服务层 1.524 ms，全字段含证据检索 4.945 ms，只读 Worker 全字段 186.826 ms，多概念候选人混合进程内 1291.348 ms / Worker 1432.082 ms，SQLite 结构化问答 11.341 ms / Worker 106.051 ms。多概念路径只为召回 Top-20 建候选人范围关系子集并逐概念优先真实证据，不扩大模型上下文。跨运行会受文件缓存和系统负载影响，运维比较必须记录时间戳并使用同环境重复采样。

匿名 Playwright 在 1440x900/390x844 验证候选人和人才库成员 20 条/页、45 条共 3 页，桌面翻页清空页内选择，Agent 刷新恢复 4 条并保持跨轮上下文，Unity 召回 45 条且展示真实表/字段及安全高亮，桌面侧栏 72/224 px 切换并刷新保持，移动导航正常；控制台 0 error/0 warning，根节点无横向溢出。截图清单见 `docs/TESTING.md`。

匿名门禁通过后，旧正式 PID `17212` 通过 SIGINT 进入 shutdown，日志记录 `Received SIGINT, shutting down`；进程退出后确认 `4173` 已释放。随后把同一时点文件集备份至：

```text
backups/pre-v8-agent-history-full-search-20260806-122427/data
```

源文件与备份的大小、SHA-256 逐项匹配：

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `recruitment.db` | 253,931,520 | `05b304c291caee6e859be9ad8f5fa3e5cfea63d3707a7eab1f71c5759b0bee8c` |
| `recruitment.db-wal` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `recruitment.db-shm` | 32,768 | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |

先在可丢弃恢复副本执行 V7→V8 门禁。候选人 8,209、职位 312、人才库 35、候选人职位关系 9,980、候选人人才库关系 6,224 在迁移前后保持不变；19/19 张政策表、191/191 个字段均为 ready，业务源记录 120,806、FTS 文档 2,629,351、dirty 0，`integrity_check=ok`、`foreign_key_check=0`。副本门禁约 813.2 秒，完成后主库文件为 4,183,703,552 bytes。

正式库随后执行相同 V8 加法迁移，核心计数和索引聚合结果与副本一致，schema 为 `[1,2,3,4,5,6,7,8]`；`migration_ms=746418.831`（746.419 秒），最终主库文件为 4,183,719,936 bytes。正式核对只输出 schema、状态和聚合计数，不读取或输出搜索文档、消息正文、候选人字段、附件文本、`raw_payload` 或命中内容；不得据此声称已验证正式候选人的搜索内容。

V8 时点服务 PID 为 `7232`，仅监听 `127.0.0.1:4173`。health、会话和 schema 工具请求均返回 200；运行状态为 `readonly_connection=true`、`persistent_sessions=true`、`full_readonly=true`、18 个工具，向量检索为 disabled、fallback 为 `sqlite_fts5`，stderr 为 0。该 PID 已在下述 V9 维护窗口退出，不再代表当前运行实例。正式数据未用于自动化、截图、性能、永久删除或附件上传测试。

### 10.7 V9 正式迁移与回环验收（2026-08-07 已完成）

完整自动化/构建/审计、100,000 与 120,000 位匿名容量、SQL/FTS/模型超时、`partial` 故障注入、4 个宽泛任务并发和 1440x900/390x844 浏览器门禁通过后，维护窗口确认旧 PID `7232` 已退出且 `4173` 已释放。正式数据库没有进入任何造数、搜索压测、截图、删除或故障注入流程。

同一时点的完整 SQLite 文件集备份到 `backups/pre-v9-agent-capacity-20260807-103130/`，源文件与备份逐项长度和 SHA-256 一致：

| 文件 | 长度 | SHA-256 |
| --- | ---: | --- |
| `recruitment.db` | 4,187,049,984 bytes | `845dbc81ff21dc77b69146776362a70d3cc1ec5951b0b804629b6a73aa0492f8` |
| `recruitment.db-wal` | 10,094,032 bytes | `ba29cec9163f3da4ae08190fe72451c46fc1f7d2f0ee59e87cb2de86abaef7d3` |
| `recruitment.db-shm` | 32,768 bytes | `3222ce4f6cfc140e2da15602ddda2fad091c535f87b27ba46fe6e40be563cf74` |

备份清单 `sqlite-file-set-manifest.json` 的 SHA-256 为 `0413357a756b92cb961aa98bf04cb905ae908278f48c04a890aacd1408a984f0`。61/61 个生产文件的源码清单位于 `backups/v9-source-20260807-103130/source-manifest.json`，SHA-256 为 `33675750da369e50fbbad32ed769d7915be8959decb50cf862edaaa959c3d39e`；执行脚本 SHA-256 为 `8d84504e841da7e096525116d995551a56f5f8514ff9327ffdfa16dd70a58ac9`。正式迁移 sentinel 的批准 SHA-256 为 `b98c7ca35e50987605071983f6a9189adab2d56835ea1a7fd90d80e31703be43`；成功后迁移 ownership 已自动释放，新服务随后在同一路径以 `owner=runtime`、PID `22904` 重新取得运行时互斥 ownership，不是迁移锁残留。

可丢弃恢复副本先完成 V8→V9：recovery marker 位于 `backups/v9-recovery-marker-20260807-103130/recovery-marker.json`，SHA-256 为 `68bdc480d230afcac462213599a82d3e8a2c07b72076f3bc0b225f08e7bed96a`；DDL `migration_ms=416.783`，WAL checkpoint 为 `busy/log/checkpointed=0/901/901`。只有恢复副本的 before/after 完全通过后才执行正式模式；正式进程 `exit=0`、`ok=true`，DDL `migration_ms=151.37`，包含全量迁移前后摘要与完整性核验的墙钟为 264.7 秒，WAL checkpoint 同为 `0/901/901`。

恢复副本与正式库的结果逐项一致：schema 从 `[1,2,3,4,5,6,7,8]` 加法升级为 `[1,2,3,4,5,6,7,8,9]`，V9 登记名为 `agent_async_tasks_and_phase_audits`。迁移前后候选人 8,209、职位 312、人才库 35、活动 34,742、履历区块 221、来源记录 32,834、候选人-职位关系 9,980、候选人-人才库关系 6,224 均不变；履历 base/FTS 均为 8,430，全业务 base/FTS 均为 2,629,388，dirty 为 0。checkpoint 保持 `ready`，`queued_rows=120806`、`processed_rows=120823`、`document_count=2629388`；`processed_rows` 可包含初次排队后的增量 dirty 处理，因此大于 `queued_rows` 不表示未完成。coverage 保持 19/19 张表、191/191 个字段 ready，`integrity_check=ok`、外键异常 0 条，搜索元数据行数与摘要哈希也完全不变。

V9 新增 `agent_tasks`，表定义 SHA-256 为 `c480c640686e24a2b1bda10535ba309598fc00f04b71095941c9f5bf4fb3ea6e`；`agent_query_audits` 新增 `trace_id/task_id/phase`，六个预期索引完整，V9 定义集合 SHA-256 为 `61ff580d88447ad6e04beb325ccf0361c84bee6725130cb0aac093934d3c658f`。正式主文件从 4,187,049,984 增至 4,187,590,656 bytes（增加 540,672 bytes），checkpoint 后 WAL 为 0 bytes，SHM 为 32,768 bytes。

新服务于 `2026-08-07 11:00:40+08:00` 启动，PID `22904`，端口 `4173` 只有 `127.0.0.1` 回环监听。`/api/health` 返回 200、`status=ok`、`service=recruitment-api`；`/api/agent/status` 返回 200，`configured/read_only/readonly_connection/persistent_sessions/full_readonly/async_tasks=true`，访问模式为 `sqlite_full_readonly_on_demand`，18 个工具已加载，向量关闭并回退 `sqlite_fts5`；普通根页面返回 200。health-only 后的正式空闲服务快照为 Working Set 66.8 MiB、Private 73.1 MiB，stdout 51 bytes、stderr 0；该 RSS 不能与匿名容量/并发峰值比较。

本次正式验收只读取 schema、状态、聚合计数、摘要哈希、完整性、外键和普通运行状态，没有读取或输出候选人正文、搜索词、命中内容、消息、附件文本或 `raw_payload`，也没有在正式库执行搜索、模型问答、截图、负载、写入、删除、上传或故障注入。完整脱敏结构化记录见 [v9-formal-deployment.json](evidence/v9-formal-deployment.json)。实际回退仅验证了可丢弃恢复副本迁移，没有对正式文件集实施破坏性恢复演练。

### 10.8 V10-V12 代码迁移、V11 正式收尾与 V12 隔离验收（2026-08-21）

当前代码已包含 V10 `durable_attachment_import_batches`、V11 `candidate_hire_status_and_date` 和 V12 `candidate_hire_information`。正式数据库升级仍必须先停止服务、备份同一时点的 `.db`、`-wal`、`-shm` 文件集，并先在可丢弃副本执行迁移；V11 只补充可空 `hire_status`/`hire_date` 和两个索引，V12 只补充可空 `hire_position` 和一个索引，均不重建候选人表、不清空旧数据，也不把旧 `stage` 自动回填为入职状态。

本轮正式维护窗口已完成：旧服务 PID `32716` 已停止，升级前三件套备份位于 `backups/pre-v11-hire-status-20260821-111600/data/`，原始 `.db`、`-wal`、`-shm` 均保留，未用于测试数据写入。随后以显式目标 `data/recruitment.db` 执行 V11 加法迁移和只读核对（迁移/核对进程 PID `31752`）；迁移连接关闭时完成 checkpoint，主库当时为 `22,021,361,664` bytes，关闭时 WAL/SHM 已清理，服务重启后由 SQLite 重新创建的运行时 WAL/SHM 不属于迁移残留。结果为 `schema_migrations` V1-V11 完整，`candidates.hire_status`、`candidates.hire_date` 和 `candidates_hire_status_idx`、`candidates_hire_date_idx` 均存在，`PRAGMA integrity_check` 返回 `ok`，`PRAGMA foreign_key_check` 返回 0 条异常。没有读取或输出候选人明文、原始载荷、附件正文或搜索命中内容；脱敏证据见 [v11-formal-deployment.json](evidence/v11-formal-deployment.json)。

备份三件套的 SHA-256 已记录在证据文件中：`recruitment.db=793E873A44E2...E5942`、`recruitment.db-wal=279E4477BE84...92ED8`、`recruitment.db-shm=CF1659CCB88E...3DD6`；文档中不展开真实候选人数据。迁移后服务已以 PID `22096` 重启，`http://127.0.0.1:4173/api/health` 返回 HTTP 200、`status=ok`，启动 stderr 为空。

本轮已生成 7 个逐文件 `_已整理.xlsx` 工作簿，输出目录为 `outputs/2026-08-21-hire-status-cleaned/`，另有 `cleanup-summary.json`。强制真实文件专项为 8/8 通过（含最终输出、暂存导出、artifact inspect sidecar、渲染预览和清理摘要的硬链接别名保护）；共保留 1,390 行、移除 61,471 行，4 行保留记录的入职日期为空，原始 `.xls` 文件保持只读且 SHA-256 未变。清理规则为 `trim(status) !== '' && trim(status) !== '空'`，日期为空不会删除有状态行。专项结束后已删除包含真实预览的 `.tmp-hire-status-artifact` 临时目录，交付目录只保留 7 个 `.xlsx` 和 `cleanup-summary.json`。

收尾复核命令：

```powershell
node --test tests/backend/hire-status-v11.test.mjs tests/backend/xls-import.test.mjs tests/backend/candidate-demographics-ui.test.mjs
$env:HIRE_STATUS_WORKBOOKS_REQUIRED = '1'
node --test tests/backend/hire-status-workbooks.test.mjs
```

本轮收尾结果：上述 focused 门禁合计 23/23，真实工作簿专项 8/8（0 跳过）；在清除宿主预设 `ATTACHMENT_VISUAL_*`/`AGENT_*` 变量的清洁子进程中，完整 `npm test` 为 532 项、531 通过、0 失败、1 跳过；`npm run build` 退出码 0（Vite 转换 1,858 个模块，保留主 chunk 大小提示）；`git diff --check` 退出码 0。若宿主预设视觉/Agent 变量，先按测试说明清除变量后运行门禁，不能打印配置值。

V12 另使用新的 BIFF8 `.xls` 完成脱敏 100 人隔离验收：原表 191 列、10,000 行，135 行有入职日期且没有精确 `入职状态` 表头；隔离样本预览 100/100 有效，36 行含非空 `最后职位类投递的职位id`。提交仅写入 `:memory:` SQLite，得到 100 位候选人、100 份人才库关系、100 份来源记录、31 个职位和 36 条候选人职位关系，完整性为 `ok`、外键异常为 0。`入职职位`、日期触发的 `不确定` 状态和原始 `入职雇佣关系` 均按 8.2 的边界验证。脱敏证据见 [v12-hire-information-import-20260821.json](evidence/v12-hire-information-import-20260821.json)。

该隔离证据明确记录 `formal_database_commit=false`，不能替代正式事实。2026-08-24 已验证维护服务绑定正式 `data/recruitment.db` 且后台写入暂停，并对 `北森候选人入职信息导入样本-100人.xlsx`（SHA-256 `7D92DB6C37B892F3237E490E5424CC367CE14C9CAAE3F3584FB3083AD0A6C741`）完成 HTTP 预览与用户确认提交：`profile=beisen_talent`、100/100/0、`existing_duplicates=100`；职位映射为 `最后职位类投递的职位id`，create/match/link/conflict 为 0/32/36/0；提交为 0 导入、100 更新、0 失败/跳过、100 候选人，`positions_created/matched=0/32`、`links_created=0`、`pools_created=0`、`application_count=0`。前 20 条预览的入职职位/日期/`不确定` 状态及人才库、来源预览已核对。用户明确豁免提交后的 22GB 全库摘要、100 行逐项字段查询、完整性/外键后检和恢复演练；不得将本段写成 V12 schema postcheck、字段逐行后检或恢复成功。脱敏 HTTP 证据见 [v12-hire-information-formal-import-20260824.json](evidence/v12-hire-information-formal-import-20260824.json)。

### 10.9 V13 工作年限迁移运行手册（Task 7 已完成）

V13 的唯一迁移记录是 `(13, 'candidate_years_experience_raw')`。它以加法方式确保 `candidates.years_experience_raw TEXT NOT NULL DEFAULT ''` 存在，并且只回填原文为空、`years_experience` 数值非空的旧行；非空原文不覆盖，数值 `NULL` 不回填为 `0`。迁移必须在 V12 后执行，允许重复启动且不重建候选人表。

运行顺序：停止服务；记录代码和实际数据库路径；备份同一时点 `.db`、`-wal`、`-shm`；在可丢弃副本执行 V12→V13 并核对列、迁移账本、候选人数、非空原文不覆盖、数值旧行回填和 `PRAGMA integrity_check`/`PRAGMA foreign_key_check`；再运行 V13 专项与全量测试；最后才在受控维护窗口启动正式实例。不得手工插入迁移账本或重建 `candidates`。

V13 回滚是回滚应用代码并保留新增列，避免破坏已经保存的来源原文。若确有删除列的需要，只能在另行创建并验证可恢复备份、获得批准后进行离线维护；本运行手册不授权删除列。Task 7 已完成指定工作簿最多 100 条只读预览，脱敏聚合记录见 [v13-years-experience-import-20260825.json](evidence/v13-years-experience-import-20260825.json)。当前尚未执行 V13 正式部署或正式库迁移；只读样本证据不授权或替代这两项生产操作。

## 11. 恢复

恢复会切换当前数据集。操作前必须停止应用，并把现有目录另存为可回退副本。默认路径示例：

```powershell
$restoreSource = Resolve-Path ".\backups\YYYYMMDD-HHMMSS\data"
$restoreStamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (Test-Path -LiteralPath ".\data") {
    Move-Item -LiteralPath ".\data" -Destination ".\data-before-restore-$restoreStamp"
}
Copy-Item -LiteralPath $restoreSource -Destination ".\data" -Recurse
```

恢复后：

1. 执行 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`。
2. 用原配置启动应用并检查 `/api/health`。
3. 检查 `schema_migrations` 是否为预期版本。
4. 只做数量和关系抽查：候选人、人才库、职位、未分组人数、关系、备注和最近导入批次。
5. 在受控环境抽查候选人详情，不在日志或截图中泄露真实敏感信息。

不要混合不同时间点的 `.db`、`-wal`、`-shm`。

## 12. 升级与回退

建议升级步骤：

1. 记录代码版本、Node 版本和实际数据库路径。
2. 停止应用并完成数据库文件集备份。
3. 执行备份完整性检查。
4. 先在可丢弃备份副本上执行 V1-V13 幂等迁移、全业务 FTS5、dirty/coverage、持久会话/任务、附件批次、只读查询、人口字段、三项入职字段和 V13 工作年限原文/数值投影验证。
5. 更新代码，保留 `.env` 和外部数据目录。
6. 运行 `npm install --no-audit --no-fund`。
7. 运行 `npm test`。
8. 运行 `npm run build`。
9. 启动应用，检查健康接口、schema 版本和关键数量。
10. 验证候选人、人才库、职位、导入预览、删除预览、附件、附件批次、全业务 FTS5、会话 API、Agent 只读状态及 `hire_position`/`hire_status`/`hire_date` CRUD、V13 `years_experience`/`years_experience_raw`/`years_experience_display` 的导入导出和条件展示；北森预览还须核对人才库、来源记录和 `最后职位类投递的职位id` 关系计数。V13 Task 7 只读样本预览已完成，发布前须核对其脱敏聚合证据；正式部署和正式库迁移仍按本手册另行执行。需要清理北森文件时，另运行 10.8 的七份工作簿专项。

若升级失败，停止新版本，恢复上一版代码和升级前同一时间点数据库文件集。不要只回退代码继续使用 V6 数据库；当前没有 down migration。

V13 工作年限是该通用规则的明确例外：常规回退只回退应用代码，同时保留现有数据库、`years_experience_raw` 列及其已保存的来源原文。不要把恢复 V13 前文件集作为 V13 的常规回退，也不要为此删除列或原文数据；任何破坏性列/数据移除都必须先完成独立可恢复备份、获得批准，并在离线维护中执行。其他迁移仍按各自运行手册决定是否需要恢复升级前文件集。

## 13. Agent 运维

Agent 配置完整时提供 18 个全字段按需只读工具；完整列表见 `docs/AGENT_SECURITY.md` 和 `GET /api/agent/status`。其中 `search_all_records` 用于跨候选人、职位、人才库、来源、附件和最小删除审计的实体检索，`search_candidate_resumes` 用于候选人级 Top-K 召回。状态应包含 `read_only=true`、`full_readonly=true`、`access_mode=sqlite_full_readonly_on_demand`、`persistent_sessions=true` 和独立只读连接可用。

Agent 使用文件型数据库独立 worker，以 `readOnly` 打开并启用 `query_only=ON`、`trusted_schema=OFF`、defensive mode、禁扩展和 SQLite authorizer。常规查询最多 100 行/1 MB/默认 3 秒；本地 CSV 导出最多 50,000 行/25 MB。`agent_query_audits` 覆盖 SQL/FTS、`business_search_sync`、`model_gateway_wait`、`agent_tool_call:<name>` 和 `agent_response_assembly` 分段，只保存阶段/工具、表/列/函数范围、耗时、行数和错误，不保存问题、回复、参数、结果或敏感正文。

Agent 可以按明确问题读取未打码联系方式、照片地址、薪资、legacy stage、备注、活动、`raw_payload`、完整履历和附件正文。远程模型网关可能接收这些内容；启用前必须完成数据处理评审。Agent 没有写 API、附件确认、归档/恢复、关联或删除工具。

V8 会话正文、Agent 回复和摘要保存在当前 SQLite，`localStorage` 只保存活动会话 UUID 与历史面板开关。会话 API 响应使用 `private, no-store`，但数据库、WAL 和备份仍包含明文聊天；删除会话只级联删除当前库中的消息与摘要，不清理模型网关日志或历史备份。长会话摘要最多读取 256 KiB 历史并可能发送到已配置网关，必须纳入数据处理和留存评审。

V9 的 `agent_tasks` 是 Agent 专用持久任务状态，不是外部消息队列。默认同时运行 2 个、排队 20 个；SQL、FTS、模型规划和模型回答的首次尝试超时分别为 3/8/90/90 秒，并对可恢复的模型/工具故障做有限退避重试，模型重试单次最多 120 秒。正常任务没有固定总执行截止或总工具调用上限，`/api/agent/status.task_limits` 中 `deadline_ms` 与 `max_tool_calls` 为 `null`；同一批工具最多并发 4 个。应检查匿名基准的阶段耗时、响应字节和 Worker RSS，并通过语义重复与真实证据进展定位循环，不能用过小的整体预算截断有效任务。

任务阶段为 `queued|planning|querying|retrieving|composing`，终态为 `completed|partial|failed|cancelled`。前端通过 `task_id` 轮询并在刷新后恢复；运行任务每 2 秒更新一次心跳。进程中断时，遗留活动任务保留原问题和数据库快照，服务恢复后自动重新排队并允许继续调用只读工具；用户主动取消才进入 `cancelled`。已经取得真实工具证据、但后续阶段持续失败的任务进入可“继续生成结果”的 `partial`；恢复时证据足够则直接回答，证据不足则新增必要的 `agent_tool_call:*` 审计并继续查询。若任务长期停在活动态，应先读取无正文任务元数据和审计阶段，不能直接编辑任务表。

宽泛搜索默认不做精确总数，返回 Top-K 与 `has_more`；用户明确要求精确数量时才允许完整计数。100,000/120,000 容量门禁必须同时检查 FTS 文档数、冷/热缓存、Worker 峰值 RSS、响应大小和并发时业务 API 可用性。`tests/performance/v8-anonymous-benchmark.mjs` 仍是当前匿名脚本名；禁止把它指向 `data\recruitment.db`。

全业务检索正常时，`search_index_checkpoints_v2` 的 `full` scope 和全部表级/字段级 coverage 都应为 `ready`，`search_index_dirty_v2` 应为空。业务写事务会同步刷新 dirty 项；若状态为 pending/failed 或 dirty 长期不清空，停止使用检索并在匿名/备份副本复现。不得直接编辑搜索文档、FTS shadow、checkpoint 或 coverage，也不得退化为把全库正文传给模型。

附件 suggestion provider 只在现有 Agent 网关配置完整时启用，最多提交 120,000 字符和 100 条记录，要求 strict JSON Schema，且请求没有 tools。网关不可用或返回无效结构时保留本地规则建议，用户仍可人工复核；不得把模型建议当作已写入。若预览已确认、取消或过期，临时正文已被擦除，必须重新上传才能重新生成建议。

现有网关未确认 Embedding 能力，状态中的 `vector_search.enabled` 应为 false，检索回退为 SQLite FTS5。不得自行配置新的 Embedding、向量数据库或外部解析服务。

修改 `AGENT_BASE_URL`、`AGENT_API_KEY` 或 `AGENT_MODEL` 后需要重启。远程网关故障不影响候选人、人才库和职位管理。

## 14. 故障排查

| 现象 | 检查与处理 |
| --- | --- |
| Node.js/npm 不可用 | 安装 Node.js 24+，重新打开 PowerShell并检查版本。 |
| `npm install` 失败 | 检查 npm 源、代理、网络和磁盘；不要删除业务 `data/`。 |
| `npm run build` 失败 | 保存完整输出；构建失败不会删除 SQLite 数据。 |
| 端口已占用 | 用 `Get-NetTCPConnection -LocalPort 4173 -State Listen` 查找旧实例，或更换本机端口。 |
| 服务拒绝 `HOST=0.0.0.0` | 这是当前个人版的安全限制，恢复为回环地址。 |
| 原有候选人“消失” | 检查 `DB_PATH`、`APP_DATA_DIR` 和启动目录，先定位原数据库，不要继续导入。 |
| 启动迁移失败 | 停止应用，保存错误，检查磁盘、目录权限和备份；不要反复修改正式库。先在副本复现。 |
| `schema_migrations` 缺少 v2 | 确认运行当前代码且数据库可写；在副本复现后再决定恢复或升级。 |
| `schema_migrations` 缺少 V6 / 启动报 FTS5 | 停止服务，在匿名或备份副本检查 SQLite 是否含 FTS5；不能跳过 V6 或静默改为全库文本扫描。 |
| `schema_migrations` 缺少 V7 / 性别筛选失败 | 确认运行当前代码并在副本复现 V7 加法迁移；不得手工删除或重建候选人表。迁移成功但旧进程未加载新路由时需安排受控重启。 |
| `schema_migrations` 缺少 V8 / 首次启动很久 | V8 首次打开同步回填全业务搜索；确认磁盘空间和进程仍在运行，不要中断后手工改迁移账本。先在同规模副本测量并检查 checkpoint/coverage。 |
| `schema_migrations` 缺少 V9 / 任务端点 404 | 当前进程未加载 V9 路由或数据库未执行加法迁移。在恢复副本先验证 V8→V9，再安排受控重启；不得手工插入迁移账本。 |
| `schema_migrations` 缺少 V10 / 附件批次查询异常 | 在停止服务并备份文件集后，先在可丢弃副本验证 V9→V10；确认 `attachment_import_batches`、`attachment_import_items` 及其索引存在，不得手工插入迁移账本。 |
| `schema_migrations` 缺少 V11 / 入职字段缺失 | 在停止服务并备份文件集后，先在可丢弃副本验证 V10→V11；确认 `candidates.hire_status`、`candidates.hire_date` 及两个索引存在。V11 不会从 `stage` 回填，也不应手工重建候选人表或清除旧数据。 |
| `schema_migrations` 缺少 V12 / 入职职位缺失 | 在停止服务并备份文件集后，先在可丢弃副本验证 V11→V12；确认 `candidates.hire_position` 和 `candidates_hire_position_idx` 存在。不得手工插入迁移账本、把 `入职职位` 当招聘职位关系键或以 `入职雇佣关系` 回填状态。 |
| `schema_migrations` 缺少 V13 / 工作年限原文列缺失 | 停止服务并备份文件集后，先在可丢弃副本验证 V12→V13；确认 `candidates.years_experience_raw` 与迁移记录 `(13, 'candidate_years_experience_raw')` 存在，检查仅数值旧行回填且 `NULL` 未变 `0`。不得手工插入账本、重建候选人表或删除 V13 列。 |
| 搜索返回 `search_index_not_ready` | 检查 dirty、checkpoint、表级/字段级 coverage 和最后错误；在副本复现触发来源，不得手工标 ready 或退化为整库正文扫描。 |
| Agent 历史会话未恢复 | 检查会话 API、活动状态和存储的值是否为合法 UUID；`localStorage` 只用于定位，正文应从 SQLite 重新读取。已归档/已删除会话不会作为活动会话恢复。 |
| Agent 会话返回 `session_busy` / `request_already_failed` | 等待当前请求完成；超过 2 分钟的锁会被视为陈旧。失败或中断后使用新的 `client_request_id`，不要修改会话表绕过锁。 |
| Agent 返回 `task_overloaded` | 有界队列已满。等待现有任务结束或取消不需要的任务；先定位宽泛查询、网关延迟和并发来源，不要无界提高队列。 |
| Agent 返回 `query_timeout` / `model_timeout` | 根据 `task.error.stage` 和无正文阶段审计区分 SQL/FTS、规划或回答超时。可恢复故障会先有限退避重试；已有真实证据时显示 `partial` 并允许从快照继续，恢复后仍可补取不足证据。 |
| Agent 任务长期无进展 | 查看任务的 `heartbeat_at`、阶段和 `trace_id`，再检查对应无正文审计、语义重复工具和是否取得新证据。可通过取消 API 终止；不得直接杀 SQLite 或修改任务状态。 |
| 人才库关联返回 404/409 | 刷新候选人和人才库；检查实体是否不存在、重复、关闭或归档。 |
| 北森文件未进入专用预览 | 第一张工作表必须含大小写准确的 `应聘者ID`；`应聘者Id` 不是该字段。 |
| `.xls` 返回 422 | 确认文件是未加密 Excel 97-2003 BIFF8 且 OLE2 签名有效；不要仅改扩展名。必要时从来源系统重新导出。 |
| 北森缺少身份错误 | 补充 `应聘者ID`；新 ID 还需姓名。不要按姓名或行号强制合并。 |
| 申请或职位被跳过/阻断 | 没有职位字段时只影响关系；若显式职位字段无效、歧义或命中归档职位，则检查 `申请ID`、`职位编号` 和职位名称并修正源行，该行不会写入候选人资料。 |
| 预览 token 过期 | 重新上传并检查预览，不能绕过预览直接提交。 |
| 敏感详情无法显示 | 确认详情请求成功；敏感字段默认不在列表响应中，这是预期行为。 |
| Agent 未配置或返回 503 | 检查三个 Agent 环境变量并重启。 |
| Agent 网关错误或回答超时 | 检查失败阶段、网关、模型名、密钥权限和 OpenAI-compatible 响应；数据库已成功时任务应为 `partial`，不能笼统提示重新提问。 |
| Agent 无法修改数据 | 这是预期行为；Agent 有 18 个全字段只读工具，但没有任何写工具。 |
| Agent SQL 返回 `query_not_authorized` | 查询含非 SELECT/只读 CTE、未知表/列/函数、写 PRAGMA、ATTACH 或其他被 authorizer 拒绝的操作；不要绕过保护。 |
| 附件返回 415/422/413 | 检查扩展名、MIME、签名、加密/扫描状态以及 15 MB、页数、解压、工作表、行列和正文限制；不使用在线转换服务处理正式简历。 |
| 附件预览过期或重启后 token 无效 | 重新上传并复核；预览 token 一次性且原值只在当前进程内存。 |
| 附件模型建议缺失 | 检查现有 Agent 网关状态；网关错误时本地规则建议仍可用。不要绕过差异预览或把网关输出直接写库。 |
| 附件物理文件未删除 | 查看 `attachment_cleanup_jobs` 的 attempts/last_error，不输出路径内容到公开日志；修复权限或占用后调用维护重试。 |

## 15. 日志、监控与当前验收状态

日志只输出到启动终端，没有轮转、持久化指标、告警或自动拉起。对外分享日志前必须去除候选人、文件路径、网关响应和密钥。

当前验证状态：

- V6 完整 `npm test` 已在匿名内存/临时文件型数据库通过 78/78；附件聚焦套件 10/10，安全聚焦套件 2/2。
- `npx tsc --noEmit` 和 Vite 7.3.6 生产构建通过，构建转换 1598 个模块；18 个服务端 `.js` / `.mjs` 文件通过 `node --check`；`npm audit --audit-level=low` 为 0 vulnerabilities。
- 临时隔离 `legacy.db` 迁移验证已通过。
- `backups/pre-positions-20260804-095605/data` 的隔离复制件已完成 v2 迁移验证：schema 版本 1/2、八张新表、原记录计数、完整性和外键检查均正常；该备份本身为空数据，不能替代未来含真实数据备份的恢复演练。
- V6 已完成 1440x900、390x844 Playwright 最终复验，修复 `.bulk-action-bar` 负 margin 导致的移动端遮挡；两种视口根节点宽度等于 viewport，控制台 0 error、0 warning。候选人/职位删除预览走真实 API，但没有向正式库提交永久删除；最终截图位于 `output/playwright/final-v6-security-20260805/desktop-1440x900-fixed.png` 和 `output/playwright/final-v6-security-20260805/mobile-390x844-fixed.png`。
- 尚待在隔离数据库使用带精确 `应聘者ID` 的正式文件完成前端 dry-run 和人工复核；现有前两份 `.xls` 因缺少该字段不能用于跨文件增量合并。
- 正式数据库已显式绑定 `data\recruitment.db` 完成 V6 加法迁移及只读核对：schema `[1,2,3,4,5,6]`，9 个预期表/虚表和 11 个履历同步 trigger 完整，履历文档 112 条并覆盖 70 位候选人，附件和向量记录均为 0，完整性正常且外键异常 0 条。
- V7 完整自动化 107/107、48.55 MiB/10,241 位匿名容量基准和 1440x900/390x844 浏览器门禁通过；正式备份三件套逐项哈希匹配后完成 schema V7 加法迁移，完整性正常且外键异常 0 条。V7 时点未重启旧 PID 的历史待办已由 V8 维护窗口完成。
- V8 匿名自动化为 `npm test` 141/141；全业务搜索聚焦 9/9，与旧履历检索联合 14/14，TypeScript、生产构建、低级别依赖审计和服务端语法检查通过。匿名 10,000 人检索基准和 1440x900/390x844 浏览器验收已完成；正式三件套备份、恢复副本门禁、正式 V8 加法迁移、索引 coverage 聚合核对和服务重启也已完成。
- V9 完整自动化、100,000/120,000 匿名容量、并发/取消/partial/恢复、分层超时和双视口浏览器门禁均已通过；正式三件套备份、恢复副本门禁、V8→V9 加法迁移、聚合/摘要一致性核对和回环重启也已完成。当前正式服务为 PID `22904`、schema `[1,2,3,4,5,6,7,8,9]`，详细证据见 10.7 节。

V9 匿名基准和浏览器结论不能替代真实北森文件、正式数据分布或多人吞吐验收；正式迁移证据也只证明备份一致、加法 schema、聚合/摘要保持、完整性、外键、coverage 和运行健康，不包含正式候选人搜索内容验收。详细结果以 `docs/TESTING.md` 最新收尾记录为准。

## 15.1 PDF 双通道附件解析运维

当前服务没有持久化指标、告警或日志轮转；以下均为建议观测点，不代表已部署监控：按 `pipeline.text.status`、`pipeline.visual.status`、`pipeline.visual.error_code` 和顶层附件 `error_code` 计数；记录无正文的解析/渲染/视觉请求耗时、队列深度、Worker 终止数、fallback 比率、页数、像素与 PNG 字节预算命中、清理队列积压和重试次数。标签不得包含附件正文、页图/base64、文件名、绝对路径、token、网关地址或密钥；需要关联时使用短期随机 preview/job ID 或已脱敏的错误码。

排障顺序：先检查顶层预览是否仍为 `parsing` 或已 `failed`，再分别查看 `pipeline.text`、`pipeline.text_model` 和 `pipeline.visual`。`review_required=true` 表示扫描/混合 PDF 或视觉未成功，必须人工核对，但不等同于整个解析失败；`pipeline.visual=fallback` 仍可确认确定性结果。`visual_capability_disabled` 表示未显式声明 `image_input`；`visual_capability_unknown` 表示能力值未知；`visual_configuration_invalid` 表示本地配置不完整；`visual_endpoint_invalid`、`visual_endpoint_insecure`、`visual_endpoint_blocked` 和 `visual_endpoint_unapproved` 表示端点安全校验拒绝。文本端点 `attachment_suggestion_endpoint_invalid`、`attachment_suggestion_endpoint_insecure` 是不可重试的配置错误。上述配置错误不是网关主动探测结果，网关可达性和响应合规性只在实际请求/响应中验证。`pdf_visual_*` 表示渲染安全限制或超时；其中 `pdf_visual_render_timeout` 会标记视觉通道可重试，渲染器缺失、尺寸/像素/PNG 上限和其他资源限制保持不可重试。`visual_timeout`、`visual_http_error`、`visual_invalid_json`、`visual_invalid_schema`、`visual_response_too_large` 和 `visual_unavailable` 表示视觉适配器的安全降级。不要把任意网关错误原样输出，也不要把 fallback 处理成重试全文解析、调用在线转换/OCR 或直接确认写库。

先核对配置名称及部署时是否显式设置端点，但不得打印值：文本通道 `ATTACHMENT_TEXT_SCHEMA_MODE`、`ATTACHMENT_TEXT_TIMEOUT_MS`、`ATTACHMENT_TEXT_MAX_RESPONSE_BYTES`；视觉通道 `ATTACHMENT_VISUAL_CAPABILITY`、`ATTACHMENT_VISUAL_SCHEMA_MODE`、`ATTACHMENT_VISUAL_BASE_URL`、`ATTACHMENT_VISUAL_ALLOWED_HOSTS`、`ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS`、`ATTACHMENT_VISUAL_API_KEY`、`ATTACHMENT_VISUAL_MODEL`、`ATTACHMENT_VISUAL_TIMEOUT_MS` 与各页/像素/字节上限。compat 必须显式设置，不能把网关不支持 strict 当作自动回退。端点必须为 `http`/`https`；生产拒绝明文 HTTP，非生产 loopback HTTP 仅限隔离测试。私网默认拒绝，只有精确列入 `ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS` 的 DNS 主机名、HTTPS 端点、且（若配置）同时在普通主机 allowlist 中，才允许全部 DNS 地址为 RFC1918/IPv6 ULA；IP 字面量、通配符/后缀匹配、`.localhost`/`.internal`/`.local`/metadata 保留主机名、混合公网/私网答案，以及 URL 用户信息、回环、link-local、metadata、multicast、保留地址、IPv4-mapped、NAT64 和 6to4 等危险目标仍拒绝。主机名在请求前解析，所有 DNS 结果逐一校验，实际连接使用 pinned lookup 固定到这些地址；公网 HTTPS 可用主机名 allowlist 进一步约束，部署网络出口策略仍作为独立纵深控制。配置在服务创建适配器时读取，变更后需受控重启。维持两层边界：附件 15 MiB、PDF 200 页；Worker 渲染最多 12 页、单页 3,000,000 像素、总计 18,000,000 像素、累计 RGBA raster 64 MiB、单页/总 PNG 4/24 MiB、单页 8 秒，整份 PDF 的顺序页面渲染共用 30 秒且每页只能使用剩余预算、解析 Worker 60 秒；视觉适配器的出站请求最多 12 页、4,000,000 像素/页、3 MiB/页、12 MiB 总图像、8,000 字符/页、单 span 1,000 字符、100 条记录、512 KiB 响应，默认 15 秒。适配器请求固定 `stream:false`、无 tools 并拒绝重定向；附件服务外层视觉总预算默认 45 秒。视觉配置和 override 只能下调这些值，超过硬上限会安全 clamp。资源受限时保持确定性通道结果而不是提高上限掩盖异常输入。

回滚不需要数据迁移：在受控发布中把视觉能力设为非 `image_input` 后重启服务，新的 PDF 预览会跳过页渲染并返回确定性结果及视觉 fallback。已存在的预览和正式附件不含持久化 PNG/data URL，不应尝试从数据库恢复视觉页；需要重新得到视觉建议时只能在合规边界内重新上传并人工复核。回滚前后都不得删除 `candidate_attachments`、`attachment_update_previews` 或 `attachment_cleanup_jobs` 来解决视觉故障；先在匿名隔离实例复现，确认清理队列与附件下载不受影响。

## 16. 多人部署前置条件

当前多人部署仍不支持。要供部门成员共同使用，至少需要完成并验收：

- 登录、SSO、RBAC、字段级敏感权限和部门隔离。
- TLS、受支持的网络监听和会话安全。
- 共享数据库、并发控制和迁移发布机制。
- 集中不可伪造审计和管理员复核。
- 数据库/备份静态加密、集中备份、恢复和灾备。
- 监控、告警、日志留存、物理删除和合规响应。

不能把个人版仅通过改 `HOST` 或放到一台公共电脑上当作部门版。
