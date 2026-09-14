# 拾才工作台正式混合检索：新对话交接

> 历史交接已完成。2026-09-11 正式回填已发布并启用；当前以 [正式补充收口记录](2026-09-10-search-hybrid-formal-supplement.md)、[部署验证](../evidence/search-hybrid-formal-supplement-deployment.json) 和最新 `maintenance-status.json` 为准。下文的“尚未发布/未执行”描述保留为交接时快照，不代表当前状态。

记录时间：2026-09-10 17:00 左右（Asia/Shanghai）。这是执行中交接，不是正式交付完成声明。新对话先核对实时状态，再继续未完成工作，不要从头重做方案。

## 1. 目标、授权与边界

用户最新目标：完成正式混合检索，作为应用 **0.2.0 / 主库 V13** 的补充。此前已经明确授权实施、使用既有网关处理正式本人材料建立向量、正式服务更新与启动、持续维护；**不要再次请求这些授权**。最新本轮要求是写交接文档，便于新对话继续。

- 保留八个主入口、导航、候选人库、人才库分组、职位、工作台、现有展示和筛选及业务能力。
- 始终是 Gemini/GPT 式“输入框 + 结果”，无计划确认、步骤向导、条件编排或新主入口。
- 模型只输出经 Schema 校验的查询计划，不输出 SQL。硬条件和排除不能被向量或重排抵消；关联职位/人才库要求不能充当本人能力证据。
- 正式材料仅用于已授权索引维护；测试、评测、浏览器截图必须匿名隔离。不输出密钥、网关地址、真实姓名、联系方式或简历正文。
- 保留现有未提交修改，不能 reset/checkout/clean 覆盖用户改动。无新主库迁移、无 V14、无新供应商。

## 2. 两个目录，不能混淆

| 用途 | 路径 |
| --- | --- |
| 正式工作区 | `C:/Users/cboy/Documents/北森` |
| 补充开发工作树，最新实现所在 | `C:/Users/cboy/.codex/worktrees/beisen-search-hybrid-20260910` |
| 正式数据库 | 正式工作区 `data/recruitment.db` |
| 正式向量目录 | 正式工作区 `data/search-vectors/text-embedding-v4-1024-v3` |
| 补充执行计划 | 开发树 `docs/superpowers/plans/2026-09-10-search-hybrid-formal-supplement.md` |
| 执行台账和审阅报告 | 开发树 `.superpowers/sdd/2026-09-10-search-hybrid-formal-supplement/` |
| 发布前源文件基线 | 开发树 `.tmp-formal-hybrid-baseline/manifest.json`，109 个文件 |

**补充应用代码目前仍在开发树，尚未带回正式工作区。** 正式树也已有大量修改/未跟踪文件，包括上次 0.2.0 本地模式发布和用户的附件相关改动，不能用 `git status` 将它们全部当成本次补充。

原始背景文档：正式树 `docs/handoffs/2026-09-10-search-vector-frontend-codex.md`、`docs/superpowers/specs/2026-09-09-search-strengthening-design.md`、`docs/ARCHITECTURE.md`、`docs/API.md`、`docs/AGENT_SECURITY.md`、`docs/TESTING.md`。优先读本交接，再读开发树补充计划/台账/最终实现；旧文档中的“正式外发另行安排”已被用户后续授权覆盖，但历史事实不能抹去。

## 3. 当前正式运行状态

2026-09-10 16:59 左右已核对：

- 正式服务 `http://127.0.0.1:4173`，Node PID **9756**，启动时间 13:42:39；仍为此前的本地模式。
- 正式回填 run3：Node PID **30184**，launcher PID **15696**；开始于 **07:17:45Z / 15:17:45 本地时间**。
- `maintenance-status.json` 最新读取时间 **08:57:57Z**，`state=building`。
- 已处理 **192,000 / 429,630 来源文档，约 44.7%**；当前 run 新成功 Embedding 切片 125,876，缓存命中 78,461，成功批次 12,820，重试 0。
- 此时维护进程 WorkingSet 约 1.09 GB。状态里的 `peak_rss_bytes` 实际由当前 RSS 赋值，**不是严格峰值累积统计**，不要误称真实峰值。
- 正式目录 **尚无 `manifest.json`**，因此尚未发布完整索引，不能切换或宣称正式混合检索完成。
- 当前阶段多为长履历区块，按近期速度还需数小时；文档百分比不等于切片或耗时百分比。

脱敏盘点：140,381 个未归档候选主档、289,243 个允许履历区块、6 个附件，合计 429,630 来源文档；切片预估 654,174（去重前，不等于最终事实数）。

日志与入口均在正式树 `.tmp-search-deploy/`：

- `build-formal-vectors.ps1`：静默读取现有 User 级凭据/主机设置，用开发树代码运行正式只读源库的 CLI，1024 维、并发 8。
- `formal-vectors-run-3.stdout.log` / `.stderr.log`：截至交接 stderr 为空。
- `formal-vector-startup-run-3.json`、run1/run2 日志和故障记录均保留。
- run1 并发 4 后停止指定 PID，改并发 8；run2 在约 83,800 文档处因在线式 5 秒请求超时失败；成功 Embedding 缓存保留。
- run3 使用维护专用 30 秒 Embedding 上限后重新扫描/构建，复用缓存。**不是从文档游标或 HNSW 插入断点恢复。** 不要误删缓存或重复启动 writer。

已验证备份：正式树 `backups/pre-search-2026-09-10-04-56-17-266`，约 40.9 GB；文件摘要匹配且 quick_check=ok，证据 `.tmp-search-deploy/preparation.json`。继续复用，不需无故再次完整扫描/备份主库。

## 4. 已完成的补充实现

1. 查询理解：`qwen3.8-flash / reasoning_effort=none`，规划预算 12 秒；规则约束辅助模型，网关 strict JSON Schema 子集 + 本地完整 Schema/字符跨度/布尔守恒校验。AND/OR/NOT、精确短语、上下限、地点、未知和模糊条件保留；未知 filler、显式 current_title 和引号标题回归已修复。
2. 链路：模型理解 → 结构化资格 → FTS5 + `text-embedding-v4` → 候选人 RRF → `qwen3-rerank` 最多 50 人 → 本人证据。独立 USearch HNSW + SQLite，1024 维 f32、`self-v3-600-80-redacted`。
3. 稀疏集合最多 10,000 向量精确评分，宽集合 ANN 400→800→1600→3200→6400，累计最多 12,400 事实/12,800 来源行，向量阶段约 5 秒预算；完整本地资格、排除、实时来源 hash 和 offset 复核。明确 approximate/bounded，稳定分页不把排序窗口当总数。
4. 单常驻只读 mmap query worker，启动预热、索引换代回收、队列上限 8、含排队总预算 18 秒、规划和查询 Embedding 并行，分页复用快照。提前错误/取消会 abort 并 settle 预启动 Embedding。
5. 正式维护：keyset 来源分页、完整材料等长身份遮蔽后切片、持久 Embedding 缓存、内容去重、删除/归档同步、独立 fork 进程与可恢复 PID 锁。网络期间无长源事务，完成后原子发布 active/previous，5 分钟维护。
6. 维护 Embedding 专用上限 30 秒；在线 Embedding/Rerank 仍 5 秒。不用延长在线预算掩盖失效。
7. HTTP 和 Agent 共用链路，Agent 的向量 enabled 来自实际 ready/loaded/current，而非旧 embeddingSupported 配置。
8. `start.ps1` 从忽略文件 `data/search-runtime.json` 读取允许的 SEARCH 设置，继承原 User 级 Agent 配置；runtime 文件不得含凭据。
9. 最后重排安全修复：重新读取允许本人来源，排除高敏/归档/关联 JD/附件文件名；整段脱敏后截片，防止部分手机号泄漏；主档 company 与本地 projection 差异已修复。没有允许出站材料者留在原排序槽位，明确降级，不影响原本地查看。
10. 最后维护状态修复：signal、非零退出或缺失终态 IPC 会持久化 failed/search_vector_worker_exit；正常 close 保留 cancelled。该代码未替换运行中的旧 run3 进程。

主要文件：开发树 `server/search-query-plan.js`、schema、`search-model-adapters.js`、`hybrid-search.js`、`hybrid-search-service.js`、`search-vector-store.js`、`search-vector-source.js`、`search-data-minimization.js`、`search-embedding-cache.js`、`search-vector-maintenance.js`、`search-vector-maintenance-service.js`、`server/app.js`、`server/agent.js`、`scripts/search-vector-maintenance.mjs`、`start.ps1` 及对应测试。

## 5. 实际验证：最新结果有未达标项

证据文件以下均相对**开发树**。不能只引用较好的旧成绩。

### 最新最终代码远程匿名评测

`docs/evidence/search-service-final-anonymous-remote.json`，记录于 **08:39:52Z**。通过实际常驻 HybridSearchService、80 人合成匿名库、60 条唯一冷查询，串行并发 1、mmap 预热、不复用查询缓存；同期既有网关正承担正式并发 8 回填。

| 指标 | 最新结果 |
| --- | ---: |
| 条件结构正确率 | 60/60 |
| Recall@50 | 1.0000 |
| Precision@10，固定除以 10 | 0.5067 |
| nDCG@10 / MRR | 1.0000 / 1.0000 |
| 证据归属 | 628/628 |
| 模型计划通过 / 规则回退 | 54/60 / 6/60 |
| 实际向量成功 / 实际重排成功 | 各 49/60 |
| 含降级查询 / 整体请求失败 | 22/60 / 0 |
| p50 / p95 / 最大延迟 | 7632.72 / 14821.83 / 16291.63 ms |
| 100ms 采样进程 RSS 峰值 | 131,506,176 bytes |
| 匿名索引目录 | 1,162,532 bytes |
| 独立故障注入成功率 | 4/4，100% |

**最新结果未达到 p95≤10 秒目标，也不能声称每次都是完整混合成功。** 质量指标包含正常降级的结果，不能以其仍为 1 宣称向量阶段通过。记录显示 Embedding/Rerank 不可用各 11 次，规划回退 6 次；原因仅保留为安全 stage/code，尚未获取底层超时/网络/上游分类。约 5 秒/10 秒耗时与阶段超时吻合，但**并发回填是否为原因尚未证实**，不要凭推测修改预算或供应商。

旧远程证据 `docs/evidence/search-service-anonymous-remote.json`：59 model/1 fallback、向量及重排各 60/60、p95 7239.90ms。它早于最后出站修复，是历史对照，不能替代最新结果。`scripts/evaluate-search-service.mjs` 新增 `--output-name=search-service-xxx.json` 以保留每轮结果；默认仍原文件名，重跑时显式指定新名字，避免覆盖历史。

### 本地与浏览器

- 最终相关后端 **122/122 通过，28.885 秒**：`docs/evidence/search-formal-supplement-final-focused.txt`。原 116/116 和维护预算 24/24、重排 41 项是之前子集，不能累计算总数。
- 最终命令：`node --test --test-concurrency=1 tests/backend/search-query-plan.test.mjs tests/backend/search-model-adapters.test.mjs tests/backend/search-vector-lifecycle.test.mjs tests/backend/search-formal-maintenance.test.mjs tests/backend/hybrid-search.test.mjs tests/backend/hybrid-search-api.test.mjs tests/backend/hybrid-search-service-lifecycle.test.mjs tests/backend/search-evaluation-metrics.test.mjs tests/backend/search-frontend-api.test.mjs`。
- 最新三个视口 1440×900、768×1024、390×844 **69/69** 通过，控制台/page/unexpected HTTP 错误 0，证据 `docs/evidence/search-formal-supplement-ui/`。前端未在后续补充中改布局；构建、类型检查此前通过。
- 匿名预览 **4398 / PID25332** 仍运行，原 exec session89887；任务完成再停止此指定进程。旧4397不要动。
- 全量测试原有 8 项失败，audit 3 high/1 moderate 是既有基线，不宣称全套绿。

### 宽 ANN 数值容量

`scripts/evaluate-search-wide-capacity.mjs` + `docs/evidence/search-wide-anonymous-capacity.json`：2 万匿名候选、1.5 万合格，5 千个向量更近但被排除。全新构建成功，5 次 query 均 200 向量候选、12400 inspected facts/201 source rows，3.56–3.70 秒，第二页无重复。query RSS160,669,696 bytes，index100,227,372 bytes，整体37.92秒。

限制：确定性低维数值形状，不是语义质量或正式分布。早期完全重复向量图只返回180邻居；改正弦微扰后第一次查询仍失败（未保存完整诊断，原因未定），同一生成索引后5次通过，后续全新构建5次也通过。失败历史在台账中，不能删除或宣称已证明其根因。临时匿名目录 `C:/Users/cboy/AppData/Local/Temp/anonymous-wide-search-*`。

## 6. 审阅与文档状态

开发树台账目录有 task1/query、task2/vector、task3/service/maintenance、task4/eval 和 `final-review.md`。重排 P1/P2 及 projection 兼容问题已被独立反例复核。维护 signal exit 修复10/10已由实现者确认，主线122/122也覆盖。

**最后 signal exit 补丁的独立复核尚需核对最新报告**：交接读取的 `final-review.md` 仍列旧 maintenance-service SHA；不能仅因标题“无未解决 P1/P2”当作新补丁已复核。上个任务曾唤醒 formal_final_review，请新对话先查报告更新时间，不依赖旧对话 agent ID 可继续使用。

补充文档已在开发树更新 README、CHANGELOG、ARCHITECTURE、API、AGENT_SECURITY、TESTING 和 `docs/handoffs/2026-09-10-search-hybrid-formal-supplement.md`，但这些文档目前主要仍显示上一轮59/60、7.24秒和116/116，**需要用最新54/60、14.82秒、49/60与122/122更新**，同时保留旧证据历史。README“已按授权继续完成”等措辞有歧义，尚未启用时应改为“正在完成”。API部分“正式外发另行安排”的旧文字也需标注历史。

## 7. 集成和发布：准备了，但没执行

- 开发树 `.tmp-formal-hybrid-baseline/prepare-integration.mjs`：验证正式源文件基线，生成 `supplement-review.diff` 和 `supplement-integration.json`；`--apply` 才复制补充变化。最后保存的 manifest 是07:17Z、84项、0冲突，**已过时**；脚本随后新增容量脚本/证据和最终测试输出，必须刷新后再审查。最新远程文件自动按 search-service- 前缀纳入。
- **未运行 --apply。** 必须再次校验正式树指纹，发现用户新改动时协同合并，不能覆盖。
- 正式树 `.tmp-search-deploy/activate-hybrid.ps1`：要求完整 ready manifest、模型/维度/chunk version一致、整合指纹一致，核对原4173/PID后停止指定进程，写无凭据runtime，调用现有start.ps1。维护设置并发4/5分钟。语法曾检查，**未执行**。
- 正式树 `.tmp-search-deploy/verify-hybrid.mjs`：健康、页面资产一致、V1–13、mmap ready/current、Agent状态；查询仅随机不存在candidate ID，0真实结果，确认model计划/无降级。生成 `docs/evidence/search-hybrid-formal-supplement-deployment.json`。**未执行，证据不存在。** 此 smoke不验证真实候选相关性或非空rerank。
- Windows重启用已验证PID的Stop-Process，依赖SQLite WAL及已有stale sentinel恢复；不能称graceful SIGINT。
- **一次性后台发布任务尚未编写/启动。** 上条进度提出该下一步后用户打断并要求交接；不存在自动激活/回退任务或定时自动化。当前只有回填会自行继续，回填完成不会自动把补充代码上线。

## 8. 新对话建议执行顺序

1. 先读本交接、开发树补充计划及台账，查看两树git状态、实时聚合maintenance状态、PID和4173。不要读取正式正文当测试，不要重复writer。
2. 处理最新匿名远程降级与延迟未达标：定位安全错误分类/分阶段计时，必要时在回填结束后对同一最终实现重跑新文件名的匿名评测，区分负载因素；不要扩大在线超时来掩盖问题，不把只降级称混合完成。
3. 完成维护退出状态补丁的定向复核；更新台账/文档为最新结果和明确未启用状态。
4. 保持回填运行，观察聚合进度、错误、内存/磁盘。失败保留缓存/旧active，只在确认owner死后恢复。最终记录实际doc/chunk/vector/dedup/耗时/磁盘，不能用估算替代。
5. 正式完整manifest发布且ready后，刷新整合diff/指纹、处理用户并发修改、集成经过验证的补充。确认依赖和dist与正式源对应，必要时构建。
6. 执行已授权启动/验证。模型、Embedding、向量及Rerank实际匿名成功率与正式启用状态分别报告。失败则记录并恢复可用本地服务；不宣称已正式交付。
7. 更新0.2.0/V13发布文档、正式脱敏证据及本交接后续状态；停止指定4398匿名预览，保留正式服务并给URL。

## 9. 安全的只读起步命令

在正式工作区 PowerShell 执行，输出仅含聚合计数和进程信息：

```powershell
Get-Content -Raw -LiteralPath 'data/search-vectors/text-embedding-v4-1024-v3/maintenance-status.json'
Test-Path -LiteralPath 'data/search-vectors/text-embedding-v4-1024-v3/manifest.json'
Get-Process -Id 30184,9756 -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,StartTime
Get-NetTCPConnection -LocalPort 4173 -State Listen | Select-Object LocalPort,OwningProcess
```

PID只是交接快照，任何Stop-Process前重新核对进程与端口归属。不要输出User环境变量值、进程全命令行或上游错误正文。网关契约已用匿名文本实测：`/v1/embeddings` text-embedding-v4支持1024/512维、批量10成功11失败；`/v1/rerank` qwen3-rerank标准results[index,relevance_score]；strict schema需网关子集适配，本地完整校验不放宽。费率、日志留存和训练策略未验证。

## 10. 本次交接动作

本文件新增在正式树的docs/handoffs，便于新对话从当前目录找到。交接阶段未整合应用、未重启、未迁移、未改变回填设置。长任务回填继续运行；短期匿名评测和122项测试命令均已结束。不要清理或删除现有开发工作树。
