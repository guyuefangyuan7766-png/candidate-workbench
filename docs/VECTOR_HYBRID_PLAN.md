# 人才资产工作台：向量化 + 混合检索 + 增量同步方案

> 状态：**方案，未实施**。本文全部结论来自只读调研；没有写库、建库、装依赖、改代码、起服务。
> 调研日期：2026-10-07（Asia/Shanghai）。
> 本对话唯一写入的文件就是本文。

**标记约定**

| 标记 | 含义 |
| --- | --- |
| 【实测｜D库】 | 本文对 `D:\talent-asset-workbench\data\recruitment.db` 的只读 SQL（2026-10-07） |
| 【实测｜D码】 | 本项目源码 / 脚本 / 数据产物的直接读取结果 |
| 【实测｜D文档】 | `docs/HANDOFF.md`、`docs/PHASE_PLAN.md`、`docs/ASSET_IMPORT.md` 已记录的事实 |
| 【实测｜C码】【实测｜C证据】 | 旧项目 `C:\Users\cboy\Documents\北森` 的源码与 `docs/evidence/*.json` |
| 【估算｜依据】 | 由实测值外推，括号内写外推依据 |
| 【待实测】 | 现有材料无法支撑，必须在实施阶段取得证据 |

**七项交付要求 → 章节映射**

| 要求 | 章节 |
| --- | --- |
| 1 旧项目对照表 | §2 |
| 2 全量向量化 | §3 |
| 3 混合检索设计 | §4 |
| 4 增量管道端到端 | §5 |
| 5 服务器同步与部署 | §6 |
| 6 风险与合规 | §1（数据去向与留存前置）、§7（误删/误覆盖与工程风险） |
| 7 分阶段实施计划 | §8 |

---

## 0. 一页结论

**一句话结论：本项目不需要移植旧项目的检索实现——旧项目的整套代码已经在本项目里，逐字节一致；要做的是「把数据源口径改对、把索引建出来、把开关打开、把增量接上」。**

【实测｜D码】`D:\talent-asset-workbench` 与 `C:\Users\cboy\Documents\北森` 的以下文件 SHA-256 完全一致：`server/hybrid-search.js`、`hybrid-search-service.js`、`search-vector-store.js`、`search-vector-source.js`、`search-vector-maintenance.js`、`search-vector-maintenance-service.js`、`search-embedding-cache.js`、`search-model-adapters.js`、`search-query-plan.js`、`search-data-minimization.js`、`scripts/search-vector-maintenance.mjs`、`scripts/evaluate-hybrid-search.mjs`、`scripts/benchmark-search-vector-capacity.mjs`。唯一有差异的是 `server/app.js`（本项目多了阶段 1 的 `/api/attachments/:id/content` 内嵌预览路由）。

【实测｜D码】检索链路在本项目里**已经接好**：`server/app.js:1354` 注册 `GET/POST /api/resume-search`，`server/app.js:1320` 注册 `/api/resume-search/status`，`src/components/AssistantDrawer.tsx:1455` 起是完整的检索界面（检索框、筛选、证据、分页、降级提示）。当前只是环境变量未开、索引目录不存在。

**已定档的四项决策（2026-10-07）**

| 编号 | 决策 | 直接影响 |
| --- | --- | --- |
| Q1 | **口径 B**：白名单扩 7 类 + 只保留模型解析写出的 `other` | 区块 1,056,076 行；总切片 **1,202,067**；见 §3.1 |
| Q2 | **先执行附件文本持久化（Phase A）**：69,491 份 `outcome='parsed'` 的 `resume_origin` 写回 `extracted_text`；跳过 no_content / failed；¥0、约 3 小时、全程不调模型 | 完成后附件正文立即进入 FTS；向量阶段再纳入；权威实施口径见 `docs/ATTACHMENT_TEXT_PERSISTENCE_PLAN.md` |
| Q3 | **选 B**：消失候选人只置 `candidate_asset_index.is_deleted=1`，不归档、不删除，**仍可检索** | 见 §5.2（含已知代价） |
| Q4 | **选 A**：增量导入 + 解析完成后**显式跑一次**向量维护（稳态约 20–25 秒），不加每日定时 | 见 §5.6 |

Q5 / Q6 按 C 盘项目落地（见 §10）。**服务器迁移推迟到所有功能落地并验收之后**，在此之前不往服务器传数据（见 §6）。

**三条必须先接受的事实**

1. **当前数据源口径会把 43.7% 的履历区块挡在向量索引外面。** 【实测｜D库】旧项目的 `SAFE_SECTIONS` 白名单只覆盖 `education/experience/project/internship/skill` 五类，本项目实际有 13 类区块；按现口径只有 **770,736** 行可入库，**598,462** 行（含全部 `other`、`award`、`certificate`、`campus`、`language`、`management`、`publication`、`training`）会被静默丢弃。这是必须先改的口径问题，不是性能问题。**注意 `other` 不能一刀切**：它的 87.5% 字符是导入器生成的系统区块（`来源索引` 每人一行），一刀切会把模型解析出的真实「附加信息」一起丢掉，正确做法见 §3.1。
2. **附件正文现在完全没有进入任何索引。** 【实测｜D库】227,880 份简历附件的 `parse_status` 全部是 `pending`、`extracted_text` 为空；阶段 3 抽取出的正文在子进程 stdout 里用完即弃（`scripts/extract-origin-text.mjs` 不落盘）。要做「附件全文向量化」，必须先持久化文本，那是写库改动。
3. **向量索引会把候选人正文发给外部模型网关。** 【实测｜C码】出站前只做**等长身份遮蔽**（`identity-redacted-v1`），正文本身仍会离开本机。留存、地域、是否出境目前**没有实测证据**，见 §1。

**选型速览**

| 层 | 采用 | 理由 |
| --- | --- | --- |
| 向量库 | USearch HNSW（`usearch@2.26.2`，已在本项目 `node_modules`） | 旧项目唯一有实测证据的路径；代码已在本仓库 |
| Embedding | 网关 `text-embedding-v4` / 1024 维 | 旧项目实测可用（batch 10 成功 / 11 失败）；本项目 `AGENT_BASE_URL` 同源 |
| 检索 | SQLite FTS5 BM25 + 向量 → RRF(k=60) → 远程 `qwen3-rerank`（≤50 人） | 旧项目匿名实测评测：Recall@50 1.00、MRR 1.00 |
| 增量 | 指纹差集 + 修订值增量扫描 | 旧项目稳态单轮 19–20 秒；本项目已有 `incremental-sync.mjs` / `import-incremental.mjs` |

**规模与成本速览**

| 项 | 值 |
| --- | --- |
| 待向量化切片（口径 B + 附件正文） | **1,495,649** 个【实测｜D库，按 `chunkResumeDocument` 的 600/80 规则计算】 |
| 待向量化文本量 | **273,642,181** 字符【实测｜D库】 |
| 文档构成 | 区块 1,056,076（1,083,149 切片）+ 主档 118,918（118,918）+ 附件 69,491（293,582） |
| 索引磁盘占用 | 约 **15–22 GB**（active 代际 + 缓存）【估算｜按旧项目 630,978 向量 = 6.34 GB active、2.84 GB 缓存线性外推】 |
| Embedding 费用 | **≈$7.7**（区间 $6–10）【实测｜计费探针：2.81 美分/百万字符】 |
| 首次全量构建耗时 | 约 **11–18 小时**【实测｜探针吞吐 6,739 字符/秒 @并发4；按 273,642,181 字符外推 11.3 小时，叠加波动取上限 18 小时】 |

---

## 1. 数据去向、留存与合规（先于任何向量化）

### 1.1 哪些文本会离开本机

【实测｜C码】出站只发生在三个动作上：

| 动作 | 发出去的文本 | 代码位置 | 处理 |
| --- | --- | --- | --- |
| 建索引（Embedding） | 每个切片的正文 | `server/search-vector-maintenance.js` 调用 `redactSearchText(..., { preserveLength: true })` 后再切片 | 姓名 / 手机 / 邮箱 / 链接 / 身份证 / 带标签的个人信息字段替换为 `[个人信息]`、`[电话]` 等**等长**占位符 |
| 查询理解（Planner） | 用户输入的检索词（≤500 字符） | `server/search-model-adapters.js:210`，默认 `gpt-6-astra` | 不含候选人数据；本地规则先解析出锚点，模型只补结构化计划 |
| 重排（Rerank） | 最多 50 位候选人的**本人证据片段**（每人 ≤3 条、≤1800 字符） | `server/hybrid-search.js` 的证据打包段 | 打包前**重新读取**允许出站的来源、整段脱敏、再截片；无允许材料的人不进重排 |

【实测｜C码】出站策略由 `server/search-data-minimization.js` 的 `SEARCH_TEXT_POLICY_VERSION = 'identity-redacted-v1'` 定义，是正则级遮蔽，不是字段级白名单。它**不保证**去掉简历里自由书写的公司名、项目名、薪资、评价、家庭信息。

### 1.2 发给谁

| 项 | 值 | 来源 |
| --- | --- | --- |
| 网关地址 | `AGENT_BASE_URL`（旧项目服务器实测为 `https://token.wd.com:443/v1`） | 【实测｜C证据】`docs/SERVER_DEPLOYMENT_RECORD.md` |
| 模型 | `text-embedding-v4`（Embedding）、`qwen3-rerank`（Rerank）、查询理解模型可配 | 【实测｜C码】`server/search-model-adapters.js:210-213` |
| 出站限制 | 仅 https；禁止 IP / 私网 / 元数据地址；可配 `SEARCH_MODEL_ALLOWED_HOSTS` 白名单 | 【实测｜C码】`assertAllowed()` / `resolveEndpoint()` |
| 是否出境 | **【待实测】** 网关部署地与出境属性无证据 | 旧项目交接：「费率、日志留存和训练策略未验证」 |
| 网关侧留存/训练 | **【待实测】** | 同上；上线前必须向网关 owner 取得书面答复 |

### 1.3 本地留存

| 内容 | 处置 | 依据 |
| --- | --- | --- |
| 候选人主库、附件 | **永久保留，不设自动删除**（本项目既定政策） | 【实测｜D文档】`docs/ASSET_IMPORT.md` |
| 向量代际目录 | 保留 active + previous 两代，更早的自动清理 | 【实测｜C码】`search-vector-store.js` 的 `commit()` |
| 向量目录内的 `chunks` 表 | 存的是**脱敏后的切片文本**，不是未脱敏原文 | 【实测｜C码】`search-vector-maintenance.js` 写入的是 `outbound` 文本，坐标来自原文 |
| 出站投影的原始文本 | 只存在于主库 `candidates` / `candidate_profile_sections`，索引侧不留副本 | 同上 |
| 网关侧副本 | **【待实测】** 无法从本机证明 | — |

### 1.4 能否改用本地模型

【实测｜C码】全部模型调用都走 OpenAI 兼容 HTTP 端点（`/embeddings`、`/rerank`、`/chat/completions`）。代码里**没有任何本地推理实现**，旧项目也从未验证过本地 embedding。因此：

- 「把 Embedding 换成局域网自建服务」**架构上可行**（改 `AGENT_BASE_URL` 指向自建 OpenAI 兼容服务），但**质量、维度、吞吐全部【待实测】**。
- 「完全离线」需要另备 GPU 服务器；本项目开发机与旧项目服务器都**没有独立显卡**（【实测｜C证据】`docs/DEPLOYMENT_LOCAL_SERVER.md`：「不需要独立显卡，不需要本地推理算力」）。

### 1.5 开工闸门（未满足不得开始写索引）

1. 网关 owner 书面确认：候选人简历文本可否用于 Embedding、留存多久、是否用于训练、存储地域、删除方式。
2. 确认脱敏级别是否够用（是否需要字段级白名单，而不是正则遮蔽）。
3. 确认索引正文本地落盘是否需要额外访问控制（当前主库与附件都是明文，无静态加密）。

**实测依据**

- 【实测｜C码】`server/search-data-minimization.js`、`server/search-vector-maintenance.js`、`server/hybrid-search.js` 的证据打包段、`server/search-model-adapters.js`（端点校验与 256 KiB / 2 MiB 出站上限）。
- 【实测｜C证据】`docs/PRIVACY.md` 第 118 行；`docs/SERVER_DEPLOYMENT_RECORD.md`。
- 【实测｜D库】附件 `parse_status` 分布、`extracted_text` 为空。

---

## 2. 旧项目对照表

### 2.1 向量库选型与 schema

| 项 | 旧项目做法 | 证据 |
| --- | --- | --- |
| 库 | `usearch` 2.26.2（HNSW，cosine，f32） | 【实测｜C码】`C:\Users\cboy\Documents\北森\package.json`；`server/search-vector-store.js:45` `new Index({ metric:'cos', quantization:'f32', connectivity:16, expansion_add:128, expansion_search:128 })` |
| 目录布局 | 一个「代际」目录 + 原子 `manifest.json` | 【实测｜C码】`search-vector-store.js` 的 `commit()`：先写 `generation-<uuid>/`，再 `fs.renameSync` 覆盖 `manifest.json`，并清理更老代际 |
| 数据表 | `meta` / `embeddings` / `facts` / `chunks` / `documents` / `build_seen` | 【实测｜C码】`search-vector-store.js` 的 `ensureWorking()` 建表语句 |
| 去重键 | `facts(candidate_id, content_hash)` + `embeddings(content_hash)` | 同上 |
| 空间隔离 | `embedding_space_id = model:dimensions:chunkVersion`，不匹配直接报错 | 【实测｜C码】`createVectorStore()` 的 `space` 校验 |
| 读取 | 服务侧只读 + mmap（`index.view()`），已校验代际缓存 `.verified.json` | 【实测｜C码】`loadActive()`；命中缓存时跳过全量 SHA-256 |
| 规模 | 630,978 chunks / vectors，429,630 documents | 【实测｜C证据】`docs/evidence/search-hybrid-formal-supplement-deployment.json` |
| 磁盘 | active 代际 6.34 GB（`vectors.usearch` 2.49 GB + `vectors.sqlite` 3.85 GB）；向量目录合计 15.5 GB（含 previous 与 2.84 GB 缓存） | 【实测｜C证据】`docs/DEPLOYMENT_LOCAL_SERVER.md` 第 36–40 行 |

命令（只读复核）：

```powershell
# 向量库实现与 HNSW 参数
Select-String -LiteralPath 'C:\Users\cboy\Documents\北森\server\search-vector-store.js' -Pattern 'const makeIndex|VECTOR_CHUNK_VERSION|export function chunkResumeDocument|embedding_space_id'
# 正式索引的实测规模
Select-String -LiteralPath 'C:\Users\cboy\Documents\北森\docs\DEPLOYMENT_LOCAL_SERVER.md' -Pattern 'text-embedding-v4|vectors.usearch|embedding-cache'
```

### 2.2 Embedding 模型与调用方式

| 项 | 旧项目做法 | 证据 |
| --- | --- | --- |
| 模型 / 维度 | `text-embedding-v4`，1024 维（代码允许 512/1024） | 【实测｜C码】`server/search-model-adapters.js:8` `MAX_DIMENSIONS = new Set([512,1024])`、`:212` 默认模型 |
| 端点 | `POST {AGENT_BASE_URL}/embeddings`，`encoding_format: 'float'` | 【实测｜C码】`embedTexts()` |
| 批量 | **每批 10 条**（`MAX_BATCH = 10`）；实测批量 11 会失败 | 【实测｜C码】`search-model-adapters.js:8`；【实测｜C证据】`docs/handoffs/2026-09-10-search-hybrid-next-session.md`：「`/v1/embeddings` text-embedding-v4 支持 1024/512 维、批量 10 成功 11 失败」 |
| 并发 | 维护并发默认 4，上限 8；旧项目正式回填用 8 | 【实测｜C码】`buildVectorIndex({ concurrency = 4 })`；【实测｜C证据】`build-formal-vectors.ps1` 记录「1024 维、并发 8」 |
| 超时 | 在线 5 秒 / 维护专用 30 秒 | 【实测｜C码】`embeddingTimeoutMs: Math.min(overrides.maintenance === true ? 30_000 : 5_000, ...)` |
| 重试 | 3 次指数退避（250 ms × 2ⁿ，上限 4000 ms） | 【实测｜C码】`search-vector-maintenance.js` 的 `for (let attempt = 0;; attempt++)` |
| 缓存 | `embedding-cache.sqlite`，按 `sha256(space + text)` 去重 | 【实测｜C码】`server/search-embedding-cache.js` |
| 输出校验 | 条数、index 完备性、维度、有限值逐项校验 | 【实测｜C码】`validateEmbedding()` |
| 已知失败 | run2 在约 83,800 文档处因 5 秒在线超时失败；改用维护专用 30 秒上限后 run3 成功，缓存复用 | 【实测｜C证据】`docs/handoffs/2026-09-10-search-hybrid-next-session.md` 第 3 节 |

### 2.3 混合检索实现

| 环节 | 旧项目做法 | 证据 |
| --- | --- | --- |
| 查询理解 | 模型输出 `SearchPlanV1` JSON（must / should / must_not / unresolved），本地做完整 Schema 与字符跨度校验；模型不可用回退本地规则 | 【实测｜C码】`server/search-query-plan.js`、`search-query-plan.schema.json`、`search-model-adapters.js` 的 `PLANNER_PROMPT` |
| 资格过滤 | 计划编译为固定 SQL（`compileCandidateWhere`），硬条件与排除**不由向量或重排决定** | 【实测｜C码】`hybrid-search.js:324` |
| 全文 / BM25 | 中文走 `search_documents_v2_fts`（二元/三元 gram）取 `bm25()`；非中文走 `candidate_resume_fts` | 【实测｜C码】`hybrid-search.js:866` 起的 `lexical_scores AS MATERIALIZED (SELECT sd.candidate_id, bm25(search_documents_v2_fts) ...)` |
| 本人材料投影 | 只允许「本人撰写」字段（主档 direct fields、履历区块、附件正文）；关联职位/人才库只作关系证据 | 【实测｜C码】`hybrid-search.js:31-45` 的三个 `SELF_DOCS_BRANCH_*` |
| 向量召回 | 稀疏集合（≤10,000 事实）精确点积；宽集合 ANN 400→800→1600→3200→6400，累计 ≤12,400 事实 / 12,800 来源行 | 【实测｜C码】`search-vector-store.js` 的 `searchQualifiedFacts` / `searchAnn`；`hybrid-search.js` 的 `recallValidatedVectors` |
| 融合 | **RRF，k=60**：`1/(60 + rank + 1)` 累加后排序 | 【实测｜C码】`hybrid-search.js:600` `function fuse(lexical, vector)` |
| 重排 | `POST /rerank`（`qwen3-rerank`），只对 head 前 50 人、每人 ≤3 条证据、≤1800 字符 | 【实测｜C码】`search-model-adapters.js` 的 `rerankDocuments()`；`hybrid-search.js` 重排段 |
| 降级 | 规划 / Embedding / 重排任一失败 → 保留本地排序并输出 `degradation[]`，**不假装混合成功** | 【实测｜C码】`hybrid-search.js` 的 `degradation.push({ code: 'vector_unavailable' / 'rerank_unavailable' ... })` |
| 质量实测 | 匿名 80 人 / 60 查询：Recall@50 = 1.00、Precision@10 = 0.5067、nDCG@10 = 1.00、MRR = 1.00；条件结构正确率 60/60 | 【实测｜C证据】`docs/evidence/search-service-final-anonymous-remote.json` |
| 延迟实测 | 同上：p50 7,632.72 ms、p95 14,821.83 ms、max 16,291.63 ms；22/60 查询发生降级 | 同上 |
| 容量实测 | 10 万向量 1024 维：构建 85.5 s、查询 p50 10.38 ms / p95 11.86 ms、ANN 文件 424 MB、冷启动 3.13 s；1 万向量精确过滤查询 p50 912 ms | 【实测｜C证据】`docs/evidence/search-vector-capacity.json` |

### 2.4 增量同步机制

| 环节 | 旧项目做法 | 证据 |
| --- | --- | --- |
| 上游拉取 | 无 delta 接口，整份快照 + 指纹差集（新增 / 变化 / 消失），`applicantIds` 参数实测不生效 | 【实测｜D文档】`docs/HANDOFF.md` 第五节、`docs/ASSET_IMPORT.md`「第二轮增量怎么做」 |
| 导入 | 按 `(source_system='beisen', source_record_id=应聘者ID)` 对齐，空值不清除旧值 | 【实测｜D码】`scripts/import-incremental.mjs`；【实测｜C码】`server/beisen-import.js` |
| 索引维护 | **修订值增量扫描**：先按 `candidate_resume_documents` 主键顺序读身份、`updated_at`、正文长度、归档状态（455,744 行约 7.8 s，不读正文），仅变化的文档才读正文、比内容哈希、切片、向量化 | 【实测｜C码】`server/search-vector-source.js` 的 `readSearchDocumentRevisions()`；`server/search-vector-maintenance.js` 的主循环 |
| 删除 / 归档 | 取不到正文即判定「不再可索引」，移出索引；另有 `filterExistingDocuments()` 兜底清理 | 【实测｜C码】`search-vector-maintenance.js` 的 `dropped` 分支与末段 prune 循环 |
| 调度 | **每个开机周期执行一次**（`schedule: 'boot'`），不是定时器 | 【实测｜C码】`server/search-vector-maintenance-service.js:99`；`SEARCH_VECTOR_MAINTENANCE_INTERVAL_MS` 在当前实现里**不生效** |
| 单写者 | 目录级 `.build.lock`，内含 PID，进程已死可恢复 | 【实测｜C码】`search-vector-store.js` 的 `writerLock()` |
| 稳态耗时 | 单轮 19–20 秒（chunks 不变则不发布新代际）；首次基准重建 914 秒 | 【实测｜C证据】`docs/TESTING.md` 第 116 行、`docs/OPERATIONS.md` 第 33 行 |

### 2.5 本项目现状：同一套代码，数据不同

| 项 | 本项目实测 | 与旧项目的差异与理由 |
| --- | --- | --- |
| 检索代码 | 与旧项目逐字节一致（除 `app.js`） | **无差异**——不需要移植 |
| 向量索引 | `data/search-vectors` **不存在**，无 `manifest.json` | 旧项目已发布 630,978 向量；本项目从未建过 |
| 遗留空表 | `candidate_resume_vectors` 表存在但 **0 行** | 【实测｜D码】本项目早期尝试留下的表。**方案不使用它**（BLOB 整表扫描没有 ANN，见 §3.3） |
| 可索引文档 | `candidate_resume_documents` **1,488,116** 行（主档 118,918 + 区块 1,369,198），**无附件行** | 旧项目 429,630 行（含 6 个附件）。本项目量大 3.46 倍 |
| 全文索引 | `search_documents_v2` **25,193,254** 行，checkpoint `ready`，coverage 17/17，dirty 0 | 旧项目同表 260 万量级。本项目中文 gram 索引**已就绪**，BM25 通路开箱可用 |
| 区块类型 | 13 类（含 `award`/`certificate`/`campus`/`language`/`management`/`publication`/`training`/`other`） | 旧项目白名单只认 5 类 → **必须扩表**，否则 43.7% 区块永久沉默 |
| 附件 | 227,880 份全部 `pending`，`extracted_text=''` | 旧项目正式库索引了 6 个附件；本项目附件正文**完全未入索引**，且原件类型是 `resume_origin`（旧代码只认 `resume`） |

**旧项目没有、本项目也不许假称有的能力**

- 没有加权分数融合（只有 RRF 单一算法）。
- 没有本地 / 离线 embedding 实现。
- 没有从上游按人/按增量拉取的能力（`applicantIds` 不生效，只能整片快照）。
- 没有定时维护（当前是开机一次；改定时属于新实现）。
- 没有「消失候选人」的自动处置（旧项目靠候选人归档进入 revision；本项目增量导入目前只统计不处理）。
- 没有向量索引的静态加密；没有网关侧的留存证明。

**实测依据**

- 【实测｜D码】13 个文件 SHA-256 比对（`Get-FileHash`），仅 `server/app.js` 不同。
- 【实测｜C码】`server/search-vector-store.js`、`search-vector-source.js`、`search-vector-maintenance.js`、`search-model-adapters.js`、`hybrid-search.js` 逐文件通读。
- 【实测｜C证据】`docs/evidence/search-service-final-anonymous-remote.json`、`search-vector-capacity.json`、`search-hybrid-formal-supplement-deployment.json`；`docs/DEPLOYMENT_LOCAL_SERVER.md`；`docs/handoffs/2026-09-10-search-hybrid-next-session.md`。
- 【实测｜D库】§2.5 全部计数。

---

## 3. 全量向量化方案

### 3.1 数据来源与口径

向量源由 `server/search-vector-source.js` 的 `SOURCES` 固定为三张来源表，**不是**直接读 `candidate_resume_documents`：

| 来源 | 取数条件 | 本项目行数 | 文本量 | 现状 |
| --- | --- | --- | --- | --- |
| 候选人主档 | `candidates.archived_at IS NULL` | 118,918 | 1,381,947 字符【实测｜D库】 | 可直接索引 |
| 履历区块 | `archived_at IS NULL AND sensitivity <> 'high' AND section_type IN (白名单)` | 现口径 770,736；建议口径 1,056,076 | 现口径 110,276,662；建议口径 132,060,450 字符【实测｜D库】 | **需改白名单** |
| 附件正文 | `parse_status='parsed' AND attachment_type IN ('resume','resume_origin')` | 当前 **0**；Phase A 后 **69,491** | 当前 0；Phase A 后【待实测】 | **先做 Phase A，再改过滤条件** |

**区块口径（必须先定档）**

| 口径 | 文档数 | 字符数 | 切片数 | 说明 |
| --- | --- | --- | --- | --- |
| A 现状（旧白名单） | 770,736 | 110,276,662 | 796,260 | 丢掉 598,462 行区块 |
| **B 采用（2026-10-07 定档）：扩 7 类 + 只保留模型解析的 `other`** | **1,056,076** | **132,060,450** | **1,083,149** | 纳入 `award`/`certificate`/`campus`/`language`/`management`/`publication`/`training`，并纳入 `origin-section-parse-v1` 写出的「附加信息」 |
| C 扩 7 类、`other` 全不要 | 1,019,996 | 128,401,113 | 1,046,788 | 比 B 少 36,080 行真实「附加信息」 |
| D 全量（含全部 `other`） | 1,369,198 | 157,637,295 | 1,396,360 | 多引入 313,122 行导入器生成的系统区块 |

**为什么不能一刀切排除 `other`（Q1 的量化答案）**

`other` 共 349,202 行 / 29,236,182 字符，但内部是两类完全不同的东西：

| 来源 | 行数 | 字符数 | 占比 | 典型标题 | 是否应进向量 |
| --- | --- | --- | --- | --- | --- |
| 资产导入（系统生成） | 313,122 | 25,576,845 | 87.5% | `来源索引` 118,918 行 / 15,602,768 字符（每人一行）；`身份与证件` 87,449 行 / 1,429,014 字符；`附加资料与素材` 40,977 行 / 5,608,417 字符 | **否** |
| 模型解析（简历原文） | 36,080 | 3,659,337 | 12.5% | `附加信息` 29,497 行 / 3,138,770 字符 | **是** |

不排除的理由（`来源索引` 一类必须排除）：

1. **它和候选人无关**：`来源索引` 是导入器为**每个**候选人写的一行目录事实（118,918 行），不是候选人写的内容。旧项目 `hybrid-search.js` 的投影原则就是「只有本人撰写的字段可以证明能力，快照与关系描述不进」。
2. **它会把联系方式带进出站文本**：`身份与证件` 87,449 行是姓名/性别/手机/邮箱等字段的转储。虽然 `identity-redacted-v1` 会遮蔽一部分，但这属于「本来就不该进向量」的数据。
3. **它会污染语义召回**：`other` 标题里出现 `杭州市`、`6001～8000 · 一周内`、`面议`、`我目前` 这类被切碎的期望地/薪资/到岗信息，向量化后会让「杭州」「面议」这类词吸走大量假命中。
4. **它会稀释向量空间**：`来源索引` 一类占了 `other` 的 53% 字符；全量纳入等于让 1,190 万字符的系统文本参与相似度竞争。

不全部排除的理由：`附加信息` 那 36,080 行是模型从原件里抽出的真实内容（阶段 3 已经过了内容门槛：至少 1 个有意义规范字段或 ≥3 个非重复字段），且旧项目白名单里没有对应类型——它是本项目**独有**的数据，丢了就白解析了。

**实现方式（供实施阶段参考）**：现有判断是纯 `section_type IN (...)`，需要改成组合条件，例如
`section_type IN ('education','experience','project','internship','skill','award','certificate','campus','language','management','publication','training') OR (section_type='other' AND source_record_id LIKE 'origin-section-parse-v1:%')`，
并且 `server/hybrid-search.js` 的 `self_docs` 分支要同步改成同样的条件（两处不一致会导致召回得到、证据给不出）。

【实测｜D库】13 类区块完整分布：`other` 349,209 / `skill` 235,024 / `experience` 214,929 / `project` 181,024 / `education` 118,866 / `award` 66,325 / `certificate` 56,375 / `campus` 35,511 / `language` 30,579 / `management` 26,271 / `internship` 20,893 / `publication` 17,667 / `training` 16,532。

【实测｜D库】区块来源构成：北森资产导入 **827,941** 行（全部 live，121,326,202 字符，覆盖 118,918 人）+ 模型解析 `origin-section-parse-v1` **541,264** 行（live 541,257 / archived 7，36,311,477 字符，覆盖 69,502 人）。合计 live **1,369,198**，与 `docs/PHASE_PLAN.md` 的 827,941 和 `data/phase3-final-summary.json` 的 541,257 逐项对上。

**附件正文（Q2 已定档：先做 Phase A）**

权威实施口径见 `docs/ATTACHMENT_TEXT_PERSISTENCE_PLAN.md`（2026-10-07 已批准）。与向量管道相关的要点：

| 项 | 值 | 来源 |
| --- | --- | --- |
| 处理范围 | `candidate_resume_parse_state.outcome='parsed'` 的 **69,491** 份 `resume_origin` | 【实测｜D码】`docs/ATTACHMENT_TEXT_PERSISTENCE_PLAN.md` |
| 跳过 | `no_content` 27,299 份（正文 <40 字）、`failed` 1,543 份（扫描件无文本层）、`standard.pdf`（与原件重复，v2 再评估） | 同上 |
| 落库列 | 只写 `candidate_attachments` 的 `extracted_text` / `parse_status` / `parser_version='origin-text-v1'` / `source='origin_text_persist'` / `updated_at` | 同上 |
| 吞吐 | 148 ms/份 @并发 6（60 份抽样，p50 146 ms / p95 2.2 s）→ 69,491 份约 **2.9 小时**，**¥0、不调模型** | 同上 |
| 磁盘增量 | 约 0.2–0.4 GiB | 同上 |
| 幂等 | 排除 `extracted_text <> ''` 或 `parser_version='origin-text-v1'` 的行，重跑 0 变更 | 同上 |
| 回滚 | 仅回滚本次写入的行：`UPDATE candidate_attachments SET extracted_text='', parse_status='pending', parser_version='', source='' WHERE source='origin_text_persist'` | 同上 |

**必须修正 Q2 方案文档的一处表述（实测证据）**

`docs/ATTACHMENT_TEXT_PERSISTENCE_PLAN.md` 写着「不写 `candidate_resume_documents`」。实际上**写了就会自动写**——【实测｜D库】`candidate_attachments_resume_au` 触发器对**任意** `attachment_type` 生效：

```sql
CREATE TRIGGER candidate_attachments_resume_au
    AFTER UPDATE ON candidate_attachments BEGIN
      DELETE FROM candidate_resume_documents WHERE document_id = 'attachment:' || OLD.id;
      INSERT INTO candidate_resume_documents(...)
      SELECT 'attachment:' || NEW.id, NEW.candidate_id, 'attachment', NEW.id, ...
      WHERE NEW.parse_status = 'parsed' AND NEW.extracted_text <> '';
    END
```

再由 `candidate_resume_documents_ai` 触发器写入 `candidate_resume_fts`。所以 Phase A 完成后：

1. `candidate_resume_documents` 会从 1,488,116 行增加到约 **1,557,607** 行（+69,491 条 `attachment:` 文档）；
2. `candidate_resume_fts` 同步增加同等行数；
3. 另一条链路 `search_v2_candidate_attachments_au` → `search_index_dirty_v2` → `business-search-worker.js` → `search_documents_v2` + FTS，即 **Q2 文档说的那条**。

两条链路并存不是错误，而是既有 schema 的既定行为：**`candidate_resume_documents` 是向量维护的修订骨架**（`readSearchDocumentRevisions()` 就扫这张表），没有这 69,491 行，向量管道根本发现不了附件文档。因此第 1 条不是副作用，而是**向量化的前提**，Q2 文档中「不写」的表述应按实测订正为「会自动写入，且这是必需的」。

**向量阶段要跟着改的两处过滤**

1. `server/search-vector-source.js:18`：`attachment_type='resume'` → `IN ('resume','resume_origin')`（实测标准简历仍全部 `pending`，所以实际只会进 origin）。
2. `server/hybrid-search.js:44`：同样改为 `IN ('resume','resume_origin')`，否则「召回得到、证据给不出」。

这两处与 §4.4 的改动清单是同一批，实施时必须一起提交。

### 3.2 切块策略

【实测｜C码】沿用 `chunkResumeDocument(document, { size = 600, overlap = 80 })`，切片版本号 `self-v3-600-80-redacted`：

- 固定 600 字符窗口、80 字符重叠（步长 520），按 UTF-16 码位切，代理对边界自动回退 1 字符。
- **先在整篇上做等长身份遮蔽，再按原偏移切片**——保证跨切片边界的手机号/邮箱不会漏遮蔽。
- 切片后二次清洗：空白折叠 + `trim()`，空切片丢弃（计入 `excluded_private_only_chunks`）。
- 每个切片携带：`document_id`、`candidate_id`、`source_type`、`source_id`、`title`、`field`、`start`/`end`（原文字符坐标）、`content_hash`、`source_hash`。

**本项目实测切片数**（按同一规则计算，口径 B + 附件正文）：主档 118,918 + 区块 1,083,149 + 附件 293,582 = **1,495,649**【实测｜D库】。区块平均长度仅 125 字符，绝大多数区块恰好 1 个切片；附件平均 2,018 字符，每份约 4.2 个切片。若采用口径 C（不含模型解析的 `other`），总数减少约 3.6 万。

### 3.3 Embedding 与向量库选型对比

| Embedding 选项 | 维度 | 实测状态 | 结论 |
| --- | --- | --- | --- |
| 网关 `text-embedding-v4` | 1024 / 512 | 【实测｜C证据】可用；batch 10 成功、11 失败；正式回填 630,978 切片成功 | **采用**（1024 维） |
| 同上但 512 维 | 512 | 【实测｜C证据】容量基准跑过 512 维（10 万向量构建 62.7 s、查询 p50 10.30 ms） | 备选；与 1024 维的质量差异【待实测】 |
| 其他网关模型（bge / qwen-embedding 等） | 未知 | **【待实测】** 未做过契约探测 | 不采用，除非 1024 维的成本/质量不达标 |
| 本地模型 | — | 无实现、无算力 | 不采用（见 §1.4） |

| 向量库选项 | 本项目可用性 | 实测状态 | 结论 |
| --- | --- | --- | --- |
| USearch HNSW（现有代码） | 依赖已装（`usearch@2.26.2`） | 【实测｜C证据】10 万向量查询 p50 10.38 ms；正式 630,978 向量已跑通 | **采用** |
| `candidate_resume_vectors` BLOB 表 | 表已存在但为空 | 无 ANN，只能整表扫描；【实测｜C证据】1 万向量精确过滤查询 p50 912 ms | 不采用；是否清理该空表留待实施阶段决定 |
| sqlite-vec / LanceDB / FAISS / pgvector | 未安装、未集成 | **【待实测】** | 不采用——旧项目没有证据，引入即新增依赖（本次禁止） |

### 3.4 批处理与限流

| 参数 | 取值 | 依据 |
| --- | --- | --- |
| Embedding 批大小 | **10** | 【实测｜C码】`MAX_BATCH = 10`；【实测｜C证据】批 11 失败 |
| 维护并发 | 4（默认）/ 8（旧项目正式回填用的值） | 【实测｜C码】`concurrency` 上限 8 |
| 源分页 | 每页 200 行（上限 400） | 【实测｜C码】`buildVectorIndex({ limit = 200 })` |
| 批次间让出 | 每页之间 `setImmediate`，网络调用期间不持有长事务 | 【实测｜C码】维护主循环 |
| 失败重试 | 3 次，250/500/1000 ms 退避（上限 4000 ms） | 同上 |
| 进程优先级 | 维护子进程 `BelowNormal` | 【实测｜C码】`search-vector-maintenance-service.js` |
| 在线超时 | Embedding / Rerank 5 s，Planner 30 s（旧项目服务器配 12 s） | 【实测｜C码】`search-model-adapters.js` 预算 |
| 请求 / 响应上限 | 请求 256 KiB、响应 2 MiB | 同上 |
| 单写者 | `.build.lock` + PID 存活探测 | 【实测｜C码】`writerLock()` |

### 3.5 成本与耗时测算

**已发生的解析成本（阶段 3，实测对照）**

| 指标 | 值 |
| --- | --- |
| 处理人数 / 批次数 | 65,355 人 / 35 批 |
| 落库区块 | 345,817 行 |
| 总 token | 214,642,024 |
| 配额消耗 | **$145.4586** |
| 墙钟 | 1,341.3 分钟（≈22.4 小时） |
| 折算 | ≈ **$2.23 / 千人**、≈ 3,284 token / 人 |

来源：【实测｜D码】`data/run-10000-summary.json`、`data/phase3-final-summary.json`。

**Embedding 成本（2026-10-07 计费探针已实测，门禁通过）**

| 项 | 实测值 |
| --- | --- |
| 探针文本 | 1,448,000 字符匿名合成文本（30k 冒烟 + 800k 失败批次 + 618k 生产分块），不涉及任何候选人数据 |
| 网关计数 | 84,993.6416 → 84,997.7128 分（稳定后取值）= **4.0712 分 / $0.0407** |
| 单价 | **2.81 美分 / 百万字符**（= $0.0281 / 百万字符；按 0.5 token/字符约 $0.056 / 百万 token） |
| 全量 273,642,181 字符 | **≈ $7.7**（区间 $6–10，含分词差异与未计尾批） |
| 吞吐 | 618,000 字符 / 92 秒 @并发 4 = **6,739 字符/秒** → 全量约 **11–18 小时** |
| 批次稳定性 | 600 字符分块 + 并发 4：103 批 0 失败；2,000 字符分块会触发 30 秒超时（**生产必须用 600 字符分块**） |
| 计数器特性 | **有 30–90 秒结算延迟**：短探针的前后差值不可信（曾出现 0.0267 / 2.63 / 0.46 美分每百万字符三种读数），必须等计数连续 ≥2 分钟无变化后再结算 |

报告：`data/embedding-cost-probe-600.json`（含稳定后的 after_settle）、`data/embedding-cost-smoke.json`。
**查询期成本（planner / rerank 每次检索调用）不在此次探针范围内，仍属【待实测】。**

**硬性门禁（Q2 交接给定，全量向量化前必须满足）**

1. **单价门禁：已通过（2026-10-07）** —— 上表即实测证据，全量预算按 ≈$7.7 计。
2. **覆盖范围由实测增益决定**：口径 B 只是起点。区块类别（尤其 `award`/`certificate`/`campus`/`language`/`management`/`publication`/`training` 与模型解析的 `other`）以及附件正文是否纳入，都要在同一评测集上做「含 / 不含」对照，只保留召回增益为正的部分。

| 项 | 估算 | 依据 |
| --- | --- | --- |
| 出站文本量 | ≈ 133,442,397 字符（不含附件） | 【实测｜D库】 |
| Token 量 | ≈ 6,700 万 – 1.33 亿 | 【估算｜按 0.5–1.0 token/字符；`text-embedding-v4` 实际分词比未验证】 |
| 费用 | **【待实测】** | 旧项目明确「费率未验证」；网关按模型计价的单价无公开证据 |
| 实测方法 | 先跑 1,000 切片，读取网关返回的 usage / 账单差值，再外推 | 见 §8 P2 |

**耗时估算**

| 阶段 | 估算 | 依据 |
| --- | --- | --- |
| 首次全量 Embedding | 约 **7–13 小时**（并发 8） | 【估算｜旧项目正式回填实测吞吐 1,920 文档/分钟（100 分钟 / 192,000 文档）：按切片 1,202,067÷630,978 = 1.91× 外推 ≈7.1 小时；按文档 1,488,116÷429,630 = 3.46× 外推 ≈13 小时】 |
| 首次基准重建（写入 revision） | 已含在上面；旧项目同口径基准重建耗 914 秒 | 【实测｜C证据】`docs/TESTING.md` |
| 稳态增量单轮 | 本项目略高于旧项目的 19–20 秒 | 【估算｜旧项目 45.5 万行修订扫描 7.8 秒，本项目 148.8 万行，按行数线性外推 ≈25 秒 + 变化量】 |
| 构建内存 | **【待实测】**；量级参考：旧项目 10 万向量 1024 维的采样峰值 RSS 1.22 GB | 【实测｜C证据】`docs/evidence/search-vector-capacity.json`（采样法，非严格峰值） |

### 3.6 向量存储结构（本项目将生成的目录）

```text
data/search-vectors/                     # 由 SEARCH_VECTOR_DIRECTORY 指定（当前不存在）
├── manifest.json                        # 当前 active 代际（含 sha256、向量数、空间 ID、previous_generation）
├── .verified.json                       # 上次校验过的文件指纹，避免每次启动重算几 GB 哈希
├── .build.lock                          # 单写者锁（含 PID）
├── embedding-cache.sqlite               # 可重建的内容寻址缓存（旧项目 2.84 GB @63 万向量）
└── generation-<uuid>/
    ├── vectors.usearch                  # HNSW 图（旧项目 2.49 GB @63 万向量）
    └── vectors.sqlite                   # meta/embeddings/facts/chunks/documents/build_seen
```

**实测依据**

- 【实测｜D库】§3.1 / §3.2 全部计数与切片估算 SQL。
- 【实测｜C码】`server/search-vector-source.js`、`search-vector-store.js`、`search-vector-maintenance.js`、`search-embedding-cache.js`、`search-data-minimization.js`。
- 【实测｜C证据】`docs/evidence/search-vector-capacity.json`；`docs/DEPLOYMENT_LOCAL_SERVER.md`；`docs/handoffs/2026-09-10-search-hybrid-next-session.md`。
- 【实测｜D码】`data/run-10000-summary.json`、`data/phase3-final-summary.json`、`node_modules/usearch/package.json`。

---

## 4. 混合检索设计

### 4.1 召回通路

| 通路 | 实现 | 本项目现状 |
| --- | --- | --- |
| 资格约束（硬条件） | 计划 → 固定 SQL（`compileCandidateWhere`）。`archived` 默认 **include**，需显式传参才会排除 | 可直接用；**消失候选人处理必须配合这一默认值改口径**（§5.2） |
| 稀疏召回 | 中文：`search_documents_v2_fts` + `bm25()`；非中文：`candidate_resume_fts` | 已就绪（25,193,254 行、checkpoint ready） |
| 稠密召回 | USearch ANN 400→6400（累计 ≤12,400 事实）、稀疏集合 ≤10,000 精确点积 | 需先建索引 |
| 本人材料限定 | `self_docs` 投影只取主档 direct fields、允许的区块类型、`parse_status='parsed'` 的 `resume` 附件 | **区块类型与附件类型两处白名单都要扩** |
| 关系证据 | 职位 / 人才库只作「关联关系命中」，不计入本人能力 | 可直接用 |
| 未解析自由文本 | 按本地关键词召回，命中不到就返回空，不做整库补齐 | 可直接用 |

### 4.2 融合算法

【实测｜C码】`server/hybrid-search.js:600`：

```js
function fuse(lexical, vector) {
  const scores = new Map()
  for (const list of [lexical, vector])
    [...new Set(list)].forEach((id, i) =>
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + i + 1))
    )
  return [...scores.keys()].sort((a, b) => scores.get(b) - scores.get(a) || a.localeCompare(b))
}
```

- **采用 RRF（k=60）**，不采用加权分数融合：两路分数量纲不同（BM25 越小越好、cosine 越大越好），加权需要重新标定，旧项目没有这个实现与证据。
- 融合只作用于候选人**排名**；资格条件与排除在融合之前已成定论，向量与重排**不能**把不合格的人拉回来。

### 4.3 Rerank 取舍

| 选项 | 结论 | 理由 |
| --- | --- | --- |
| 开启远程 `qwen3-rerank`（≤50 人） | **建议开启**，但可一键关闭 | 【实测｜C证据】匿名集上开启后 MRR / nDCG 均 1.00（同时也有 11/60 次重排不可用而降级） |
| 关闭重排 | 保留 RRF 排序 | 延迟会下降【待实测】；质量损失未测 |
| 本地 cross-encoder | 不采用 | 无实现、无算力、无证据 |
| 扩大重排候选数 | 不采用 | 代码上限 50 人 / 每人 ≤3 证据 / ≤1800 字符；扩大会线性放大外发文本量与延迟 |

**重要**：重排只改排序，不改资格。当候选人的证据不足以出站时，该候选人**保留本地排序位次**并标注降级（【实测｜C码】`rerank_source_scope`）。

### 4.4 查询接口改动点（server 检索链路）

| 位置 | 现状 | 需要改什么 |
| --- | --- | --- |
| `server/app.js:1354-1355` | `GET/POST /api/resume-search` 已注册，直接转 `HybridSearchService.search()` | **不用改** |
| `server/app.js:1320` | `/api/resume-search/status` 已返回 `hybrid` 与 `vector_maintenance` 状态 | **不用改**（用来做验收探针） |
| `server/search-vector-source.js:5` | `SAFE_SECTIONS` 五类白名单 | **必须改成口径 B**：扩 7 类 + `section_type='other' AND source_record_id LIKE 'origin-section-parse-v1:%'` |
| `server/search-vector-source.js:18` | 附件过滤 `attachment_type='resume'` | **必须改成** `IN ('resume','resume_origin')`（Phase A 已批准；标准简历仍全 `pending`，实际只进 origin） |
| `server/hybrid-search.js:31-45` | `SELF_DOCS_BRANCH_*` 里的区块类型列表与附件过滤 | **必须与上一行同步改**；两处不一致会导致「召回得到、证据给不出」 |
| `server/search-vector-maintenance-service.js:99` | 调度 = 开机一次 | 若要定时触发，需新增调度（新实现，非既有能力） |
| 前端 `src/components/AssistantDrawer.tsx` | 检索界面、证据、分页、降级提示齐全 | **不用改**（除文案层面的可选优化） |
| 环境变量 | `.env.example` 已列 `SEARCH_*` 全部开关 | 只需在 `.env` / `data/search-runtime.json` 填值 |

【实测｜D码】`server/index.mjs` 还会从 `data/search-runtime.json` 读取 `SEARCH_*` 白名单变量并注入进程环境；该文件当前不存在。

### 4.5 评测集与指标

**可以直接复用的现成资产**

| 资产 | 路径 | 说明 |
| --- | --- | --- |
| 匿名语料 + qrels | `tests/fixtures/anonymous-search.mjs`、`tests/fixtures/search-metrics.mjs` | 80 人合成语料、60 条查询、人工编码规则 |
| 端到端评测 | `scripts/evaluate-search-service.mjs` | 跑真实常驻服务、串行冷查询、输出 p50/p95/max |
| 组件评测 | `scripts/evaluate-hybrid-search.mjs` | 对比「仅本地检索」与「混合检索」的 Recall / Precision / nDCG / MRR |
| 宽集合容量 | `scripts/evaluate-search-wide-capacity.mjs` | 2 万候选 / 1.5 万合格的 ANN 行为 |

**建议指标与目标**

| 指标 | 定义 | 目标 | 现状依据 |
| --- | --- | --- | --- |
| Recall@10 | 前 10 结果覆盖标注正例的比例 | ≥ 0.80（业务集） | 【待实测】——旧项目只测了 Recall@50 |
| MRR | 首个正例排名倒数均值 | ≥ 0.70 | 【待实测】 |
| nDCG@10 | 分级相关性 | 记录但先不设门槛 | 【待实测】 |
| 条件正确率 | 结构化计划与预期一致的比例 | ≥ 0.95 | 【实测｜C证据】60/60（匿名） |
| 证据归属率 | 证据确实属于候选人本人的比例 | 1.00 | 【实测｜C证据】628/628 |
| p50 / p95 延迟 | 端到端 | p95 ≤ 15 s | 【实测｜C证据】7.63 s / 14.82 s（匿名 80 人） |
| 降级率 | 出现 `degradation[]` 的查询比例 | 记录并按阶段拆解 | 【实测｜C证据】22/60 |
| 向量覆盖率 | 有向量命中的查询比例 | ≥ 0.80 | 【实测｜C证据】49/60 |

**评测集必须包含业务查询**：【待实测】。匿名集只能证明链路正确，不能证明 11.9 万真实候选下的相关性。计划做法：人工写 50–100 条真实检索意图（只含岗位与技能词，不含候选人 ID），由 HR 标注 Top-20 相关性，作为回归基线（见 §8 P4）。

**实测依据**

- 【实测｜C码】`server/hybrid-search.js`（融合、召回、重排、降级）、`server/search-vector-source.js`、`server/app.js:1320/1354`、`src/components/AssistantDrawer.tsx`。
- 【实测｜C证据】`docs/evidence/search-service-final-anonymous-remote.json`、`search-hybrid-anonymous-remote.json`、`search-wide-anonymous-capacity.json`。
- 【实测｜D码】`tests/backend/hybrid-search*.test.mjs`、`scripts/evaluate-*.mjs`、`.env.example`、`server/index.mjs`。

---

## 5. 增量管道端到端

### 5.1 全链路时序

**一条命令的驱动（2026-10-08 新增）**：`node scripts/run-incremental-pipeline.mjs --apply`
按下述 [1]–[7] 顺序串起来执行；写库步骤前会先检查应用服务是否已停（`server/index.mjs` 进程），
在跑就拒绝执行并提示。预演（不带 `--apply`）只做 [1][2] 与导入 dry-run；加 `--skip-sync`
可跳过联网的 [1][2]，直接对本地已有 manifest 做 dry-run。报告落在 `data/incremental-pipeline-report.json`。

```text
[1] WDCloud 拉取        node scripts/incremental-sync.mjs --check
                        → talent-pool-agent 跑 sync.export(scope=manifest)，落 data/incremental/manifest/
                        → 与 candidate_asset_index.profile_sha256 比出 新增/变化/消失/无法定位
[2] 下载分片（可续传）   node scripts/incremental-sync.mjs --download --targeted --profiles-full
                        → 逐分片 sync.export(scope=profiles) 与 sync.export(scope=resumes,
                          includeOrigin+includeStandard)，zip 分别解压到
                          data/incremental/profiles/ 与 data/incremental/resumes/
                        → 分片口径：线上 agent 按 applicantId 排序后连续切片（2026-10-08 用
                          _meta.json 抽样反推确认；源码里的 candidateId 写法与线上不一致）。
                          applicantId 是随机 UUID，差集在片间均匀散布：片越细下载越小、任务越多。
                          档案总量只有 0.74 GB，`--profiles-full` 拉全量 32 片反而最省任务；
                          简历按 2048 片定位（约 235 片 / 约 5.5 GB，整份快照是 47 GB）
                        → data/incremental/sync-state.json 记录已完成分片（键 profiles:i/N、resumes:i/N）
[3] 增量导入（写库）     node scripts/import-incremental.mjs            # 预演，不写库
                        node scripts/import-incremental.mjs --apply     # 写库（必须先停服务）
[4] 解析 / 补字段        node scripts/run-phase3-full.mjs
                        → 只处理「没有 origin-section-parse-v1 产物」的人（天然增量）
[5] 附件文本持久化       node scripts/persist-attachment-text.mjs            # 预演
                        node scripts/persist-attachment-text.mjs --apply      # 写库（必须先停服务）
                        → 只处理 parsed 的 resume_origin；写 extracted_text + parse_status='parsed'
                        → 触发器自动补 candidate_resume_documents / candidate_resume_fts 与 search_index_dirty_v2
[6] 刷新业务索引        启动服务，让 server/business-search-worker.js 把 search_index_dirty_v2 刷空
[7] 向量化（三态）       node scripts/search-vector-maintenance.mjs --formal --database <db> --directory <vec>
                        → 修订值扫描 → 变化文档重切片 → 差量 Embedding → 原子发布新代际
                        → 前置：§3.1 的两处 attachment_type 过滤已改成 IN ('resume','resume_origin')
[8] 同步服务器           （推迟到全部功能落地并验收之后；见 §6）
[9] 检索生效             重启服务 → /api/resume-search/status 显示 vector.available=true / loaded=true / current=true
```

注：步骤 [3][4][5] 都是写库动作，必须排在**同一个停服窗口**内；[6][7] 完成后再恢复服务。

### 5.2 三态处理

| 状态 | 判定 | 现状 | 方案 |
| --- | --- | --- | --- |
| 新增 | 上游索引里有、本地 `candidate_asset_index` 与 `candidates` 都没有 | 【实测｜D码】`import-incremental.mjs` 已实现（`added`） | 无需改动；导入后按 [4] 解析 → [5] 附件文本 → [7] 向量化 顺序处理 |
| 变更 | 指纹 `profile_sha256` 与本地不同 | 【实测｜D码】已实现（`changed`）：更新主表字段、归档旧「北森来源」区块、保留模型区块、按 `sha256` 换附件 | 无需改动 |
| **消失** | 本地索引有、上游新索引里没有 | 【实测｜D码】改造前只统计 `removed` 数量、不写状态 | **已定档 B 且已落地（2026-10-08）**：`scripts/import-incremental.mjs` 在 `--apply` 时对 `removed` 逐条执行 `UPDATE candidate_asset_index SET is_deleted = 1`（`summary.removedMarked`），不写 `archived_at`、不删行、不删附件，因此**仍可检索**；重新出现在索引里的候选人由 upsert 用 `row.isDeleted` 覆盖回 0 |

**「消失的候选人」到底指什么（Q3 的解释）**

它不是「本地库里的人不见了」，而是**上游资产的下一次快照里不再出现这个 applicantId**。判定方式是把新拉到的 `asset-candidates.jsonl` 与本地 `candidate_asset_index`（118,918 行）逐条比对——本地有、新索引没有，就是消失。上游可能的原因：该应聘者在北森被删除/归档、被移出该人才库的导出范围、或档案不再满足资产导出条件；**本项目无法区分是哪一种**，因为资产只给差集，不给删除原因。

实测样例：【实测｜D码】`data/incremental/sync-state.json` 记录 2026-09-24 那次真实差集——新增 41、指纹变化 55、**消失 4**、一致 118,859。这 4 个人当时只被计数，**没有做任何标记**（今天 `candidate_asset_index.is_deleted` 仍全为 0，`candidates.archived_at` 仍全为 NULL），所以**他们现在仍在检索范围内**。当时没保存 ID（脚本只记了 `.length`），要列出具体是谁需要再跑一次 `--check`。

**消失候选人的处置（已定档：2026-10-07 选择 B）**

**B = 只标记、不归档、不删除、仍然可以检索。**

1. 写 `candidate_asset_index.is_deleted = 1`（该列已存在，当前全库为 0）。该表没有专用的「标记时间」列，是否复用 `imported_at` 或加列，留到实施阶段确认（加列属于 schema 变更，需单独批准）。
2. **不写** `candidates.archived_at`。因此向量维护**不会**把他们移出索引（`search-vector-source.js` 的来源条件是 `archived_at IS NULL`），语义检索与关键词检索都仍能命中——这正是本决策的预期行为，与本地「永久保留」政策一致。
3. 已知代价（明确记录，避免以后误判）：检索结果里**无法区分**「上游已删除/归档的人」和正常候选人，`candidate_asset_index.is_deleted=1` 是唯一线索。若将来需要过滤，可据此加一个可选条件（本次不做）。
4. 具体是谁：`import-incremental.mjs --apply` 现在会把标记过的人写进报告（`summary.details` 里 `kind='removed_marked'`，最多留 50 个 ID）。当前待处理的是 2026-09-24 那次差集里的 **4 人**（`data/incremental/manifest` + 本地索引 dry-run 实测：added 41 / changed 55 / removed 4 / same 118,859）。
5. 实施顺序要求：这是写库动作，必须在**停服窗口**内执行，且先 dry-run 输出名单再 `--apply`。
6. **绝不**执行 `--reset`、不删除候选人行、不删除附件文件。

### 5.3 幂等

| 环节 | 幂等键 | 重复执行的后果 |
| --- | --- | --- |
| 增量导入 | `(source_system='beisen', source_record_id=candidateId)` | 更新而非重复插入；区块按「归档旧北森区块 + 重新插入」重建，模型区块保留 |
| 附件替换 | `candidate_id + attachment_type` + 内容 `sha256` | 内容未变直接跳过 |
| 解析 | `candidate_resume_parse_state.candidate_id` | 已有人跳过；`--candidate-ids` 可定向重跑 |
| 向量化 | `documents.revision` + `content_hash` | 未变文档不读正文、不重切片、不重算向量 |
| Embedding 缓存 | `sha256(space + outbound_text)` | 相同文本复用缓存，不重复计费 |

### 5.4 断点续跑

| 环节 | 断点载体 | 说明 |
| --- | --- | --- |
| 分片下载 | `data/incremental/sync-state.json` 的 `downloadedShards` | 已下载且 sha256 匹配的分片跳过 |
| 解析 | `candidate_resume_parse_state` + `data/phase3-full-progress.jsonl` 心跳 | 中断后重跑 `run-phase3-full.mjs` 即续传 |
| 向量化 | **没有游标**：每轮从 `candidate_resume_documents` 主键 0 开始重扫修订值 | 已处理文档因 revision 未变被跳过，等价于续跑；失败不发布半代 |
| 单写者 | `.build.lock`（含 PID） | 进程已死可自动接管；进程存活时报 `search_vector_build_busy` |

### 5.5 失败重试

| 失败类型 | 处理 | 证据 |
| --- | --- | --- |
| Embedding 网络 / 5xx | 3 次指数退避后失败整轮；已成功的缓存保留 | 【实测｜C码】`search-vector-maintenance.js` |
| 在线 Embedding / Rerank 超时 | 该查询降级（本地 FTS + RRF 排序），不阻断 | 【实测｜C码】`degradation` 机制 |
| Planner 不可用 | 回退本地规则解析（`plan.metadata.source='rules'`） | 同上 |
| 畸形 PDF 解析崩溃 | `extract-origin-text.mjs` 单文件独立进程 + 120 s 超时，崩溃只影响该候选人 | 【实测｜D文档】`docs/HANDOFF.md` |
| 批量解析失败 | `--candidate-ids` 定向重跑；`data/parse-retry-list.jsonl` 保留重试清单 | 【实测｜D码】`data/parse-retry-list.jsonl`（2,182 行） |
| 发布失败 | 代际不切换，`manifest.json` 保持不动；错误写入 `maintenance-status.json` | 【实测｜C码】`commit()` 与 `SearchVectorMaintenanceService` |

### 5.6 触发方式

| 触发 | 现状 | 定档（2026-10-07） |
| --- | --- | --- |
| 向量维护 | **开机一次**（`schedule: 'boot'`，启动后延迟 30 秒执行，跑完不再重排） | **选 A**：增量导入 + 解析完成后**显式跑一次** `search-vector-maintenance.mjs --formal ...`，**不加**每日定时 |
| 上游拉取 | 手工执行 `incremental-sync.mjs` | 手工触发（与 A 配套）；若后续需要自动化，另行批准 |
| 解析 | 手工执行 `run-phase3-full.mjs` | 由 [1] 的差集驱动，无新人则快速退出 |
| 附件文本持久化 | 尚未实现（Phase A） | 由 [1] 的差集驱动，随新人一起跑 |
| 硬约束 | 写库脚本与服务**不能并行**（SQLite `database is locked`） | 落地时加闸门：先确认 `data/service.pid` 无存活进程再写库；见 §7 |

**「维护调度」是什么（Q4 的解释）**

它指的是**谁来触发向量索引的更新**。当前代码（与旧项目一致）只有一种触发：

- 服务启动时，`SearchVectorMaintenanceService` 会在 30 秒后 fork 一个 `BelowNormal` 优先级的子进程跑一轮维护，跑完就结束；
- 它用「开机标记」（`boot = round((now - uptime)/60s)`）保证**同一个开机周期只跑一次**——也就是说，**重启应用但不重启机器，不会再跑**；
- 配置里的 `SEARCH_VECTOR_MAINTENANCE_INTERVAL_MS=300000` 是历史遗留，**当前实现不读取它**。

后果：如果今天导入了 41 个新人、解析完、但没有重启机器，**向量索引不会更新**，新人在语义检索里查不到（关键词检索仍能查到，因为 FTS 由触发器实时维护）。所以这一步要么显式触发维护，要么定期触发。

**定档：选 A**（2026-10-07）——导入 + 解析完成后显式跑一次。落地方式**不需要新代码**：这是维护脚本本来就支持的 CLI 调用（`node scripts/search-vector-maintenance.mjs --formal --database <db> --directory <vec>`），把它串进步骤链即可：

```text
incremental-sync.mjs --check / --download
  → import-incremental.mjs --apply        （停服）
  → run-phase3-full.mjs                   （停服）
  → persist-attachment-text.mjs --apply   （停服，Phase A）
  → search-vector-maintenance.mjs --formal（稳态约 20–25 秒）
```

代价与补偿措施：没有定时兜底，**漏跑就会一直滞后**，直到下一次显式触发。因此需要在运维文档里固定一条「每周核对 `maintenance-status.json`」，把它当作人工兜底。

**实测依据**

- 【实测｜D码】`scripts/incremental-sync.mjs`、`scripts/import-incremental.mjs`、`scripts/run-phase3-full.mjs`、`scripts/extract-origin-text.mjs`、`data/incremental/sync-state.json`、`data/parse-retry-list.jsonl`。
- 【实测｜C码】`server/search-vector-source.js` 的 `readSearchDocumentRevisions()`、`search-vector-maintenance.js`、`search-vector-store.js`、`hybrid-search-service.js`。
- 【实测｜D文档】`docs/HANDOFF.md` 第五、六节；`docs/ASSET_IMPORT.md`「第二轮增量怎么做」。
- 【实测｜D库】`candidate_asset_index` 118,918 行、`is_deleted` 全 0；`candidates.archived_at` 全 NULL；`data/incremental/sync-state.json` 记录 2026-09-24 差集：新增 41 / 变化 55 / 消失 4 / 一致 118,859。

---

## 6. 服务器同步与部署

> **当前不迁移（2026-10-07 用户指令）**：在所有功能落地并验收之前，不往服务器上传任何数据。本节只做方案储备。
>
> 本节分两部分：旧项目**已经落地**的做法（可核对），以及本项目**尚未确定**的目标机与流程。

### 6.1 旧项目已落地的服务器事实（对照基线）

| 项 | 值 |
| --- | --- |
| 服务器 | `192.168.8.12`，Windows Server 2022，16 逻辑核 / 32 GB |
| 代码目录 | `C:\apps\talent-workbench` |
| 数据目录 | `C:\talent-data`（主库 38.06 GB、向量索引 12.68 GB、附件、认证库分离存放） |
| 监听 | `0.0.0.0:4173`，防火墙只放行 nginx `192.168.8.167`；nginx 终止 TLS |
| 开机自启 | 计划任务 `TalentWorkbench`，SYSTEM 账户，启动延迟 2 分钟 |
| 关键环境变量 | `DB_PATH`、`SEARCH_VECTOR_DIRECTORY`、`SEARCH_REMOTE_ENABLED=true`、`SEARCH_VECTOR_MAINTENANCE_ENABLED=true`、`AGENT_BASE_URL`、`NODE_EXTRA_CA_CERTS` |
| 维护调度 | 每个开机周期一次 |
| 已知坑 | 不能用 RDP 硬盘映射复制 `node_modules`（小文件静默丢失）→ 在服务器上 `npm ci`；PowerShell 5.1 读无 BOM 中文脚本会解析错乱 → `.ps1` 一律纯 ASCII |

来源：【实测｜C证据】`docs/SERVER_DEPLOYMENT_RECORD.md`、`docs/DEPLOYMENT_LOCAL_SERVER.md`。

### 6.2 本项目首次全量迁移（建议流程，未执行）

| 步骤 | 操作 | 通过标准 |
| --- | --- | --- |
| 1 | 停服务并确认无写库进程 | `data/service.pid` 对应进程不存在（当前 21320 已退出） |
| 2 | 备份主库文件集（`.db` + `-wal` + `-shm`）并逐文件 sha256 | 三次校验一致；`PRAGMA quick_check` 返回 `ok` |
| 3 | 复制 `data/private/attachments/files/` | 文件数与 227,880 简历 + 32,258 头像对齐【实测｜D库】 |
| 4 | 复制向量目录 | `manifest.json` + active 代际；`embedding-cache.sqlite` **可不传**（可重建，旧项目就是这么做的） |
| 5 | 服务器安装依赖 | `npm ci`（**不要**复制 `node_modules`） |
| 6 | 写入环境变量（系统级 + 用户级双份） | `/api/resume-search/status` 返回 `vector.available=true`、`loaded=true`、`current=true` |
| 7 | 校验 | `vectors` / `documents` 计数与源端 manifest 一致；`algorithm=usearch-hnsw-cos-f32` |

【待实测】主库 38,375,809,024 字节（约 35.7 GiB）+ 附件 47 GB + 向量 12–17 GB + previous 代际，目标机磁盘需 ≥200 GB；旧项目同规模的建议是数据盘 ≥512 GB NVMe。

### 6.3 增量同步方式

| 方式 | 说明 | 风险 |
| --- | --- | --- |
| 传差量主库 | 增量导入只改很小的行集，但 SQLite 单文件无法增量复制 | 只能在**服务停止**时整体复制主库（≈36 GB） |
| **推荐：在服务器就地执行** | 服务器直接跑 `incremental-sync.mjs` + `import-incremental.mjs` + 向量维护，只回传小体积清单 | 需要服务器能访问 WDCloud 插件与模型网关（后者旧项目已具备） |
| 只同步向量代际 | 把新 `generation-<uuid>/` + `manifest.json` 复制过去 | 必须**先停服务**再替换 manifest，且目录名不能冲突 |

【待实测】本项目目标服务器能否运行 `wdcloud-pluginctl.ps1`（当前脚本里写死了开发机路径 `C:/Users/cboy/.codex/plugins/cache/wdcloud-plugin/...`），以及是否有出站 443。

### 6.4 版本与回滚

| 维度 | 机制 | 回滚动作 |
| --- | --- | --- |
| 向量索引 | `manifest.json` 原子替换，保留 active + previous 两代 | 手动把 `previous_generation` 写回 `manifest.json`，重启服务 |
| Embedding 空间 | `embedding_space_id = model:dimensions:chunkVersion`（含脱敏策略版本） | 任一项变化都必须换新目录；混用会直接报 `search_vector_space_mismatch`，不会静默算错 |
| 应用代码 | 旧项目按「发布前源文件 manifest + sha256」做基线（109 个文件） | 回滚 = 用备份快照覆盖代码目录 + 重启；数据库不用动 |
| 数据库 | schema V1–V14，全部为加法迁移 | 本项目向量化**不需要新的 schema 迁移**（向量在独立目录） |
| 关停 / 启动 | 旧项目用「按 PID 停止 + SQLite WAL 恢复 + stale sentinel 回收」 | 重启后检查 `/api/health` 与 `maintenance-status.json` |

**实测依据**

- 【实测｜C证据】`docs/SERVER_DEPLOYMENT_RECORD.md`、`docs/DEPLOYMENT_LOCAL_SERVER.md`、`docs/evidence/search-hybrid-formal-supplement-deployment.json`（含 `vector_maintenance`、`hybrid.vector` 的启动后状态）。
- 【实测｜C码】`search-vector-store.js` 的 `commit()`（原子发布 + 代际清理 + verification 文件）。
- 【实测｜D库】`schema_migrations` 为 1–14；`data/search-vectors` 不存在；`data/service.pid` = 21320 且该进程不存在。

---

## 7. 风险与防误删 / 误覆盖

### 7.1 误删 / 误覆盖清单（本项目特有：这里还有 47 GB 不可再生附件）

| 风险 | 触发条件 | 现有防护 | 需要的额外措施 |
| --- | --- | --- | --- |
| 清空全库 | `node scripts/import-talent-asset.mjs --reset` | 需显式追加 `--confirm-delete-all`（【实测｜D文档】`docs/ASSET_IMPORT.md`） | **任何自动化脚本里禁止出现 `--reset`**；列入变更评审黑名单 |
| 覆盖模型解析区块 | 重新跑北森导入 | `import-incremental.mjs` 只归档 `source_record_id NOT LIKE 'origin-section-parse-v1:%'` 的区块 | 保持该条件；实施时用 SQL 断言模型区块数不下降 |
| 覆盖候选人主表字段 | 增量导入写入 | 按 ID 对齐并逐字段更新（**非空即覆盖**） | 实施前对 41 新增 + 55 变化的样本做 dry-run 对比 |
| 附件被替换 / 删除 | 内容 sha256 变化时删旧文件 | 先查 `countByPath`，还有引用才保留 | 迁移前对附件目录做独立备份 |
| 向量代际污染 | 用错维度 / 模型 / 切片版本 | `embedding_space_id` 强校验 | 每个新空间用**新目录**，不复用 |
| 维护与服务并发写库 | 同时跑导入脚本与服务 | 无自动互斥，靠人工 | 落地时加闸门：先检查 `service.pid` 与 sentinel |
| 关停窗口过长 | 36 GB 主库复制 | — | 首次迁移安排在低峰并停服务 |
| 索引正文旁路泄漏 | 向量目录内含脱敏后的候选人正文 | 无静态加密 | 目录纳入与主库同级的访问控制与加密策略 |
| 把「消失标记」误做成归档/删除 | 实施者按旧建议直接写 `candidates.archived_at`，导致候选人从检索中消失 | Q3 已定档为「只标记 `is_deleted`」 | 任何对 `archived_at` 的写入都必须重新批准；实施前对照 §5.2 |
| 成本失控 | 未做计费探针就全量向量化 | Q2 交接已设硬门禁 | §3.5 门禁：1–2 百万 tokens 探针实测单价前不得开始 P3 |
| business-search worker 不收敛（2026-10-07 实测） | dirty 清零后 checkpoint 停在 `indexing` → worker 判定「回填被中断」→ 重新排队整库约 190 万行，形成约 50 分钟一轮的循环 | 本次已用 `flushBusinessSearchDirty()` + `getBusinessSearchCoverage()` 在停服状态手动收敛到 `ready`（140/140 字段） | 单独修 worker 收敛逻辑；**向量维护是独立调度，不受影响**，但 §5.1 步骤 [6] 之后必须确认 `checkpoint=ready` 再进入 [7] |

### 7.2 质量与工程风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 模型幻觉 | 检索不生成内容；但查询理解可能误解析条件 | 本地 Schema / 跨度 / 布尔校验；`unresolved` 不静默硬过滤 |
| 语义召回把「相关」当「合格」 | 向量只影响排序，资格 SQL 先定 | 保持执行顺序，不把 must 条件交给向量 |
| 关系证据冒充本人能力 | 关联职位 / 人才库文本可能高分 | `self_docs` 只允许本人材料；关系证据标 `ownership='related'` |
| 出站泄漏 | 正则脱敏不是字段级白名单 | 重排前二次读取 + 整段脱敏；上线前人工抽检 20 条真实打包文本 |
| 降级被当作成功 | 旧项目 22/60 查询曾降级 | 接口已返回 `degradation[]` 与 `completeness`；验收统计降级率 |
| 磁盘 / 内存 | 主库 36 GB + 附件 47 GB + 向量 12–17 GB + 备份 | 迁移前核算剩余空间；构建避开业务时段 |
| `other` 区块污染 | 「来源索引」「投递时间」等门户痕迹 | 建议不进向量（§3.1）；如要纳入必须先过内容门槛 |
| 本项目特有规模 | `search_documents_v2` 2,519 万行（旧项目约 260 万） | 上线前实测 FTS 查询延迟（M8） |

**实测依据**

- 【实测｜D码】`scripts/import-talent-asset.mjs` 的 `--reset` 守卫、`scripts/import-incremental.mjs` 的归档条件、`data/SHUTDOWN-PENDING` 闸门样例、`data/service.pid`。
- 【实测｜C码】`hybrid-search.js` 的证据归属与降级逻辑、`search-data-minimization.js`。
- 【实测｜C证据】`docs/DEPLOYMENT_LOCAL_SERVER.md` 的容量与硬件结论。
- 【实测｜D库】附件 227,880 份全部 `pending`；主库 38,375,809,024 字节；WAL 206,943,512 字节。

---

## 8. 分阶段实施计划（每步给出可验证完成标准）

> 命令假定在 `D:\talent-asset-workbench` 执行；涉及写库的步骤**必须先停服务**。

### P0 合规与授权（无命令，人工）

| 项 | 状态 | 完成标准 |
| --- | --- | --- |
| 网关文本使用授权 | 待办 | 取得书面答复：可否 Embedding 候选人简历、留存期限、是否训练、存储地域 |
| 脱敏级别确认 | 待办 | 确认 `identity-redacted-v1` 是否足够，或改为字段级白名单 |
| 附件正文方案 | **已定档** | 先执行 Phase A（`docs/ATTACHMENT_TEXT_PERSISTENCE_PLAN.md`），无需再决策 |
| 消失候选人处置 | **已定档 B** | 只标记 `is_deleted`、不归档、仍可检索（§5.2），无需再决策 |
| 业务评测集责任人 | 待办 | 确认 50–100 条业务查询由谁编写、HR Top-20 标注由谁执行（§4.5） |

### P1 只读对账与口径定档

对下列只读查询，期望结果为 `current_whitelist = 770736`、`extended = 1019996`、`model_other = 36080`、`all_live = 1369198`（前两项对应口径 C，后两项用于确认口径 B 的增量）：

```sql
SELECT
  sum(CASE WHEN section_type IN ('education','experience','project','internship','skill') THEN 1 ELSE 0 END) AS current_whitelist,
  sum(CASE WHEN section_type IN ('education','experience','project','internship','skill','award','certificate','campus','language','management','publication','training') THEN 1 ELSE 0 END) AS extended,
  sum(CASE WHEN section_type = 'other' AND source_record_id LIKE 'origin-section-parse-v1:%' THEN 1 ELSE 0 END) AS model_other,
  count(*) AS all_live
FROM candidate_profile_sections WHERE archived_at IS NULL;
```

完成标准：四个数与本文一致；确认「口径 B」= 前两项之和 + `model_other`。证据落到 `docs/evidence/`（实施阶段新建文件）。

### P2 匿名小样本跑通（不碰真实数据）

```powershell
node scripts/search-vector-maintenance.mjs --anonymous true --database <anonymous.db> --directory <tmpdir>
```

| 完成标准 | 证据 |
| --- | --- |
| `manifest.json` 生成，`maintenance-status.json` 为 `state=ready` | 目录内容 |
| 匿名语料下 `search()` 能返回结果，`completeness.ranking` 为 `rrf` 或 `fts` | 评测脚本输出 |
| 记录构建耗时与 RSS 峰值 | 校正 §3.5 的内存/耗时估算（M3） |

**计费探针（硬门禁，必须先于任何全量向量化）**

| 完成标准 | 证据 |
| --- | --- |
| 用**匿名合成文本**（禁止真实候选人正文）构造 1–2 百万 tokens 的探针集，调用 `/embeddings` | 探针脚本与输入摘要 |
| 探针前后读取网关 billing / 配额，算出**每 token 单价** | 前后配额快照差值（补上 §3.5 的 M1） |
| 用单价外推全量 1,202,067 切片（+附件）的费用，写进本节并交用户确认 | 估算表 |

**在单价实测通过前，P3 不得开始。**

### P2A 附件文本持久化（Phase A，已批准，独立执行）

权威口径：`docs/ATTACHMENT_TEXT_PERSISTENCE_PLAN.md`。执行顺序：`--limit 200`（dry-run）→ `--limit 2000 --apply` → 全量后台（约 3 小时）。

| 完成标准 | 证据 |
| --- | --- |
| 落库计数 ≥69,000 | `SELECT COUNT(*) FROM candidate_attachments WHERE source='origin_text_persist' AND parse_status='parsed' AND extracted_text<>''` |
| 随机 20 份与原件比对（字符数、关键片段可读） | 人工核对记录 |
| 随机 5 条关键词 `MATCH` 命中附件原文 | `search_documents_v2_fts` 查询结果 |
| 重跑脚本第二次 0 变更（幂等） | 第二次执行报告 |
| 主库增量 0.2–0.4 GiB | 前后文件大小 |
| **补充校验（本文新增）**：`candidate_resume_documents` 增加约 69,491 行 `source_type='attachment'` | `SELECT source_type, count(*) FROM candidate_resume_documents GROUP BY 1` |
| 回滚预案就绪 | `data/persist-attachment-text-ids.json` + 回滚 SQL |

### P3 全量向量化（正式数据）

前置：P0 批准、P1 定档、**P2 计费探针已实测出单价（硬门禁）**、P2A 附件文本已持久化、服务已停、白名单与附件过滤的改动已通过既有测试（`node --test --test-concurrency=1 tests/backend/hybrid-search.test.mjs tests/backend/search-vector-lifecycle.test.mjs tests/backend/search-formal-maintenance.test.mjs`）。

```powershell
node scripts/search-vector-maintenance.mjs --formal --database "D:\talent-asset-workbench\data\recruitment.db" --directory "D:\talent-asset-workbench\data\search-vectors" --dimensions 1024 --concurrency 4
```

| 检查 | 期望 |
| --- | --- |
| `manifest.json.vectors` | ≈ **1,495,649**（口径 B + 附件；±1%） |
| `manifest.json.documents` | ≈ **1,244,485** |
| `embedding_space_id` | `text-embedding-v4:1024:self-v3-600-80-redacted` |
| `maintenance-status.json` | `state=ready`、`retries=0`、`removed_documents=0` |
| 磁盘新增 | 约 15–22 GB【估算】 |
| 重跑同一条命令 | `updated_documents=0`、`embedded_chunks=0`（幂等） |

### P4 开启检索并评测

```powershell
$env:SEARCH_REMOTE_ENABLED='true'
$env:SEARCH_VECTOR_DIRECTORY='D:\talent-asset-workbench\data\search-vectors'
node server/index.mjs

Invoke-RestMethod http://127.0.0.1:4173/api/resume-search/status
node scripts/evaluate-search-service.mjs --output-name=search-service-dtalent-anonymous.json
```

| 完成标准 | 期望 |
| --- | --- |
| 状态探针 | `hybrid.vector.available=true`、`loaded=true`、`current=true`，`chunks` 与 manifest 一致 |
| 匿名回归 | Recall@50 ≥ 0.90、MRR ≥ 0.90、条件正确率 ≥ 0.95；p95 记录但不设硬门槛 |
| 业务查询评测 | 50–100 条真实检索意图 + HR 标注 Top-20：Recall@10 ≥ 0.80、MRR ≥ 0.70 |
| 降级率 | 按 planning / embedding / rerank 分阶段统计并留档 |
| 出站抽检 | 人工检查 20 条真实重排请求的打包文本，确认无手机号 / 邮箱 / 身份证 |

### P5 增量三态与调度

**实现状态（2026-10-08）**：三态代码已落地——`import-incremental.mjs --apply` 会对 `removed`
置 `is_deleted=1`；新增驱动脚本 `scripts/run-incremental-pipeline.mjs` 把「拉取 → 下载 → 导入 →
解析 → 附件文本 → 向量维护」串成一条命令并带停服闸门；契约测试
`tests/backend/incremental-pipeline-contract.test.mjs` 锁定顺序与"只标记不归档"。
**以下完成标准里除「调度」外仍待用真实差集实测**（当前待处理：added 41 / changed 55 / removed 4）。

| 完成标准 | 证据 |
| --- | --- |
| 消失候选人被标记、**仍可检索** | 构造 1 个消失样本：`candidate_asset_index.is_deleted=1`、`candidates.archived_at` **仍为空**、维护后 `documents` 数**不变**、该人仍能被 `/api/resume-search` 命中 |
| 新增候选人可检索 | 导入 → 解析 → 维护 → `/api/resume-search` 命中 |
| 变更候选人证据刷新 | 改一条区块内容 → 维护后 `updated_documents=1`、chunk 内容变更 |
| 断点续跑 | 中断维护进程后重跑，计数一致，无重复向量 |
| 调度 | 按定档 A 串成命令链（导入 → 解析 → 附件文本 → 向量维护）并写入运维文档；每周核对 `maintenance-status.json` 的人工兜底被执行 |

### P6 服务器迁移与回滚演练

| 完成标准 | 证据 |
| --- | --- |
| 全量迁移 | 目标机 `/api/resume-search/status` 与源端计数一致 |
| 向量回滚演练 | 把 `manifest.json` 指回 `previous_generation`，重启后状态仍可用，`generation` 为上一代 |
| 代码回滚演练 | 用备份快照覆盖代码目录，服务可启动、数据不变 |
| 备份验证 | 主库文件集 sha256 一致 + `PRAGMA quick_check` 为 `ok` |

---

## 9. 待实测清单（汇总）

| 编号 | 事项 | 阻塞的阶段 |
| --- | --- | --- |
| M1 | ~~Embedding 单价与 token 口径~~ **已实测（2026-10-07）**：2.81 美分/百万字符，全量 ≈$7.7 | 已解除 |
| M2 | 网关侧日志留存、训练使用、存储地域、出境属性 | P0 |
| M3 | 吞吐已实测（6,739 字符/秒 @并发4 → 全量约 11–18 小时）；**RSS 峰值仍待实测** | P3 |
| M4 | 附件正文的**总字符数与切片数**（吞吐已实测：148 ms/份 @并发6 → 69,491 份约 2.9 小时） | P3 向量化范围 |
| M5 | ~~真实业务查询基线~~ **已实测（2026-10-08，见 §12）**：43 条真实查询 / P@10 0.958 / MRR 0.987 / p95 67 s / 504 率 11.6%；qrels 为"材料含词"口径，非 HR 主观相关性 | 已解除（**延迟与 504 仍未达标，待优化**） |
| M6 | 本项目目标服务器与网络可达性（WDCloud 插件、出站 443） | P6 |
| M7 | 512 维 vs 1024 维的质量 / 成本对比 | 可选优化 |
| M8 | `search_documents_v2`（2,519 万行）在本库规模下的 FTS 查询延迟 | P4 |

---

## 10. 决策记录（Q1–Q6）与遗留问题

| 编号 | 问题 | 备选 | 本次答复（2026-10-07） |
| --- | --- | --- | --- |
| Q1 | 区块白名单口径 | A 口径 B：扩 7 类 + 只保留模型解析的 `other`／B 口径 C：`other` 全不要／C 口径 D：`other` 全要 | **已定档 A（口径 B）**：1,202,067 切片；见 §3.1 |
| Q2 | 附件正文是否持久化并索引 | A v1 不做／B 持久化后一起索引 | **已定档**：先执行 Phase A（69,491 份 parsed 原件，¥0、约 3 小时），向量阶段再纳入；权威口径 `docs/ATTACHMENT_TEXT_PERSISTENCE_PLAN.md` |
| Q3 | 消失候选人如何处置 | A 归档 `archived_at` + 检索排除／B 只标记 `is_deleted`，仍可检索 | **已定档 B**：只标记、不归档、不删除、仍可检索；见 §5.2 |
| Q4 | 维护调度用什么触发 | A 事件驱动／B 每日定时／C 两者组合 | **已定档 A**：导入 + 解析后显式跑一次，不加定时；见 §5.6 |
| Q5 | 是否允许把候选人简历正文发给网关做 Embedding | 需要网关 owner + 信息安全书面答复 | **参考 C 盘项目**：沿用同一网关与同一 `identity-redacted-v1` 脱敏，正式材料只用于索引维护，评测 / 截图一律匿名 |
| Q6 | 目标服务器与迁移窗口 | 需 IT 确认 | **参考 C 盘项目**：沿用其落地模式（代码与数据目录分离、计划任务自启、nginx 终止 TLS、环境变量 Machine+User 双份、服务器上 `npm ci`）；具体机器与窗口仍待 IT 排期 |

**Q5 按 C 盘项目落地意味着什么（避免误读）**

旧项目的实际做法（【实测｜C证据】`docs/handoffs/2026-09-10-search-hybrid-next-session.md`、`docs/PRIVACY.md`）是：经用户授权后，把**脱敏后的正式材料**发给公司网关 `token.wd.com` 建向量；同时守住三条纪律——①正式材料只用于已授权的索引维护；②评测、浏览器截图、测试 fixture 一律用匿名数据；③不输出密钥、网关地址、真实姓名、联系方式或简历正文。**仍未验证**的是网关侧的费率、日志留存与训练策略；「参考 C 盘项目」不改变这三项属于【待实测】的事实，建议补一份书面确认存档。

---

## 11. 实施结果（2026-10-08）

**结论：全量向量索引已建成并发布，检索功能可用；但有一类宽泛查询超出 30 秒预算，尚未收口。**

### 11.1 实际规模与成本

| 项 | 实测值 |
| --- | --- |
| generation | `generation-2e6f601e-406c-430b-acfc-7e7ccbc37392`（`previous_generation: null`，首个正式代际） |
| documents / chunks / **vectors** | 1,244,485 / 1,470,205 / **1,454,325** |
| 索引文件 | `vectors.usearch` **2.98 GB**（f16）+ `vectors.sqlite` ≈ 7.8 GB；向量目录合计 **16.82 GB**（含 6.06 GB 可重建的 embedding 缓存） |
| embedding_space_id | `text-embedding-v4:1024:self-v3-600-80-redacted` |
| 最终一轮耗时 | 64.2 分钟（索引重建，0 次新 embedding、0 重试——全部命中缓存） |
| 峰值内存（f16） | 3.39 GB（f32 同规模约 6.7 GB） |
| **embedding 实际花费** | **≈$1.35**（网关累计用量 84,997.7128 → 85,133.0044 分；探针基线之前不计）。比 §3.5 的 $7.7 外推低 5.7 倍——探针用合成文本，token/字符比高于真实简历 |

### 11.2 关键偏差：量化由 f32 改为 **f16**（必需，非优化）

原方案沿用旧项目的 `f32`。实际发布连续两次失败，报 `search_vector_corrupt`；诊断文件
`data/search-vectors/publication-check.json` 给出真因：

```
TypeError: File is corrupted: vectors matrix exceeds file size
```

**根因（usearch 2.26.2 Windows 缺陷）**：`include/usearch/index.hpp` 的只读 mmap 用 32 位 API

```cpp
std::size_t file_length = GetFileSize(file_handle, 0);   // 文件 ≥4 GiB 返回错误长度
```

1,454,325 × 1024 × 4 B = 5.55 GiB，索引约 6.2 GB > 4 GiB → 只映射一部分 → 校验/加载必然失败。
旧项目的 2.49 GB 索引小于 4 GiB，所以从未暴露。

**影响面**：查询期读取走的是同一条 mmap 路径（`memoryMap: true`），因此**不改就永远读不起**。
改为 `f16` 后索引 2.98 GB < 4 GiB，读写都正常；代价是半精度存储（单位向量相对误差 ~1e-3，对召回可忽略），
收益是读取内存减半。相关改动：`server/search-vector-store.js` 的 `makeIndex`、发布校验子进程、
`status().algorithm = usearch-hnsw-cos-f16`。

**若将来条目数增长到 f16 也超过 4 GiB（约 200 万向量），必须换库、降维或分片**，不能再靠调参绕过。

### 11.3 检索实测（本地 02:01–02:04，正式数据）

| 查询 | 结果 | 耗时 | 说明 |
| --- | --- | --- | --- |
| 数值策划 | 200，5 条，total 827 | 16.2 s | `hybrid_reranked`，无降级 |
| 游戏测试 | 200，5 条，total 4,048 | 39.9 s | 含 worker 冷启动；`hybrid_reranked`，无降级 |
| Unity 客户端开发 | 冷启动 **504** → 热态 200，5 条，total 1,069 | 30.1 s → 23.7 s | 冷启动那次超预算 |
| Python 服务端开发 | **504**（冷、热各一次） | 30.0 s | 稳定超出 30 s 查询预算 |

**未收口项**：`Python 服务端开发` 这类高频宽泛词会打满 30 秒预算（`HybridSearchService.requestTimeoutMs` 默认 30 s）。
候选处置：①把查询预算提到 60 s（需改 `server/app.js` 构造参数或加环境变量）；②优化宽泛词的资格过滤/FTS 过采样（更根本）。
**在此之前不宜把「检索已验收」写入对外结论。**

### 11.4 与 C 盘项目的对照结论（2026-10-08 补）

同一份代码，为什么旧项目正式环境没暴露这些慢查询？逐项对照后，**决定性差异是查询理解用的模型**：

| 项 | C 盘项目（正式） | 本项目（改前） | 影响 |
| --- | --- | --- | --- |
| 查询理解模型 | `qwen3.8-flash` + `reasoning_effort=none`（【实测｜C证据】`docs/evidence/search-service-final-anonymous-remote.json` 的 `models.planner`；`.env.example` 同值） | 代码默认 `gpt-6-astra` + `low`（未设环境变量） | **单次规划 10–18 s → 1–3 s**，是超时的主因 |
| 单次检索预算 | 0.2.0 时代 18 s；当前代码上限 30 s | 30 s（超时后返回 504） | 预算不足 |
| 全业务 FTS 行数 | **2,629,388**（【实测｜C证据】`docs/OPERATIONS.md`） | **25,270,021**（9.6×；区块 1,333 万 + 来源记录 737 万 + 附件 216 万 + 主档 156 万） | 本地检索段 15–16 s（C 的正式环境是 5–20 s 总时长） |
| 宿主资源 | 32 GB 内存 / NVMe（`docs/DEPLOYMENT_LOCAL_SERVER.md`） | 15.8 GB 内存 | 页缓存不足会放大冷查询抖动（实测一次 75 s） |

**索引为什么比 C 大 9.6 倍**（策略文件 `server/business-search.js` 两边**完全一致**，差异全在数据）：它把"任何标量列与 JSON 叶子"都索引了，而本项目的导入数据在元数据上格外大——
`candidate_profile_sections.source_record_id / sort_order / section_type` **各 137 万行**、
`structured_data.source / parser / entry_index / evidence` 各 54 万行、
`candidate_source_records.source_system / source_record_id / source_name / record_type` 各 11.9 万行、
`candidate_attachments.sha256 / parse_status / parser_version / source / mime_type` 各 26 万行。
这些字段**没有人会检索**，却占了索引的绝大部分。

**已落地的处置（2026-10-08）**

1. `SEARCH_QUERY_MODEL=qwen3.8-flash`、`SEARCH_QUERY_REASONING_EFFORT=none`、`SEARCH_QUERY_TIMEOUT_MS=12000`（对齐 C 的正式配置）。
2. 查询预算：`SEARCH_QUERY_BUDGET_MS=60000`；`HybridSearchService` 上限由 30 s 放宽到 120 s（仍是显式有界），`server/index.mjs` 的 `search-runtime.json` 白名单补上该变量。
3. **配置已持久化到 `data/search-runtime.json`**（应用启动时自动加载，不需要每次传环境变量）。
4. 实测：`server/business-search.js` 未改动，未重建索引。

**复测（本地 2026-10-08 09:57，正式数据，4/4 通过）**

| 查询 | HTTP | 条数 / total | ranking | 降级 | 耗时 |
| --- | --- | --- | --- | --- | --- |
| Unity 客户端开发 | 200 | 5 / 1,069 | hybrid_reranked | 无 | 32.6 s（独立复测 12.0 s） |
| 数值策划 | 200 | 5 / 827 | hybrid_reranked | 无 | 8.9 s |
| Python 服务端开发 | 200 | 5 / 2,095 | hybrid_reranked | 无 | 23.2 s |
| 游戏测试 | 200 | 5 / 4,048 | hybrid_reranked | 无 | 15.8 s |

**已落地（2026-10-08 晚）**：把 `search_documents_v2` 收缩到"会被检索的字段"——
排除上列元数据列与 `structured_data` / `raw_payload` 的 JSON 叶子，索引预计从 2,527 万行降到 **约 400–600 万行**，
本地检索段（当前 15–16 s）应同比下降；代价是要重建一次全业务索引（数小时，纯本地、无模型费用），
且 Agent 的全字段检索将不再覆盖被排除的快照字段——需要产品确认后再做。

**实际结果（同日）**：`server/business-search.js` 新增 `UNINDEXED_SEARCH_COLUMNS`（排除
`source_record_id`/`sort_order`/`section_type`/`sha256`/`parse_status`/`parser_version`/
`source_system`/`source_name`/`record_type`/`source`/`mime_type` 与 `structured_data.*`、`raw_payload.*`；
`candidate_source_records` 因所有列都被排除而整表 `searchable:false`）。

- 文档：**25,326,858 → 5,560,867**（22%），FTS 同步 5,560,867；
- 覆盖：表级全 ready、字段 121/121 ready，`checkpoint=ready`、`dirty=0`；
- 主库：39.8 GiB → **17.46 GiB**（`VACUUM`，freelist 归零）；
- 用时：复制式收缩 42.7 分钟（含 4 份新文档补写），VACUUM 12.5 分钟；
- 脚本：`scripts/shrink-business-search.mjs`（保留行 + 集合式重建 FTS）、
  `scripts/rebuild-business-search.mjs`（丢表整库重建）、`scripts/vacuum-database.mjs`。
- 同批修复：`business-search-worker.js` 显式 `allowBackfill:false`，`synchronizeBusinessSearch`
  在"有文档 + 无 dirty + 覆盖通过"时自愈到 `ready` 并清空陈旧队列（原"约 50 分钟一轮"的循环根因），
  契约测试见 `tests/backend/business-search-v8.test.mjs`。

---

## 12. 真实业务查询评测（2026-10-08 实测）

**脚本**：`scripts/evaluate-business-search.mjs`（默认预演，`--run` 才打接口）
**产物**：`docs/evidence/search-business-eval.json`（仅 ID 与指标）+ `data/business-eval-review.html`（带姓名的人工复核页，`data/` 已 gitignore）

### 12.1 评测口径

| 项 | 做法 |
| --- | --- |
| 查询集 | 43 条真实业务查询，自动从正式库构造：技能词 16 条（Photoshop/Java/MySQL/Python/PS…，各 ≥300 人持有）、**招聘岗位名 11 条**（U3D 客户端开发工程师、游戏测试工程师…，按实际申请数取 TOP）、两词意图 16 条（如「TikTok 投放」「Unity 热更新」「广告 投放」） |
| qrels（正例） | **"本人材料里确实写了该词"**：`profile_sections.title/content`、`attachment.extracted_text`、候选人主档直写字段；先用 FTS 收窄再用 `instr()` 精确确认（与检索链路同一套判定）。多词查询取各词正例交集 |
| 指标 | Precision@10、MRR、Recall@20、延迟 p50/p95/max、HTTP 失败率、降级率、ranking 分布 |
| **局限（必须记住）** | 这是"文本包含"级真值，**不是 HR 主观相关性**；大正例集（数千人）下 Recall@20 上限仅 20/|正例|（实测 0.078），不具区分度。本评测用于发现**漏召回 / 元数据污染 / 超时 / 降级**，不能当作相关性验收 |

### 12.2 结果

| 指标 | 值 |
| --- | --- |
| 查询数 / 成功 | 43 / **38（88.4%）**，**5 条 504（11.6%）** |
| Precision@10（均值） | **0.9579** |
| MRR（均值） | **0.9868** |
| Recall@20（均值） | 0.0784（受上限限制，见局限） |
| 延迟 p50 / p95 / max | **13,531 / 67,121 / 85,309 ms** |
| 降级 | 6 条（`rerank_source_scope` ×5、`model_planning_unavailable` ×2，有重叠） |
| ranking 分布 | `hybrid_reranked` 38 条、**`fts` 回退 0 条** → 成功的查询都真的走了向量 + 重排 |

**分类拆解（关键发现）**

| 类别 | 条数 | Precision@10 | MRR | 延迟 p50 |
| --- | --- | --- | --- | --- |
| 技能词（单词） | 16 | **1.000** | 1.000 | 12.0 s |
| 招聘岗位名（单词） | 11 | 0.9636 | 0.9545 | **8.0 s** |
| 两词意图 | 11 | 0.8909 | 1.000 | **41.3 s** |

**结论**

1. **质量够用（在该口径下）**：单/双词查询的 Precision@10 0.89–1.00、MRR ≈1，且没有出现"元数据假命中"（若 `source_record_id`/`sha256` 之类的字段污染了召回，P@10 会明显掉下来）。
2. **延迟与稳定性不达标**：p95 **67 s**、最长 85 s，5 条 504；**全部 5 条 504 都是两词意图查询**（「Python 服务端」「广告 投放」「运营 活动」「项目管理 进度」「测试 用例」）。单词查询 p50 8–12 s，两词查询 p50 41 s——成本随条件数陡增。
3. 与单条手工测试一致（«Unity 客户端开发» 32.6 s、«数值策划» 8.9 s），并首次给出**分类量化**：两词意图是单词查询的 3–5 倍耗时。
4. 根因方向（未定论，待优化验证）：多词查询要做**多次 FTS 收窄 + 交集**，每次都要在 2,527 万行的全业务 FTS 上跑；索引规模（§11.4）是最可能的放大器。

**下一步优化候选**（按性价比）

1. **收缩 `search_documents_v2`**（§11.4 已给出清单）：2,527 万 → 约 400–600 万行，直接降低每次收窄的成本。
2. 多词查询合并为**一次 FTS 取交集**（现在是逐词收窄后再交集）。
3. 按条件数动态调整预算/降级策略（例如两词查询优先返回部分结果并标注，而不是整条 504）。

---

**附：本文依赖的旧项目关键文件（可直接打开核对）**

| 用途 | 路径 |
| --- | --- |
| 向量库 / 代际发布 | `C:\Users\cboy\Documents\北森\server\search-vector-store.js` |
| 数据源白名单（本项目必须改） | `C:\Users\cboy\Documents\北森\server\search-vector-source.js` |
| 增量维护 | `C:\Users\cboy\Documents\北森\server\search-vector-maintenance.js`、`search-vector-maintenance-service.js` |
| Embedding / Rerank / Planner 调用 | `C:\Users\cboy\Documents\北森\server\search-model-adapters.js` |
| 融合与降级 | `C:\Users\cboy\Documents\北森\server\hybrid-search.js`（`fuse` 在 600 行） |
| 服务与队列 | `C:\Users\cboy\Documents\北森\server\hybrid-search-service.js` |
| 出站脱敏 | `C:\Users\cboy\Documents\北森\server\search-data-minimization.js` |
| 维护 CLI | `C:\Users\cboy\Documents\北森\scripts\search-vector-maintenance.mjs` |
| 评测与容量证据 | `C:\Users\cboy\Documents\北森\docs\evidence\search-service-final-anonymous-remote.json`、`search-vector-capacity.json`、`search-wide-anonymous-capacity.json` |
| 部署事实 | `C:\Users\cboy\Documents\北森\docs\SERVER_DEPLOYMENT_RECORD.md`、`DEPLOYMENT_LOCAL_SERVER.md` |
| 交接与边界 | `C:\Users\cboy\Documents\北森\docs\handoffs\2026-09-10-search-hybrid-next-session.md` |
