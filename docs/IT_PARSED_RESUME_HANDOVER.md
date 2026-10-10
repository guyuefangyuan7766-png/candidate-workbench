# 解析补全简历文本交接（给 IT / 人才资产 owner）— 完整版

日期：2026-10-10　版本：v3（含净增数据、全量数据构成；补全包已生成并落共享盘）
交接方：开发（D 盘项目 `candidate-workbench`）　接收方：IT / 人才资产维护方

## 0. 一句话结论

北森"标准简历"字段天生不全（抽样实测：原始 PDF 的句子只有 48% 能在标准简历文本里找到），
本地已用大模型把 **69,642 名候选人**的缺失区块补全解析完成、并已把 **69,629 份原始附件**提取成全文。

**推荐做法：IT 直接接收解析后的数据（不重跑模型）。**
"解析补全包"**已于 2026-10-10 16:07（本地时间）生成**，放在开发机共享盘：

- 共享路径：`\\192.168.190.58\talent-workbench\transfer\parsed-resume-20261010\`（散文件目录）
- 打包文件：`transfer\06-parsed-resume.zip`（store 模式，**840.9 MB**，解包即得上述目录）
- 规模：`parsed-sections.jsonl` 69,642 行 / 484.5 MB + `origin-text.jsonl` 69,629 行 / 356.4 MB = **841 MB**
- 校验：`checksums.sha256` + `manifest.json`（SHA256 已在开发机实测比对一致，见 §6.4）

以 `applicantId` / `candidateId` 为主键，可确定性合并进人才资产；不需要 IT 侧再买模型调用、也不受网关和提示词版本影响。
若 IT 同时执行 0.7.0 全量部署，则这些数据已包含在 `01-database.zip`（17.46 GiB）里，无需额外动作。

---

## 1. 问题背景（为什么会有这份交接）

### 1.1 现象

数据库里的"标准简历文本"来自北森结构化归一化（`candidate_profile_sections`：education / experience /
project / skill / certificate / language …），**只保留北森字段模型里有的值**；原始 PDF 里的自由文本
（求职意向、自我评价、主修/选修课程、专业排名、联系方式、详细职责描述等）基本不入标准字段。

### 1.2 实测（2026-10-10，30 名同时有 origin.pdf 原文的候选人）

| 指标 | 结果 |
| --- | ---: |
| PDF 里的句子能在标准简历文本中找到 | **48%**（286/590） |
| 标准简历文本的句子能在 PDF 中找到 | 50%（319/634） |
| PDF 含"求职意向"、标准文本没有 | 14/14 |
| PDF 含"邮箱"、标准文本没有 | 13/13 |
| PDF 含"自我评价"、标准文本没有 | 11/11 |
| PDF 含"性别 / 年龄"、标准文本没有 | 9/9、9/10 |
| PDF 含"电话"、标准文本没有 | 12/14 |
| PDF 含"主修课程 / 排名"、标准文本没有 | 8/8、6/7 |

例：候选人**郜钰**——原始 PDF 有求职意向、手机、邮箱、主修+选修课程、年级排名 8/120、
实习三条详细职责、自我评价；标准简历只有学校/专业/学历/时间 + 实习基本信息 + 技能 + 校园经历。
候选人**宋宇航**——原始 PDF 有获奖情况（自治区奖学金、优秀学生干部）、MySQL/Oracle 技能明细、
自我评价；标准文本缺失。

---

## 2. 补充数据是什么（本地已完成）

| 数据 | 表 / 标记 | 规模（实测） |
| --- | --- | ---: |
| 大模型补全的结构化区块 | `candidate_profile_sections`，`source_record_id LIKE 'origin-section-parse-v1:%'` | **542,754 行 / 69,642 人** |
| 原始附件全文提取 | `candidate_attachments.extracted_text`（origin.html / origin.pdf / origin.txt） | **69,629 份** |
| 主键映射 | `candidate_asset_index` | 119,084 行，`candidate_id ↔ applicant_id` 全覆盖 |
| 北森编号 | `candidates.source_record_id` | 即北森 `candidateId`（如 `C00146616`） |

解析口径（重要）：

- **只补空缺**：某候选人在某 `section_type` 已有北森区块时整类跳过，不覆盖、不改写北森字段；
- 解析器版本 `origin-section-parse-v1`，默认模型 `deepseek/deepseek-flash`
  （可用 `AGENT_RESUME_MODEL` / `AGENT_MODEL` 覆盖，实际以运行环境为准）；**本交接不再新增模型调用**；
- 附件全文提取为纯本地解析（`origin-text-v1`），不走模型；
- 附件文本落库后由触发器自动进入 `candidate_resume_documents` → FTS → 向量索引。

### 2.1 覆盖与缺口（119,084 人完整分解）

| 分类 | 人数 | 说明 |
| --- | ---: | --- |
| ✅ 解析成功、产出补全区块 | 69,642 | 有原始附件 + 提取到正文（≥40 字） |
| ⚪ 附件无可用文本（no_content） | 27,293 | origin.html 22,651 / origin.pdf 2,760 / origin.txt 1,894（正文 <40 字） |
| ❌ 解析失败 | 1,550 | `pdf_no_text` 805（扫描件无文本层）、`text_too_short` 738、崩溃 7、页数超限 1 |
| ⚪ 没有原始附件（只有 standard.pdf） | 9,953 | 候选人未上传原件 |
| ⚪ 附件格式不在解析范围 | 10,639 | zip 4,015 / doc 2,943 / jpg 1,870 / json 1,494 / png 302 / bin 15 / pdf 7 |
| **合计** | **119,084** | 进入解析队列 98,485 人，成功 69,642 人（71% / 占全量 58.5%） |

仍未覆盖：`standard.pdf`（119,065 份）全部 `parse_status=pending`，未提取（评估为与标准字段重复度高，收益最低）。
如要提高覆盖率，可走 OCR（1,550 份失败 + 扫描件）与格式补齐（zip/doc 约 7 千份）。

---

## 3. 补充前后净增数据（完整口径）

### 3.1 内容净增（原始 UTF-8 字节，精确）

| | 行数 / 人数 | 正文 | 结构化 JSON | 小计 |
| --- | ---: | ---: | ---: | ---: |
| 补充前：北森结构化区块 | 830,505 行 / 119,081 人 | 269.2 MB | 272.9 MB | **542.1 MB** |
| 补充①：大模型补全区块 | 542,754 行 / 69,642 人 | 84.7 MB | 325.8 MB | **410.5 MB** |
| 补充②：原始附件全文 | 69,629 份 | 309.0 MB | — | **309.0 MB** |
| **补充小计** | | | | **719.5 MB** |
| **补充后合计** | | | | **1,261.6 MB** |

导成 JSONL 交接包（含转义与行开销）的同口径体积：

| | 导出体积 |
| --- | ---: |
| 补充前等价包（北森区块，119,081 人） | 约 0.64 GB |
| 补充包（LLM 0.55 GB + 原件全文 0.32 GB） | **约 0.87 GB ≈ 0.9 GB** |
| 合计 | 约 1.51 GB |

### 3.2 库内派生副本与索引（实测 + 估算）

补充的文本在库内不止一份：正文会同时进入 `candidate_resume_documents`（简历全文文档）、
`candidate_resume_fts`（简历检索）、`search_documents_v2` + FTS（全业务检索，含 2/3-gram 膨胀）。

| 组成 | 补充部分 | 口径 |
| --- | ---: | --- |
| 文本本体（§3.1） | 719.5 MB | 精确 |
| `candidate_resume_documents` 文档副本 | 732.8 MB（LLM 423.8 + 原件 309.0） | 精确 |
| `search_documents_v2`（content + search_text） | 1,754.6 MB（LLM 463.9 + 原件 1,290.7） | 精确（含 2/3-gram 膨胀） |
| `candidate_resume_fts`（content + index） | ≈ 1.35 GiB | 估算（按字节占比 56%） |
| `search_documents_v2_fts`（index） | ≈ 0.83 GiB | 估算（按字节占比 53.7%） |
| 向量索引新增 chunk（f16） | ≈ 0.2–0.3 GiB | 估算（约 8 万个新增向量 + HNSW 图） |
| **主库净增估算** | **约 5–6 GiB** | 由以上逐项相加（保守区间） |

> 说明：`ATTACHMENT_TEXT_PERSISTENCE_PLAN.md` 里"磁盘增量 0.2–0.4 GiB"只估了附件文本列本身；
> 计入 FTS、全业务索引与 n-gram 膨胀后，实际净增在 5–6 GiB 量级。以上均以当前库实测值为基数。

### 3.3 全量数据构成（160.71 GiB / 806,852 个文件，2026-10-09 13:23 生成）

| 目录 | 类别 | 文件数 | 大小 | 里面是什么 |
| --- | --- | ---: | ---: | --- |
| `data/private/` | 运行必需 | 260,455 | **49.79 GiB** | 附件原件：简历原文件（PDF/HTML/图片）、头像等 |
| `data/asset-export/` | 留档 | 347,133 | **47.88 GiB** | 北森人才资产原始快照（profile.json / standard.pdf / origin.* / catalog 分片） |
| `data/search-vectors/` | 运行必需 | 9 | **27.66 GiB** | 向量索引（当前代 + 上一代各 10.79 GiB）+ embedding 缓存 6.07 GiB |
| `data/incremental/` | 留档 | 198,708 | **17.64 GiB** | 增量同步的下载缓存与差量数据 |
| `data/recruitment.db` | 运行必需 | 1 | **17.46 GiB** | 主库（见下表） |
| 报告 + 日志 | 报告/日志 | 543 | **0.27 GiB** | phase3 报告、评测、审计、运行日志 |
| **合计** | | **806,852** | **160.71 GiB** | 运行必需 94.91 GiB + 留档 65.52 GiB + 报告日志 0.27 GiB |

与交接包对应关系：`01-database.zip` = 主库；`02-vectors.zip` = search-vectors；
`03-attachments.zip` = private；`04-archive.zip` = asset-export + incremental；`05-reports.zip` = 报告。

### 3.4 主库 17.46 GiB 内部（dbstat 实测）

| 表 | 大小 | 说明 |
| --- | ---: | --- |
| `search_documents_v2` + FTS + 索引 | ≈ 9.5 GiB | 全业务检索索引（简历/备注/面试/附件文本） |
| `candidate_resume_documents` + `candidate_resume_fts` | ≈ 4.2 GiB | 简历全文文档与 FTS |
| `candidate_profile_sections` | 1.43 GiB | 档案区块（含补全 542,754 条） |
| `candidate_source_records` | 0.85 GiB | 北森原始记录 |
| `candidate_attachments` | 0.44 GiB | 附件元数据 + 提取文本 |
| 其它（候选人、职位、备注、审计等） | ≈ 1 GiB | — |

### 3.5 补充前后的总量

- 现在总量：**160.71 GiB**（清单已包含补全后的数据）；
- 补充前没有保留全量快照，无法给精确值；按 §3.2 估算 **扣除约 5–6 GiB**，
  补充前约 **155–156 GiB**；
- 结论：补全是"内容级"增量（文本本体 0.7 GB、连索引约 5–6 GiB），**不是体量级变化**；
  160 GiB 的绝大部分是附件原件、资产快照、向量索引与增量缓存。

---

## 4. 交付下游（先确定给谁）

| 下游 | 现状 | 解析数据的获得方式 |
| --- | --- | --- |
| A. 服务器人才资产工作台（0.7.0，`C:\apps\talent-workbench` + `C:\talent-data`） | 走全量数据包部署 | 解析结果已在 `01-database.zip` 的 `recruitment.db` 里，**部署即拥有** |
| B. WDCloud 人才库共享资产 `ka_talent_pool_files` | agent `talent-pool-agent`（"人才库"）v0.1.51（test + prod），owner `cboy@wooduan.com`；只读挂载 `/assets/talent` | 资产现只有 `profile.json` + `standard.pdf` + `origin.pdf` + catalog 分片，**不含解析补充文本**；需更新资产源并发布新版本（见 §7） |
| C. 其他下游（数据仓库 / 北森侧） | 按需 | 用 §6 的解析补全包，可确定性合并 |

WDCloud 实测（2026-10-10）：

- Center MCP 只暴露 17 个 agent/task 工具，**没有共享资产目录/发布工具**；目录与授权在 Portal（owner/admin）完成；
- `talent-pool-agent` 的任务在创建时**固定资产版本**，上游更新后必须**请求刷新 + 重跑任务**才能读到新内容。

---

## 5. 方案对比与推荐

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| **1. 直接接收解析数据（推荐）** | 交付 841 MB 解析补全包（**已生成**，见 §6），IT 合并进资产源 / 数据库 | 零模型调用、结果与本地一致、键齐全可确定性合并、体积小 | 需要一次性合并脚本与资产发布流程 | **主方案** |
| 2. IT 侧重跑解析 | 用 `parse-origin-resume-sections.mjs` + `persist-attachment-text.mjs` 重跑 | 流程自持 | 需要公司网关 Key、69.6k 人的模型调用时间与费用；结果可能与本地不一致 | 不推荐（可抽样复核） |
| 3. 只交全量 DB 包 | 直接替换 `recruitment.db`（01-database.zip，17.46 GiB） | 最简单、数据最全 | 重、需要停服替换；只适合走 0.7.0 全量部署 | 与方案 1 不冲突；部署时天然覆盖 |

**推荐落地：方案 1 为主；若 IT 同时做 0.7.0 上线，服务器侧由方案 3 自动覆盖，本包只需用于
WDCloud 资产 / 其他数据下游。**

---

## 6. 交付物：解析补全包（已生成，841 MB）

### 6.1 目录结构

```text
parsed-resume-20261010/
├─ parsed-sections.jsonl     # 每个候选人一行：大模型补全的结构化区块（69,642 行 / 484.5 MB）
├─ origin-text.jsonl         # 每个候选人一行：原始附件全文提取（69,629 行 / 356.4 MB）
├─ manifest.json             # 行数 / 人数 / 哈希 / 解析器与模型 / 生成时间
├─ README.md                 # 精简说明（合并步骤 + 校验）
└─ checksums.sha256          # 三个文件的 SHA256
```

同一目录另有 store 模式 zip：`transfer\06-parsed-resume.zip`（840.9 MB，解包得到上面的目录）。

### 6.2 字段定义

`parsed-sections.jsonl`：

```json
{
  "applicant_id": "00055af3-99b9-4c04-b862-42b08fc1fd99",
  "candidate_id": "9425f672-1171-4a30-a869-356df6a55755",
  "beisen_candidate_id": "C00146616",
  "sections": [
    {
      "section_type": "internship",
      "title": "LRY Group · 营销实习生 - 内容",
      "content": "2025.05 - 2025.9 …",
      "structured_data": { "单位名称": "LRY Group", "职位名称": "营销实习生 - 内容" },
      "sort_order": 3
    }
  ],
  "parser": { "version": "origin-section-parse-v1", "model": "deepseek/deepseek-flash" }
}
```

`origin-text.jsonl`：

```json
{
  "applicant_id": "00055af3-99b9-4c04-b862-42b08fc1fd99",
  "candidate_id": "9425f672-1171-4a30-a869-356df6a55755",
  "beisen_candidate_id": "C00146616",
  "file": "origin.pdf",
  "mime": "application/pdf",
  "chars": 1005,
  "sha256": "<原始附件 sha256，来自 candidate_attachments.sha256>",
  "text": "姓名：… 求职意向：… 教育背景 … 自我评价 …"
}
```

### 6.3 格式与体积

- 编码 UTF-8（无 BOM），一行一个 JSON，内部换行用 `\n` 转义；
- 体积（实测）：sections **484.5 MB** + origin text **356.4 MB** = **841 MB**；store 模式 zip **840.9 MB**；
- 键：`applicant_id`（WDCloud 资产目录名 / 北森 applicantId）、`candidate_id`（本地主键）、
  `beisen_candidate_id`（北森 candidateId）。

**打包边界（重要）**：只交付"源文本"（上面的 841 MB）。库内自动派生出来的数据——`candidate_resume_documents`
副本（+732.8 MB）、`search_documents_v2`（+1,754.6 MB）、两张 FTS（约 +2.2 GiB）、向量 chunk（约 +0.2–0.3 GiB），
合计约 **5–6 GiB**——**不打包给 IT**，原因：

1. 它们由源文本自动生成，IT 侧合并文本后由各自的索引流程重建即可；
2. 它们绑定本库内部结构（rowid / 触发器 / FTS 内部表），单独搬运到别的库既无意义也容易损坏；
3. WDCloud 共享资产场景（agent 直接读文件）根本不需要 FTS / 向量；
4. 若 IT 整机沿用本系统，这些派生数据已包含在 `01-database.zip`（主库 17.46 GiB）+ `02-vectors.zip`（向量 27.66 GiB）里，
   也无需为它们单独打包。

### 6.4 生成方式（本地）

```powershell
node scripts/export-parsed-resume-for-it.mjs --out D:\talent-asset-workbench\transfer\parsed-resume-20261010
```

**本次生成记录**（脚本：`scripts/export-parsed-resume-for-it.mjs`；时间：2026-10-10 16:07:12 +08:00；
纯只读导出，不写库、不调用模型）：

| 文件 | 行数 | 字节 | SHA256 |
| --- | ---: | ---: | --- |
| parsed-sections.jsonl | 69,642 | 508,079,852 | `f81c8a5885cda0b9e0e58633e7a5f17a3bd1842dc91ce754202c44008cc6edab` |
| origin-text.jsonl | 69,629 | 373,702,044 | `537de25cca20e8d17b690cc2a168b2a43a80f4e83fc71a5110a58c395b230ba1` |
| manifest.json | — | — | `5946e46ee387733f7548aedb24df96309fbf6160aa67539ef8842c621db6c585` |

manifest 计数：`sections_candidates=69,642`、`sections_rows=542,754`、`origin_text_records=69,629`、
`missing_applicant_id=0`、`invalid_structured_data=0`。

核心 SQL 口径：
> - sections：`candidate_profile_sections WHERE source_record_id LIKE 'origin-section-parse-v1:%'`
>   （字段：candidate_id / section_type / title / content / structured_data / sort_order）
> - text：`candidate_attachments WHERE extracted_text IS NOT NULL`（字段：candidate_id / original_filename /
>   mime_type / extracted_text / sha256）
> - 映射：`candidate_asset_index`（candidate_id → applicant_id）；北森编号取 `candidates.source_record_id`。

### 6.5 IT 获取步骤（在服务器上执行）

```powershell
# 1) 建立到开发机只读共享的会话（密码由交接人通过安全渠道提供）
net use \\192.168.190.58\talent-workbench /user:wd\cboy *

# 2) 取包（二选一）
copy "\\192.168.190.58\talent-workbench\transfer\06-parsed-resume.zip" D:\
# 或直接复制散文件目录
robocopy "\\192.168.190.58\talent-workbench\transfer\parsed-resume-20261010" D:\parsed-resume-20261010 /E

# 3) 校验（解包后的目录内）
Get-FileHash parsed-sections.jsonl, origin-text.jsonl, manifest.json -Algorithm SHA256
# 三个哈希应与 checksums.sha256 完全一致（见 §6.4 表格）

# 4) 对照 manifest.json：行数应为 69,642 / 69,629，缺失 applicant_id 为 0
```

> 该包**不要解到 `C:\talent-data`**：它是给人才资产 / WDCloud 共享资产 / 数据仓库用的补充数据，
> 合并方法见 §7。

---

## 7. 合并到 WDCloud 人才库资产（方案 1 的落地步骤）

1. **合并进资产源**（owner 在资产 Workspace 操作，不直接改已发布版本）：
   - 建议路径：`candidates/<2 位>/<2 位>/<applicantId>/parsed/sections.json`，
     以及 `candidates/<2 位>/<2 位>/<applicantId>/parsed/origin-text.txt`；
   - 或把解析区块并入 `profile.json` 的新增字段（如 `parsedResume.sections`），保持原有字段不动；
2. **发布新版本**：按 Shared Asset 流程 Probe/Build，产生新的 `kav_*`，等待 Ready；
3. **授权**：保持 `read`；资产为 restricted/sensitive 时由 owner/admin 在产品面授权；
4. **消费方刷新**：`talent-pool-agent` 请求资产刷新（`arf_*`）后**重跑任务**——任务创建时固定版本；
5. **验收**：真实 Test Task 读取 `parsed/` 内容成功，报告 `assetId` / `assetVersionId` / `observedAt` / 耗时。

风险与回滚：Shared Asset 版本不可变，回滚 = 消费方切回旧 `kav_*` 重新跑任务；旧版本不需要删除。

---

## 8. 验收清单（IT 侧执行）

| # | 检查项 | 通过标准 |
| --- | --- | --- |
| 1 | 包完整性 | `checksums.sha256` 校验通过；`manifest.json` 的 SHA256 与包内一致（开发机已实测，见 §6.4） |
| 2 | sections 数量 | 行数 = **69,642**，`applicant_id` 在目标资产可 100% 对上 |
| 3 | text 数量 | 行数 = **69,629**；抽样 20 份与原文件比对 |
| 4 | 内容抽样 | 抽查 20 人：区块标题/字段与原始 PDF 一致，无编造、无覆盖北森原有字段 |
| 5 | 版本证据 | 新资产 `kav_*` + `revision.json`（generationId / treeHash / entryCount）留档 |
| 6 | 消费验证 | WDCloud Test Task：无 `ASSET_*` 错误，能读到 `parsed/` 内容 |
| 7 | 检索验证（服务器侧） | 用"自我评价 / 求职意向"等关键词能命中补充文本 |
| 8 | 容量核对 | 主库预期净增 5–6 GiB（文本 + 索引）、向量约 +0.2–0.3 GiB |
| 9 | 安全 | 全流程公司内网；无 Token / 签名 URL / 物理路径写进产物 |
| 10 | 回滚演练 | 切回旧 `kav_*` / 旧数据目录后 agent 正常运行 |

### 8.1 执行后逐阶段确认（命令 + 期望结果）

**阶段 1：取包与完整性**

```powershell
net use \\192.168.190.58\talent-workbench /user:wd\cboy *
copy "\\192.168.190.58\talent-workbench\transfer\06-parsed-resume.zip" D:\
mkdir D:\parsed-resume
tar -xf D:\06-parsed-resume.zip -C D:\parsed-resume
cd D:\parsed-resume\parsed-resume-20261010

# 1) 校验和：三个 SHA256 必须与 checksums.sha256 完全一致
Get-FileHash parsed-sections.jsonl, origin-text.jsonl, manifest.json -Algorithm SHA256
#    期望：f81c8a58…c6edab / 537de25c…230ba1 / 5946e46e…db6c585（见 §6.4 表）

# 2) 行数
(Get-Content parsed-sections.jsonl -ReadCount 0).Count   # 期望 69642
(Get-Content origin-text.jsonl  -ReadCount 0).Count     # 期望 69629

# 3) 抽样 JSON 可解析
Get-Content parsed-sections.jsonl -TotalCount 3 | ForEach-Object { $_ | ConvertFrom-Json | Out-Null; "ok" }
Get-Content origin-text.jsonl  -TotalCount 3 | ForEach-Object { $_ | ConvertFrom-Json | Out-Null; "ok" }
```

**阶段 2：合并进资产源**

- 抽取 5 个 `applicant_id`，确认资产源对应目录下出现 `parsed/sections.json` / `parsed/origin-text.txt`，内容与包一致；
- 覆盖率检查：包内 69,642 个 `applicant_id` 应 100% 能在资产目录集合中找到（无新增孤儿）；
- 抽样 20 人与原件 PDF 对照：区块标题/字段一致，无编造、无覆盖北森原有字段。

**阶段 3：发布新资产版本**

- 新 `kav_*` 进入 **Ready**；留档 `revision.json` 的 `generationId` / `treeHash` / `entryCount`；
- 旧 `kav_*` 仍在（证明可回滚）。

**阶段 4：消费端验证（WDCloud 人才库）**

- 用 `talent-pool-agent` **新开一个任务**（旧任务固定在旧版本，不会热切换）；
- 提问依赖解析文本才能回答的内容（例如某候选人的自我评价 / 求职意向）；
- 成功标准：任务 `succeeded`；回答中出现解析内容；任务详情里 `assetId=ka_talent_pool_files`、
  `assetVersionId` 是新 `kav_*`、`observedAt` 为本次时间；**无** `ASSET_ACCESS_DENIED` / `ASSET_STALE` /
  `ASSET_VERSION_UNAVAILABLE` / `ASSET_BACKEND_UNAVAILABLE`。

**阶段 5（可选：仅当 IT 同时部署了工作台）**

```powershell
Invoke-RestMethod http://127.0.0.1:4173/api/health            # 期望 200
Invoke-RestMethod http://127.0.0.1:4173/api/resume-search/status
# 期望 hybrid.vector.available=true && loaded=true && current=true；degradation 不含 vector_unavailable / vector_not_ready
node scripts/self-test-api.mjs                                # 期望 32/32 通过
```

### 8.2 成功的最小闭环与失败判定

判定"这次操作成功"的最小闭环（4 条必须全满足）：

1. **校验和一致**：三个 SHA256 与 `checksums.sha256` 完全一致；
2. **数量一致**：行数 69,642 / 69,629，`missing_applicant_id=0`；
3. **版本 Ready**：新 `kav_*` 已 Ready 且有 revision 留档；
4. **消费可读**：新开的 agent 任务能读到 `parsed/` 内容且无 `ASSET_*` 错误。

任一条不满足即判失败，按下表处理：

| 现象 | 处理 |
| --- | --- |
| 校验和不一致 / 行数不符 | 重新从共享复制（不要合并半包）；报错时附 `Get-FileHash` 输出 |
| 合并后资产 Revision 未变化 | 检查是否提交到了错误的资产源分支 / 未触发 Probe-Build |
| 新版本长期非 Ready | 查资产 Build 日志（Probe/Build 阶段），不要用旧版本硬顶 |
| Agent 报 `ASSET_*` | 按 WDCloud Shared Assets 错误表处理（授权 / 版本 / Backend / freshness） |
| 需要回滚 | 切回旧 `kav_*`，让消费方**新开任务**重跑；旧版本一直保留 |

---

## 9. 安全与合规

- 候选人数据只在公司内网与公司平台内流转；导出/传输走开发机只读共享
  （`\\192.168.190.58\talent-workbench`），用完关闭共享（`scripts\setup-transfer-share.ps1 -Remove`）；
- 大模型解析只调用公司网关（`AGENT_BASE_URL`），本次交接**不再新增模型调用**；
- 解析结果含 PII：共享资产按 restricted/sensitive 授权；回答侧默认掩码标识，不做批量导出；
- 不得把 Task Token、signed URL、object key、宿主机路径、模型密钥写入回答、artifacts 或日志。

---

## 10. 参考文件

| 文件 | 用途 |
| --- | --- |
| `scripts/parse-origin-resume-sections.mjs` | 大模型补全解析（只补空缺，写 `candidate_profile_sections`） |
| `scripts/persist-attachment-text.mjs` | 原始附件全文提取落库（写 `candidate_attachments.extracted_text`） |
| `docs/ATTACHMENT_TEXT_PERSISTENCE_PLAN.md` | 附件文本落库方案与索引链路 |
| `docs/SERVER_RELEASE_HANDOVER_IT.md` | 0.7.0 全量部署交接（01-database.zip 含解析结果） |
| `docs/PROJECT_HANDOVER_IT.md` | 项目整体交接（数据清单、增量流程、运维） |
| `data/deploy/data-manifest.json` | 160.71 GiB 全量数据清单（449 条目 / 806,852 文件） |
| WDCloud `talent-pool-agent` 的 `SKILL.md` / `agent.yaml` | 人才库资产布局（`ka_talent_pool_files`、`/assets/talent`、masked ID 规则） |

