# 正式混合检索补充：0.2.0 / V13

用户已授权完成正式混合检索及正式服务更新。本次保留应用 `0.2.0`、主库 `V13`，不增加 V14 或新版本号。此前本地模式发布及未达标指标保留在 [原交付记录](2026-09-10-search-hybrid-delivery.md)，不可与本次结果混淆。

当前状态（2026-09-11 22:41 Asia/Shanghai）：正式回填已完成并原子发布，manifest generation `generation-c5856389-ec70-4cab-90ab-64154bd9f4d4` 已 ready；`429,630` 份来源文档、`630,978` 个 chunks/vectors，正式服务已启用远程规划、Embedding、Rerank 和 mmap worker。smoke 与最新 122/122 后端测试已通过。下文保留实施前过程与质量限制；正式启用证据见 [部署验证](../evidence/search-hybrid-formal-supplement-deployment.json)。

## 已实现

- 规则约束辅助的 `qwen3.8-flash / none` 查询理解，12 秒规划预算，严格网关 Schema 子集与完整本地校验；模型不输出 SQL。未知概念的 AND/OR/NOT、同记录作用域和精确短语须与原文一致；模糊条件保留 unresolved。
- 结构化硬过滤 → FTS5 + `text-embedding-v4 / 1024` → 候选人级 RRF → `qwen3-rerank` 最多 50 人 → 本人业务证据。关联职位/分组要求不能证明本人能力。
- 稀疏集合精确向量评分，宽集合有界 ANN 扩召回，并完整复核资格、排除、来源 hash 和原文偏移。单次最多 5 轮、累计 12,400 事实/12,800 来源行，完整性如实显示；窗口之外仍能稳定深分页。
- 单常驻只读查询 worker、mmap、启动预热、换代回收。规划/查询 Embedding 并行，新查询含排队最多 18 秒；同一分页快照不再发起模型/Embedding/重排。
- 正式 CLI、独立维护进程、只读源 keyset 分页、持久 Embedding 缓存、批量 10/并发 4（上限 8）/最多 3 次重试。离线维护 Embedding 请求上限 30 秒，在线查询 Embedding/Rerank 仍为 5 秒。失败恢复复用已成功 Embedding，从来源起点重新构建 staging；没有按文档断点直接跳过未完成代际。
- 身份信息在完整材料中遮蔽后切片；本地证据不被替换。正式源库网络期间没有长读事务；增量扫描完成才原子发布，保留 active/previous；源变化立即按 live hash 拒绝过期向量，下一轮追赶。

## 前端与业务边界

八个入口、导航、页面用途、列表/按职位展示、筛选和业务能力全部保留。始终输入框加结果，无查询计划确认、步骤向导或新入口。补充实现未修改业务 UI，未删除组件；新增后端状态与原非阻塞提示兼容。正常弹窗、折叠、标签页、无障碍和响应式组件保留。

## 运维契约

正式独立目录：`data/search-vectors/text-embedding-v4-1024-v3`，包含向量原文元数据/Float32、USearch、持久缓存、聚合维护状态。`data/search-runtime.json` 是本工作区的忽略文件，只接受 SEARCH 开关、模型、预算及向量目录，不能放凭据。原 `start.ps1` 继续读取 User 级 Agent/附件配置，再应用本工作区检索配置；普通重启保留检索启用。

明确正式回填命令（现有网关配置从服务端环境加载）：

```powershell
node scripts/search-vector-maintenance.mjs --formal --database data/recruitment.db --directory data/search-vectors/text-embedding-v4-1024-v3 --dimensions 1024 --concurrency 4
```

后台维护需 `SEARCH_REMOTE_ENABLED=true`、`SEARCH_VECTOR_MAINTENANCE_ENABLED=true` 和 `SEARCH_VECTOR_DIRECTORY`，默认每 300000ms 执行增量扫描。维护是独立子进程，强杀/崩溃后锁的 owner PID 失效可恢复；正式业务进程不会替死掉的线程长期持锁。2026-09-11 最终维护状态为 `ready`，实际耗时 `4,778,914 ms`，源变化为 false，重试为 0。

`/api/resume-search/status` 保留原本地状态并增加 hybrid/vector_maintenance。索引 ready、配置存在、某次远程调用成功分别记录；不把配置开关称为健康探针。不返回地址、凭据、路径或候选人正文。

## 验收与限制

实际常驻 `HybridSearchService` 完成 80 人合成匿名库、60 条唯一冷查询。串行并发 1、一个 mmap worker、提前预热，不使用查询/分页缓存；同期同网关有正式维护负载。最新最终代码结果见 [最终服务评测](../evidence/search-service-final-anonymous-remote.json)；较早结果见 [历史服务评测](../evidence/search-service-anonymous-remote.json)，仅作对照。

| 指标 | 原检索基线 | 本次常驻混合服务 |
| --- | ---: | ---: |
| 条件结构正确率 | 0/60 | 60/60 |
| Recall@50 | 0.2167 | 1.0000 |
| Precision@10（固定除以 10） | 0.1250 | 0.5067 |
| nDCG@10 | 0.1794 | 1.0000 |
| MRR | 0.1958 | 1.0000 |
| p50 / p95 延迟 | 1.05 / 8.00ms | 7632.72 / 14821.83ms |
| 最大延迟 | 15.25ms | 12334.70ms |
| 证据归属 | 未单列 | 628/628 |
| 模型计划通过 | 无模型计划 | 54/60，6 次规则回退 |
| 实际向量/重排成功查询 | 不适用 | 各 49/60；各 11 次对应阶段降级 |

100ms 采样进程（含 worker）RSS 峰值 131,506,176 字节；匿名索引目录 1,162,532 字节、主库 1,089,536 字节。预热 201.58ms，160 切片索引建立 2,997.82ms。独立故障注入验证规划、Embedding、重排和取消 4/4 通过，降级成功率 100%；故障注入使用匿名替身，未混入真实远程质量成绩。最新远程结果含 22/60 降级查询，p95 14,821.83ms，未达到 10 秒目标；阶段底层超时/网络分类尚未通过安全错误码进一步区分。后端最终定向集合新鲜通过 122/122（见下文），不能把降级结果称为每次完整混合成功。

本次新的三个视口（1440×900、768×1024、390×844）69/69 断言通过，控制台错误、页面异常和意外 HTTP 错误均 0，见 [浏览器报告](../evidence/search-formal-supplement-ui/search-ui-report.json)。质量测试始终匿名，正式回填材料数、向量数、耗时及磁盘/内存记录不作为质量成绩。

最终整合后端定向集合新鲜执行 122/122 通过（24.447 秒），见 [最新完整输出](../evidence/search-formal-supplement-final-focused.txt)；116/116 与 24/24 是较早子集，不相加为本轮总数。维护/服务生命周期最新复核为 21/21。模型逻辑、向量、维护、常驻服务和 Agent 动态状态分别经过独立审阅及修复复核；最终维护服务源码 SHA-256 已补入审阅台账。

## 正式启用收口（2026-09-11）

- 回填完成：`429,630` documents、`630,978` chunks/vectors，`text-embedding-v4` / 1024 维，chunk version `self-v3-600-80-redacted`；generation 为 `generation-c5856389-ec70-4cab-90ab-64154bd9f4d4`。
- 维护终态：`state=ready`、`source_changed_during_build=false`、重试 0、实际耗时 `4,778,914 ms`；writer 子进程已退出，正式服务中的 mmap query worker 为 ready/current。
- 正式 smoke：HTTP 200、模型计划、无降级、0 行匿名结果；验证只使用随机不存在的 candidate ID，不读取正式候选人命中内容。
- 最新匿名质量限制仍有效：模型计划 54/60，向量/重排各 49/60，降级查询 22/60，p95 14,821.83ms，未达到 p95<=10 秒目标。正式启用表示链路可用，不表示每次请求均为完整混合成功。
- 最新正式启用证据见 [search-hybrid-formal-supplement-deployment.json](../evidence/search-hybrid-formal-supplement-deployment.json)；代码/数据库仍为 0.2.0 / V13，无 V14 或新供应商。

原全量测试存在 8 项已复现的既有失败，依赖审计为 3 high / 1 moderate；本次不回滚用户原修改来使旧测试变绿。匿名二元相关性语料不等价于招聘专家评级或正式分布，规则+FTS已达指标上限的案例不能证明向量带来的增益。ANN 有界，不保证全库语义排序；硬过滤及证据归属必须保持。

遮蔽规则不是全文匿名承诺；本人任职/教育/项目等必要材料发送既有网关，用户查询也可能含个人信息。供应商费率、日志留存、训练及删除策略没有通过本次能力探针验证。成功批次的字符数并非供应商账单，失败重试可能另有用量。RSS 为采样观测，长页按文档数限制、切片数随正文长度变化。

## 回退

把本工作区 `SEARCH_REMOTE_ENABLED` 与维护开关设为字符串 `false` 后正常重启，即回到已改进的本地规则/硬过滤/FTS，原业务及 V13 保留。单个模型或向量调用失败也会明确降级；不会取消硬条件以增加结果。向量发布失败不改 active；旧代际回退需停止维护、校验对应模型/维度/版本和文件摘要，再原子切换 manifest 并回收查询 worker。现有主库正式备份继续保留，本次没有新增主库结构迁移。
