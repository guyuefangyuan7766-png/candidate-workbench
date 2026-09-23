# 人才资产导入与保留说明

本文记录本项目（人才资产工作台）的数据来源、导入范围与保留政策。它与原项目
`C:\Users\cboy\Documents\北森` 无关，是独立的一份资产副本。

## 保留政策：永久保留

**2026-09-23 决定：本项目的数据库与附件永久保留，不设自动删除。**

- 数据库 `data/recruitment.db`
- 附件 `data/private/attachments/files/`（约 227,880 个文件，47 GB）
- 导入源 `data/asset-export/`（索引 jsonl、档案、标准简历、原始简历）

项目代码里没有任何定时任务会删除已确认的候选人或附件：
`server/maintenance.js` 只维护运行锁文件；`attachments.js` 的定时器只清理
上传预览的临时区（`attachment_update_previews`）和处理显式删除任务
（`attachment_cleanup_jobs`），不触碰 `candidate_attachments` 里已确认的行。

上游设计文档提到的"旧 Revision 保留 90 天、候选人删除信号 T+1 移除"属于
**资产侧**的治理策略，与本地的永久保留决定不冲突：本地不做删除，上游将来若回收
某个 Revision，本地这份快照仍然完整。

## 危险操作

`node scripts/import-talent-asset.mjs --reset` 会清空候选人、附件引用与资产元数据。
为防止误抹掉这份副本，`--reset` 现在必须同时显式追加 `--confirm-delete-all`，
否则直接报错退出。

## 数据来源

来自 WDCloud 共享资产 `ka_talent_pool_files`（见 `talent-pool-agent`），
由上游 `talent-talent-sync` 从北森 iTalent 同步生成。本次导入固定的版本：

| 项 | 值 |
| --- | --- |
| generationId | `fsgen-396a2209-9e6a-4a2c-ad2c-2db840ffe0d3` |
| treeHash | `cea815e00bfe0b23…` |
| entryCount | 356,019 |
| baseRevisionId | `wsr-e4221bd9-e965-4906-9e36-0960db29e5ce` |

版本记录写在 `asset_sync_revisions` 表，导入时间与各表行数一并保存。

## 导入范围

资产里 42 个顶层键、4 类索引、228,063 个文件全部处理，端到端对账见下表。

| 资产数据 | 落点 | 界面位置 |
| --- | --- | --- |
| `personProfile` | `candidates` + 身份与证件区块 | 档案 / 履历 |
| `education` `workExperience` `project` | `candidate_profile_sections` | 履历 |
| `objective` | `candidate_preferences` + 求职意向区块 | 履历 |
| `attachments`（来源登记） | 简历附件（来源登记）区块 | 履历 |
| `additionalMaterials` | 附加资料与素材区块 | 履历 |
| `applications` | `positions` + `candidate_positions` + `candidate_position_sources` | 职位关联 / 高级信息 |
| `interviews` | `candidate_assessments` + 历史评估原始记录 | 历史评估 / 高级信息 |
| `comments` | `notes` + `activities` | 备注与动态 |
| `talentPoolId(s)` | `candidate_talent_pools` | 人才池分组 |
| 目录索引事实 | 来源索引区块 | 履历 |
| `standard.pdf` | `candidate_attachments`（`attachment_type='resume'`） | 履历 |
| `origin/origin.pdf` | `candidate_attachments`（`attachment_type='resume_origin'`） | 履历 |
| `catalog/files` 每行 | `asset_file_index` | 数据库 |
| `catalog/candidates` 校验字段 | `candidate_asset_index` | 数据库 |
| `_revision/revision.json` | `asset_sync_revisions` | 数据库 |
| 人才池层级与时间 | `talent_pools` 扩展列 | 数据库 |
| 池成员关系时间 | `candidate_talent_pools` 扩展列 | 数据库 |

资产里 27 个顶层键（`skill`、`certificate`、`lang`、`internship`、`awards`、
`train`、`writings`、`schoolCadre` 等）在这批数据里全量为空，属上游未同步，非本地遗漏。

## 附件处理约定

- **只存档不解析**：`parse_status='pending'`、`extracted_text=''`，因此不会写
  `candidate_resume_documents`，也不进全文/向量索引。搜索能力来自结构化区块。
- **原始简历按魔数判真实类型**：上游 `origin.pdf` 里约六成其实是 HTML，
  只有约 28% 是真 PDF。导入时按文件头判定并改名为 `origin.html` / `origin.pdf` 等，
  写入对应 MIME。
- **超出本地单文件上限（15 MB）的原件**不写附件表，改为一个区块记录大小、真实类型与原路径；
  字节仍留在 `data/asset-export/origin/`。

## 第二轮增量怎么做

资产没有 delta 接口，每次都是整份快照。增量靠指纹差集：

1. 让 agent 跑一次 `sync.export`（`scope=manifest`，约 1 分钟）拿到新的索引。
2. 用 `candidate_asset_index.profile_sha256` 与新索引逐条比对，
   差集给出"新增 / 变化 / 消失"三类。
3. 变化的人再拉 `scope=profiles` 或 `scope=resumes` 的分片。

本次导入后已演练过一次：118,918 条指纹全部一致，变化 0、新增 0、本地独有 0。

## 已知口径差异

| 项 | 索引声明 | 实际导入 | 原因 |
| --- | --- | --- | --- |
| 候选人 | 118,921 | 118,918 | 3 条缺 9 位 `candidateId`，无法与主档对齐 |
| 标准简历 | 118,917 | 118,906 | 上游声明有但盘上缺文件 |
| 原始简历 | 109,146 | 108,974 | 163 份超 15 MB 未入附件表，9 份上游缺文件 |

## 相关脚本

- `scripts/import-talent-asset.mjs`：导入器，支持 `--limit` 小样本、`--reset` 清空重来。
- 下载驱动与对账脚本在开发侧 `C:\Users\cboy\Documents\北森\tmp\agent-export\`
  （`sync-download.py`、`drill-incremental-diff.mjs`、`verify-full-import.mjs`）。

## 简历内嵌预览

候选人详情抽屉改成左右两栏：**左侧原始简历、右侧档案页签**，参考北森/字节的简历查看方式。

- 优先展示候选人自己上传的原始简历（`attachment_type='resume_origin'`），
  没有原件时退回标准简历；两者都有时用页签切换。
- 服务端 `GET /api/attachments/:id/content` 以 `inline` 方式返回文件。
  全局中间件设置了 `X-Frame-Options: DENY` 与 `frame-ancestors 'none'`，
  同源也不允许内嵌，因此该路由按单条响应覆盖为 `SAMEORIGIN` 与 `frame-ancestors 'self'`。
- **原件里六成是 HTML**，所以非 PDF 的响应额外加
  `default-src 'none'; sandbox; frame-ancestors 'self'`：禁脚本、禁外部资源。
  简历 HTML 里的外部/相对图片会被拦下显示为占位符——这是有意的安全行为，
  不是渲染故障。
- 按真实类型分别渲染：PDF 用 iframe 原生查看器、图片用 img、
  HTML 用沙箱 iframe、纯文本/JSON 取回后按 `pre` 展示、其余类型给出下载入口。

## 已知缺口（2026-09-23 实测）

这三项是**上游资产本身缺数据**，不是导入遗漏；详见 `docs/PHASE_PLAN.md` 的对应阶段。

| 缺口 | 实测结果 |
| --- | --- |
| 9 类履历区块全空 | `skill` / `certificate` / `lang` / `internship` / `awards` / `train` / `writings` / `schoolCadre` / `schoolPractice` 全量 118,918 份都是空数组；抽样 97 份原件正文含"实习"的档案，这些区块同样全为 0 |
| 结构化履历覆盖不足 | 19,610 人（16.5%）完全没有教育/工作/项目区块；极端例子郜钰结构化仅 67 字符，原件 171,744 字节 |
| 证件照没有文件本体 | 29.6% 的档案有 `IDPhoto`，但 100% 是 `dfs://` 内部路径；资产没有 `additional/` 目录，文件索引只有 `resume-standard` / `resume-origin` 两种 kind |
| 面试评语几乎没有 | 14,269 条评价里只有 **132 条（0.9%）** 有叙述性正文，涉及 **70 位候选人**；其余只有结论码（1/2/3）与分数。设计文档规定的 `evaluations/<interviewId>.json`（接口 ⑧）在资产里不存在 |
