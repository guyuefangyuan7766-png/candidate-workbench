# 交接说明（给接手的 Codex）

先读这一份，再按需读下面的详细文档。本文自包含，不依赖之前的对话记录。

---

## 一、这是什么

`D:\talent-asset-workbench` 是一个**独立的人才资产工作台**，与原项目
`C:\Users\cboy\Documents\北森` 无关。它从 WDCloud 共享资产
`ka_talent_pool_files` 导入了一家游戏公司北森 iTalent 人才库的全量数据，
用于查看、检索和后续加工候选人履历。

技术栈：Node 24 + Express + SQLite（`node:sqlite`），前端 React 19 + Vite。

## 二、当前状态（2026-09-23）

### 数据规模

| 项 | 数量 |
| --- | --- |
| 候选人 | 118,918 |
| 简历附件 | 227,880（标准 118,906 + 原始 108,974） |
| 履历区块 | 827,941 |
| 面试评价 | 12,689 |
| 职位 / 申请血缘 | 1,001 / 8,064 |
| 备注 | 7,986 |
| 人才池 / 成员关系 | 56 / 181,101 |
| 资产文件索引 | 228,063 |

### 数据位置

| 内容 | 路径 | 体积 |
| --- | --- | --- |
| 主库 | `data/recruitment.db` | 13.26 GB（检索索引回填中，还会涨） |
| 简历文件 | `data/private/attachments/files/` | 约 227,880 个文件 / 47 GB |
| 导入源 | `data/asset-export/` | 347,133 个文件 / 47.88 GiB |

D 盘已用约 152 GB，剩余约 800 GB。

### 资产版本（本次导入固定）

| 项 | 值 |
| --- | --- |
| generationId | `fsgen-396a2209-9e6a-4a2c-ad2c-2db840ffe0d3` |
| treeHash | `cea815e00bfe0b23…` |
| entryCount | 356,019 |
| baseRevisionId | `wsr-e4221bd9-e965-4906-9e36-0960db29e5ce` |

### 启动方式

```powershell
cd D:\talent-asset-workbench
$env:PORT='4175'; $env:HOST='127.0.0.1'; $env:AUTH_ENABLED='false'
$env:SEARCH_VECTOR_MAINTENANCE_ENABLED='false'
node server/index.mjs
```

浏览器打开 `http://127.0.0.1:4175`。启动后会后台回填检索索引
（约 750 万文档，需要一段时间；期间列表、详情、附件都正常）。

## 三、已完成的工作

1. **全量导入**：资产里 42 个顶层键、4 类索引、228,063 个文件全部落库。
   字段落点表见 `docs/ASSET_IMPORT.md`。
2. **永久保留政策**：本地数据不设自动删除，已写入 `docs/ASSET_IMPORT.md`。
   `--reset` 现在必须显式追加 `--confirm-delete-all`，防止误抹。
3. **简历附件可见**：`attachments.js` 原先把附件类型硬编码成 `resume`，
   导致原始简历既看不到也下载不了；已改为 `IN ('resume','resume_origin')`。
4. **档案左侧内嵌简历**：详情抽屉左右分栏，左侧渲染原始简历，右侧原有页签。
   服务端新增 `GET /api/attachments/:id/content`。
5. **三阶段方案**：见 `docs/PHASE_PLAN.md`。

## 四、关键约束与坑（重要）

### 数据本身

1. **结构化履历不全**。`profile.json` 来自北森 `GetResume` 的解析结果，
   9 类区块全量全空：`skill`、`certificate`、`lang`、`internship`、`awards`、
   `train`、`writings`、`schoolCadre`、`schoolPractice`。
   实测：抽样 97 份原件正文含"实习"的档案，这 9 个区块同样全为 0。
   **完整内容只在原始简历文件里。**
2. 19,610 人（16.5%）完全没有教育/工作/项目区块；极端例子结构化仅 67 字符，
   原件 171,744 字节。
3. **原始简历的真实类型与扩展名不符**。上游一律叫 `origin.pdf`，但按魔数判定
   只有 27.8% 真是 PDF，60.6% 是 HTML。入库时已按真实类型改名
   （`origin.html` / `origin.pdf` / …）并写正确 MIME。**不要信扩展名。**
4. **证件照没有文件本体**。29.6% 的档案有 `IDPhoto`，但 100% 是
   `dfs://Resume/...` 内部路径；资产没有设计文档里说的 `additional/` 目录。
5. **面试评语几乎为空**。14,269 条评价里只有 132 条（0.9%）有叙述性正文，
   涉及 70 位候选人。其余只有 `evaluationConclusion`（码 1/2/3）和分数。

### 代码与运行

6. **全局中间件设了 `X-Frame-Options: DENY` 与 `frame-ancestors 'none'`**，
   同源也不允许内嵌。任何要 iframe 预览的路由都必须按单条响应覆盖这两个头。
7. **简历 HTML 是不可信内容**。非 PDF 的预览响应必须带
   `default-src 'none'; sandbox; frame-ancestors 'self'`，禁脚本、禁外部资源。
   简历里的外部图片显示为占位符是**预期行为**。
8. **`candidate_attachments.storage_path` 存的是绝对路径**
   （`assertInside` 用 `resolve(path)` 校验），不是文件名。
9. **附件单文件上限 15,728,640 字节**是表级 CHECK。原件里有 163 份超限，
   已改为写区块记录大小/类型/原路径，字节留在 `data/asset-export/origin/`。
10. **`talent_pools.name` 与 `positions.external_code` 都是唯一索引**。
    资产里有同名池，导入时已加 ID 后缀区分。
11. **应用不认识资产专有表**。`asset_sync_revisions`、`candidate_asset_index`、
    `asset_file_index` 由导入器自建，不进应用的 `schema_migrations` 链；
    `talent_pools` 与 `candidate_talent_pools` 的扩展列同理。
12. **附件只存档不解析**：`parse_status='pending'`、`extracted_text=''`，
    因此不写 `candidate_resume_documents`，也不进全文与向量索引。

### 操作

13. **不要跑 `scripts/import-talent-asset.mjs --reset`**，除非确实要清空
    11.9 万候选人引用与 47 GB 附件。
14. 导入或维护脚本运行时不要同时开服务写库，SQLite 会 `database is locked`。

## 五、三阶段方案（摘要）

完整方案见 `docs/PHASE_PLAN.md`。

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| 阶段 1 | 原始简历内嵌展示，档案左侧新增简历区块 | **基础版已完成**，待完善长简历滚动与移动端 |
| 阶段 2 | 把简历里的证件照同步到头像框 | **已完成（2026-09-24）**：32,258 人有头像，占 27.1%；误提已清洗，详见 `docs/PHASE_PLAN.md` |
| 阶段 3 | 用 Codex 解析原始简历，补齐缺失字段并显示 | **100 份试点已落库（2026-09-24）**：611 行 / 69 人；全量 98,333 人待跑 |

### 阶段 2 要点

- 复用应用自带的 `extractPdfAvatarCandidates` + `selectPdfAvatarCandidate`
  （`server/attachment-avatar.js`），合格条件 ≥96×96、宽高比 0.55–1.35
- 落盘后插 `candidate_attachments`（`attachment_type='avatar'`），
  设 `candidates.photo_url = 'attachment-avatar:<附件ID>'`
- **门禁**：只处理身份与证件区块里 `IDPhoto` 有值的候选人。无标记档案里
  `standard.pdf` 内嵌的是同一张 160×160 默认剪影占位图，不设门禁会大面积误提。
- 实际覆盖 27.1%（有标记人群 89.1%）；脚本 `scripts/sync-candidate-avatars.mjs`
  可重跑（幂等），`scripts/dedupe-candidate-avatars.mjs` 负责清误提

### 阶段 3 要点

- 解析通道三层：应用已有解析器（PDF/DOCX/XLSX/TXT，覆盖 29.6%）
  → 自写 HTML 文本抽取（+60.6%）→ 剩余 8.5%（DOC / 图片 / ZIP）单独评估
- 字段抽取交给 Codex，**每条字段必须带原文片段作为证据**，无证据不写
- 写库策略：**只补空缺，不覆盖北森已解析出的内容**
- 脚本 `scripts/parse-origin-resume-sections.mjs`：默认只读；`--apply` 才写库；
  `--limit/--offset` 断点续跑；`--candidate-ids` 定向补跑失败批次
- 字段口径与同义合并表见 `docs/PHASE_PLAN.md` 阶段 3；规范字段外的字段进
  `structured_data._extra`，不丢弃
- 试点实测：500 人次约 4 分钟/100 份；全量按实测吞吐外推约 2.5–3 小时
  （10 份/批 ×5 并发）。全量入口 `scripts/run-phase3-full.mjs`，每 60 秒写
  `data/phase3-full-progress.jsonl` 心跳，可随时中断后重跑续传。
- **长跑内存**：解析脚本改为「键集分页 + 分波处理」（`PHASE3_WAVE` 默认 500
  人/波），RSS 稳定在 ~150 MB；不要退回 `LIMIT ? OFFSET ?` 写法——实测那会让
  SQLite 把 9.8 万条候选集整体 materialize，8 分钟内涨到 2.9 GB 并最终 OOM。
- 失败批次补跑用 `--candidate-ids <逗号分隔的 candidateId>`（报告里
  `status=batch_failed` 的那些人）。
- **畸形 PDF 已隔离**：`scripts/extract-origin-text.mjs` 单文件独立进程提取
  （120s 超时），原生层崩溃只影响该候选人，主循环记为 `text_failed` 继续。
- **重启方式**：`node scripts/run-phase3-full.mjs`；已解析过的人会被跳过。
  进度看 `data/phase3-full-progress.jsonl`，详细统计看
  `data/phase3-full-report.json`。

### 增量同步（2026-09-24 实测）

- 入口 `scripts/incremental-sync.mjs`：`--check`（拉最新 manifest 并算差集）→
  `--download --shards N`（按分片下载简历快照，断点续跑）→ `--import`（写库）。
- **`sync.export` 的 `applicantIds` 不生效**（传 2 个 ID 仍导出整片 39,651 个档案），
  所以增量只能整份索引差集 + 分片快照，不能按人精确拉取。
- 当日实测差集：新增 41 人、指纹变化 55 人、索引消失 4 人。
- 解析环节天然增量：解析器只挑没有解析产物的人，新导入者自动入队。
- 待实测：`--download` + `--import` 尚未用真实增量跑完整链路（差集与产物下载
  已验证；导入脚本沿用首次全量导入器）。

## 六、待决策（需要人拍板）

| 事项 | 说明 |
| --- | --- |
| `evaluationConclusion` 码表 | 1 / 2 / 3 分别代表什么，拿到才能显示成人话 |
| 面试评语补全 | 走上游补接口 ⑧ 的 `evaluations/` 目录，还是直连北森 API（需 App Key/Secret） |
| 阶段 3 合规 | 模型网关是否获批用于候选人简历、留存边界、是否需要先脱敏 |
| 上游同步节奏 | 测试通道读到的 revision 与 Portal（生产）不一致，需向资产 owner 确认 |

## 七、常用命令

```powershell
# 启动服务（回环 + 无认证）
$env:PORT='4175'; $env:HOST='127.0.0.1'; $env:AUTH_ENABLED='false'; node server/index.mjs

# 构建前端
npm run build

# 小样本导入（会清库，仅用于验证）
node scripts/import-talent-asset.mjs --limit 50 --reset --confirm-delete-all

# 全量导入（约 1 小时，需先跑 sync-download 准备好 data/asset-export）
node scripts/import-talent-asset.mjs
```

增量同步与下载驱动的脚本在开发机
`C:\Users\cboy\Documents\北森\tmp\agent-export\`：
`sync-download.py`（分片下载）、`drill-incremental-diff.mjs`（指纹差集）、
`verify-full-import.mjs`（对账）。

## 八、文档地图

| 文档 | 内容 |
| --- | --- |
| `docs/HANDOFF.md` | 本文，入口 |
| `docs/PHASE_PLAN.md` | 三阶段详细方案（目标、实测依据、实施步骤、风险、验收） |
| `docs/ASSET_IMPORT.md` | 数据来源与版本、字段落点表、保留政策、风险操作、已知缺口 |

## 九、上游资产怎么更新

资产没有 delta 接口，每次都是整份快照。增量靠指纹差集：

1. 让 `talent-pool-agent` 跑一次 `sync.export`（`scope=manifest`，约 1 分钟）
2. 用 `candidate_asset_index.profile_sha256` 与新索引比对，
   得到"新增 / 变化 / 消失"三类
3. 变化的候选人再拉 `scope=profiles` 或 `scope=resumes` 分片

`sync.export` 是本次工作给 agent 新增的动作，已发布到 **test 通道 0.1.51**
（prod 仍是 0.1.48，未推进）。
