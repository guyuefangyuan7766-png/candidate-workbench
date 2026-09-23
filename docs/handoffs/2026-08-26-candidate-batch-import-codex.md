# 候选人批量导入交接单（V13，继续执行）

> 交接时间：2026-08-26 12:10（Asia/Shanghai）
> 交接人：当前 Codex 会话
> 接手人：新的 Codex 会话
> 工作区：C:\Users\cboy\Documents\北森

## 0. 交接结论

本次任务已完成源文件盘点、staging 整理和 HTTP 预览，但尚未提交候选人业务数据。新会话必须从重新核验预览和审批门禁开始，不能把本文预览统计当成已导入结果。

用户此前回复“我确认”，上下文对应“确认导入人才库简历”。可将其视为人才库简历组的语义确认；若执行器要求精确口令，提交前请求：

~~~text
确认导入人才库简历
~~~

应聘者数据尚未确认。人才库简历提交并核验后，必须另行等待：

~~~text
确认导入应聘者数据
~~~

未经对应确认，不得调用正式导入 commit 接口。本交接单不扩大原任务范围。

## 1. 接手后先做什么

先按顺序阅读：

1. docs/OPERATIONS.md
2. docs/IMPORT_GUIDE.md
3. docs/FIELD_MAPPING.md
4. docs/API.md
5. docs/TESTING.md
6. docs/README.md
7. README.md
8. CHANGELOG.md
9. docs/handoffs/2026-08-25-years-experience-tolerant-import-codex.md
10. docs/handoffs/2026-08-25-years-experience-tolerant-import-claude-code.md
11. docs/superpowers/specs/2026-08-25-years-experience-tolerant-import-design.md
12. docs/superpowers/plans/2026-08-25-years-experience-tolerant-import.md
13. docs/evidence/v13-years-experience-import-20260825.json

再进行只读核对：

~~~powershell
Set-Location 'C:\Users\cboy\Documents\北森'
git status --short --branch
git rev-parse HEAD
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4173/api/health'
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4173/api/candidates/import/config'
~~~

当前已知服务 PID 为 31448，活动锁为：

~~~text
C:\Users\cboy\Documents\北森\.candidate-workbench-maintenance-0a25b3c791e50bca772d80cf.lock
~~~

先确认锁内 PID 仍对应当前服务。不要删除任何锁文件，也不要重启或另起服务。

## 2. 代码、数据库和预览副作用

- 分支：test11
- 当前提交：b76af3b fix: close V13 final review gaps
- 正式数据库：C:\Users\cboy\Documents\北森\data\recruitment.db
- V13 迁移名称：(13, 'candidate_years_experience_raw')
- schema_migrations 版本 1-13 均存在，V13 applied_at 为 2026-08-26T02:30:57.321Z。
- 当前健康状态为 status=ok。
- V13 代码实现已提交，不要为本次数据导入重写生产代码、schema 或依赖。
- 本批次未写入 candidates、positions、candidate_positions、candidate_talent_pools、candidate_source_records 或 import_batches。
- 预览 API 会写 candidate_import_tasks 元数据和受保护临时预览文件；这是预览副作用，不等于业务导入。导入前基线中的 candidate_import_tasks 为 96。

业务基线来自 staging 内的 pre-import-core-baseline.json：

| 对象 | 数量 |
| --- | ---: |
| candidates | 50,572 |
| positions | 1,219 |
| talent_pools | 40 |
| candidate_positions | 62,307 |
| candidate_talent_pools | 38,166 |
| candidate_source_records | 202,284 |
| candidate_position_sources | 62,307 |
| candidate_assessments | 62,307 |
| candidate_consents | 21,640 |
| import_batches | 39 |

工作年限基线：总候选人 50,572；years_experience 非 NULL 7,420；NULL 43,152；明确零值 3；raw 非空 7,420。

## 3. 绝对约束

- 原始文件只读，不得改名、覆盖、删除或移动。
- 正式写入只能走现有 HTTP/API 两阶段预览/提交流程，不得直接写 SQLite。
- 不安装依赖，不修改生产代码、schema 或服务。
- 手机或邮箱冲突必须失败。
- 增量空值不得覆盖已有值。
- years_experience 保持安全数值或 NULL，不能改成字符串。
- 禁止 Number(value ?? 0)。只有明确的 0 才能写数值 0；未知文本和范围值保留在 years_experience_raw，numeric 为 NULL。
- raw 和 numeric 必须成对写入；无法解析时不能残留旧 numeric。
- 不改变职位关系、人才库关系、来源历史、申请关系或入职字段逻辑。
- 日志、证据和报告不得包含姓名、电话、邮箱、应聘者 ID、原始载荷、简历正文、逐行失败内容或 preview token。
- 预览、失败和提交结果分开记录，不能把预览计数写成提交计数。

## 4. Staging 和可复用脚本

当前 staging：

~~~text
C:\Users\cboy\AppData\Local\Temp\candidate-workbench-import-20260826-111242755
~~~

其中已有：

~~~text
source-manifest.json
prepared-manifest.json
preview-aggregate.json
preview-details-aggregate.json
pre-import-core-baseline.json
talent_library\                 # 18 个 CSV 分片
applicant_data\                 # 7 个清理 CSV
~~~

仓库内临时脚本是交接成果，完成任务前保留：

~~~text
scripts/.tmp-source-inventory.mjs
scripts/.tmp-prepare-candidate-import.mjs
scripts/.tmp-preview-import.mjs
scripts/.tmp-aggregate-preview-details.mjs
~~~

脚本不调用正式 commit；preview 脚本会通过 HTTP 预览并写任务元数据。参数顺序如下，必要时在新目录重建，不要删除旧 staging：

~~~powershell
node scripts/.tmp-source-inventory.mjs 'C:\Users\cboy\Desktop\人才库简历' 'C:\Users\cboy\Desktop\应聘者数据' 'C:\Users\cboy\AppData\Local\Temp\candidate-workbench-import-20260826-111242755'
node scripts/.tmp-prepare-candidate-import.mjs 'C:\Users\cboy\Desktop\人才库简历' 'C:\Users\cboy\Desktop\应聘者数据' 'C:\Users\cboy\AppData\Local\Temp\candidate-workbench-import-20260826-111242755'
node scripts/.tmp-preview-import.mjs 'C:\Users\cboy\AppData\Local\Temp\candidate-workbench-import-20260826-111242755' 'http://127.0.0.1:4173' 'C:\Users\cboy\Documents\北森\data\recruitment.db'
node scripts/.tmp-aggregate-preview-details.mjs 'C:\Users\cboy\AppData\Local\Temp\candidate-workbench-import-20260826-111242755' 'C:\Users\cboy\Documents\北森\data\recruitment.db'
~~~

preview token TTL 为 30 分钟，存储最多保留 2 个条目；接手时 token 可能已过期，提交前逐片重新预览，只在内存中保存 token。不要把 token 写入任何文件。

## 5. 源文件和整理结果

源位置：

~~~text
A 人才库简历：C:\Users\cboy\Desktop\人才库简历
B 应聘者数据：C:\Users\cboy\Desktop\应聘者数据
~~~

19 个源文件当前均存在。本交接单生成前已重新核对大小和 SHA-256，均与 source-manifest.json 的 before/after 值一致；新会话在正式提交前后仍须重算。定位文件使用 root 加 filename，不依赖 manifest 的 relative_path。

### A 人才库简历

- 12 个 XLS、12 个可见工作表，工作表名均为 应聘者申请数据。
- 每张表都有大小写精确的 应聘者ID；非空数据行共 119,402。
- 5 个源文件超过 API 上限 67,108,864 bytes；整理安全目标为每片 48 MiB，即 50,331,648 bytes。第 6 个文件也因安全目标拆分。
- 18 个 CSV 分片保持列顺序、表头、工作表语义、行顺序和整行字段。
- 项目解析器已复核每片，parser_headers_match_unique_source 为 true。源表有重复业务表头，项目解析器按物理顺序加后缀唯一化；不要用 PowerShell Import-Csv 代替项目解析器。

行数守恒：

~~~text
119,402 原始非空行 = 119,402 个分片数据行（18 片）
~~~

### B 应聘者数据

- 7 个 XLS、7 个工作表。
- 原始 62,861 行；三列表头门禁为 入职状态、入职日期、应聘者ID。
- 只排除状态和日期同时为空的行。空状态包括空单元格、NULL、纯空白和精确文本 空。
- 7 个清理 CSV 保留整行和业务字段，状态、日期、ID 对应关系不变。

行数守恒：

~~~text
62,861 原始行 = 61,471 双空排除行 + 1,390 保留行
1,390 保留行 = 7 个分片数据行之和
~~~

不得使用“仅保留非空入职状态”的旧脚本。状态-only 必须保留；date-only 必须保留，并沿用项目逻辑写 hire_status=不确定。

## 6. 既有预览汇总（明确未提交）

文件 preview-aggregate.json 和 preview-details-aggregate.json 记录于本地 2026-08-26 11:37-11:39。生成时 25/25 片 preview_ready，但由于 TTL/存储上限，接手时必须重新预览。

### A 预览

| 指标 | 数量 |
| --- | ---: |
| 分片/行 | 18 / 119,402 |
| 有效/无效 | 115,370 / 4,032 |
| 已有身份重复 | 25,640 |
| 文件内重复 | 0 |
| 职位创建/匹配 | 93 / 2,174 |
| 职位关系计划 | 21,078 |
| 职位歧义、无效、归档冲突 | 0 |

工作年限：

| 分类 | 数量 |
| --- | ---: |
| raw 非空 | 67,499 |
| 有限 numeric 投影 | 6,571 |
| 明确 0 | 0（本批未观察到，解析测试覆盖） |
| 未解析/未知/范围 | 60,928 |
| 范围文本 | 1,223 |
| 未知文本 | 59,705 |
| 仅因工作年限失败 | 0 |

A 的 date-only 行为 1,309，必须补为 不确定，不得过滤。错误代码是出现次数，可能一行多错：missing_identity 3,701；identity_conflict 42；birth_date 196；phone 21；email 25；photo_url 47；age 4。

### B 预览

| 指标 | 数量 |
| --- | ---: |
| 分片/整理后行 | 7 / 1,390 |
| 有效/无效 | 1,387 / 3 |
| 双空排除 | 61,471 |
| 已有身份重复 | 1,378 |
| 文件内重复 | 0 |
| 缺少身份/姓名错误 | 3 |

B 入职分类：status-only 4；date-only 0；两者都有 1,386；非空非法日期 0；缺 ID 0。3 条无效行均为新身份缺少姓名，不能伪造姓名。B 不含工作年限字段。

## 7. V13 工作年限契约（已实现）

- candidates.years_experience 保持 REAL，缺失为 NULL。
- candidates.years_experience_raw 为 TEXT NOT NULL DEFAULT ''；迁移台账为 (13, 'candidate_years_experience_raw')。
- 明确、全文匹配的数值语法才生成 numeric；未知文本、范围和不确定修饰只保留 raw。
- 明确 0 保持 numeric 0；空值不能变成 0。
- 展示优先 raw，其次格式化 numeric，完全缺失显示空字符串。
- full import 成对产出两列；partial import 缺键不动，显式空值同时清两列。
- 北森、通用导入、附件和 UI 已同步成对逻辑；通用非空过滤不能丢弃 raw 非空、numeric NULL 的值。
- 数值排序/筛选仍读 REAL 列，NULL 不参加范围判断。
- 手机/邮箱冲突和提交时竞态继续阻断。

## 8. 新会话的正式执行顺序

### 8.1 提交前

1. 重读 import config，以实际返回的 max_file_size_bytes=67,108,864、preview_row_limit=20、preview_ttl_ms=1,800,000 和并发限制为准。
2. 核对服务、活动锁、数据库路径、V13 和 19 个源文件哈希。
3. 检查 manifest 的文件、工作表、分片、行范围、字节数、输出哈希和表头。
4. 逐片重新预览 A 的 18 片；确认无结构错误、无未解释冲突、行数守恒。
5. 任一前置项失败，停止并报告，不提交。

### 8.2 提交 A

1. 取得确认导入人才库简历；用户此前“我确认”只能覆盖 A。
2. 按 manifest 顺序逐片调用 POST /api/candidates/import/commit，使用对应一次性 preview token；不并发。
3. 202 异步响应按 GET /api/candidates/import/tasks/{task_id} 轮询到终态；网络不明时先查任务，不盲目重试。
4. 每片记录批次、总行、导入、更新、跳过、失败、候选人、职位、关系和来源历史的脱敏计数。
5. 任一身份冲突、结构错误、行数不守恒、未解释失败或非成功终态，停止后续 A，不自动恢复或删除已提交数据。
6. A 全部完成后，对业务表做只读聚合并与基线比较；预览 candidate_records 不是提交 candidate_count。

### 8.3 提交 B

1. A 核验完成后请求确认导入应聘者数据；此前没有 B 确认。
2. 重新预览 B 的 7 片，确认 62,861 = 61,471 + 1,390，以及 status-only 4、date-only 0、非法日期 0、缺 ID 0。
3. 按顺序提交并轮询；异常立即停止。
4. B 完成后再做完整只读核验，分开报告过滤、预览和实际提交计数。

只使用 docs/API.md 规定的端点：

~~~text
GET  /api/candidates/import/config
POST /api/candidates/import/preview
POST /api/candidates/import/tasks
GET  /api/candidates/import/tasks/{task_id}
POST /api/candidates/import/commit
~~~

## 9. 导入后核验、样本和证据

至少核对：

- 19 个源文件 SHA-256 前后相同。
- 文件、工作表、分片行数守恒，分片无遗漏/重复/表头变化。
- 每片提交计数可解释且内部守恒。
- 无新增重复来源身份；手机和邮箱冲突仍阻断。
- 空增量未覆盖已有值；date-only 得到 hire_status=不确定。
- 工作年限 0、未知文本、范围值、raw 和 numeric 正确，未知值未变 0。
- 候选人、职位、关系、人才库、来源历史、申请和入职字段无无关改写。
- 健康仍为 status=ok；schema 仍为 V13；记录导入前后聚合变化。

对下列文件最多取 100 条做只读核验，使用临时数据库/现有预览函数，不调用正式 commit，不修改源文件：

~~~text
C:\Users\cboy\Desktop\人才库简历\自定义excel7-20caac42-246c-402c-a583-45e991ec30b3.xls
~~~

只统计总行、有效/无效、仅工作年限错误、其他错误、raw 非空、numeric 投影、身份冲突、职位新建/匹配、关系、人才库和来源历史。旧的 docs/evidence/v13-years-experience-import-20260825.json 不是本批正式导入证据；实际提交后创建新的不可覆盖文件，例如：

~~~text
docs/evidence/beisen-candidate-import-20260826-HHmmss.json
~~~

证据只能含文件级和聚合数据、健康/schema/完整性/外键结果、正式库是否写入、未完成项和回滚说明，并带 candidate_level_rows_persisted=false 等隐私标记。禁止姓名、电话、邮箱、ID、payload、token 和逐行失败。

完整 PRAGMA integrity_check 曾在约 20.5 GiB 数据库上因耗时过长中止，不能声称已通过；新会话须如实报告状态。

## 10. 测试、文档和回滚

历史记录：聚焦 V13/导入/附件/UI 套件 57/57 通过；tsc、build、diff check 通过。历史 npm test 为 588 个测试中 583 通过、4 个既有 V11/V12 失败、1 个跳过。已知失败名：

1. public documentation describes the hire fields and migration
2. cleaned workbooks contain only non-empty hire statuses and preserve row alignment
3. V12 maintenance launcher and verifier require the v2 paused-writer contract
4. a failed V12 runtime sentinel acquisition leaves no maintenance attachment directory or removes a concurrent one

新会话必须重新运行聚焦测试、npm test、npx tsc --noEmit、npm run build 和 git diff --check；既有失败须原样列出，不得放宽新断言。

实际提交并核验完成后，才最小范围更新 README.md、docs/README.md、docs/DATA_MODEL.md、docs/IMPORT_GUIDE.md、docs/FIELD_MAPPING.md、docs/OPERATIONS.md、docs/TESTING.md 和 CHANGELOG.md；文档要写实际预览/提交/核验结果、A 优先、B 双空过滤、分片、哈希、备份和证据路径。不要自动提交 Git。

遇到服务不健康、锁冲突、路径/schema/哈希变化、表头或行数不一致、未解释冲突、提交异常，或需要重启、恢复、删除文件时，立即暂停询问。

普通 API 没有本批业务数据撤销操作。只有获得明确批准后，才可停止服务并按 docs/OPERATIONS.md 恢复 V13 前备份：

~~~text
C:\Users\cboy\Documents\北森\backups\pre-v13-years-experience-20260825-180645\data
~~~

恢复会回退备份之后的所有数据库变化，不能只回退本批。不得自行替换数据库、删除 WAL/SHM 或重启服务。

## 11. 最终回报顺序

只输出脱敏汇总：

1. 服务、数据库、schema。
2. A/B 文件、工作表、原始/整理行和分片。
3. A 预览与提交。
4. B 过滤、预览与提交。
5. 候选人、职位、人才库、关系、来源历史和批次变化。
6. 0、未知文本、范围值、raw/numeric 结果。
7. 冲突、失败和排除原因。
8. 源文件哈希校验。
9. 文档清单和证据路径。
10. 未完成项、完整性/外键状态和回滚方式。

本文件是候选人批量导入主索引，不覆盖已有的 V13 实施交接单。
