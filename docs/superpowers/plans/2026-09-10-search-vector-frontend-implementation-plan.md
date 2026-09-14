# 拾才工作台：人才检索与现有前端优化实施方案

> 后续状态（2026-09-10）：用户已明确要求直接执行。本方案以下保留制定时的历史状态；实现与实测结果、未通过门禁见 [交付记录](../../handoffs/2026-09-10-search-hybrid-delivery.md)。正式数据回填与部署仍未执行。

日期：2026-09-10。状态：**待用户批准，仅方案；尚未实施、迁移或部署。**

> For agentic workers: 批准后使用 `executing-plans` 逐项执行，每项以匿名测试和审阅结果收口。本文件不是代码修改、正式数据处理、迁移或部署的授权。用户本轮约束优先于旧交接中的“方案已确认”。

**Goal:** 提升人才检索条件理解、召回、排序和证据可信度，并改善现有页面视觉；保持 Gemini/GPT 式“输入框 + 结果”。

**Architecture:** 模型查询理解 → 结构化硬过滤 → FTS5 + text-embedding-v4 双路召回 → 候选人级融合 → qwen3-rerank 有界重排 → 业务证据结果。模型只输出经 JSON Schema 校验的查询计划；资格判断、SQL、证据归属与执行预算由服务端控制。

**Tech Stack:** 当前 React 19 / TypeScript / Vite 7 / Express 5 / Node.js 24 / SQLite FTS5；拟增加独立查询计划、Embedding/Rerank 适配器及本地向量索引。

**Spec:** `docs/handoffs/2026-09-10-search-vector-frontend-codex.md`、`docs/superpowers/specs/2026-09-09-search-strengthening-design.md`。结合 `docs/ARCHITECTURE.md`、`docs/API.md`、`docs/AGENT_SECURITY.md`、`docs/TESTING.md` 与当前未提交工作树；事实冲突以本轮实际代码/探针为准，正式环境状态不推断。

**全局约束：** 保留候选人库、人才库分组、职位管理、工作台和全部当前入口、页面用途、展示模式、筛选方式和业务功能。不处理“问题101：功能面大、入口较多”。检索不得增加工作流、步骤向导、条件编排器或查询计划确认页。匿名评测通过不代表正式迁移或上线完成。本轮不连接真实候选人数据、不生成正式向量、不修改既有代码或数据库。

## 1. 已验证事实

### 1.1 工作树与文档差异

- 本轮基线 HEAD 为 `8470f1c`，已有 **25 个已跟踪文件修改**，另有交接/设计文档、`src/preview-theme.css` 和既有输出文件未跟踪。未覆盖、回滚、提交或清理这些修改；未读取既有输出目录中的候选人材料或图片。
- 已有修改包含 PDF 几何阅读顺序、表格/时间线与独立双栏判定、局部坐标降级、公开正文清洗与 `raw_text` 保留；新增对应匿名回归测试。本任务应消费这些既有结果，不能用向量切片重新解释或改写原始附件正文。
- 已有修改包含附件文本/视觉超时、可信私网 HTTPS 配置、系统 CA 与启动配置优先级。启动器以用户级配置优先，不能直接运行 `start.ps1` 做探针，因为它会安装/构建/启动应用。
- 已有前端修改把助手、履历检索、附件解析接入独立工具页，导入使用 page presentation，候选人/人才库/职位工具栏调整；`src/main.tsx` 已加载未跟踪的 `preview-theme.css`。这些都是当前基线，不回退到 HEAD 的旧抽屉布局。
- `docs/ARCHITECTURE.md` 仍以 schema V12 为主，而 `server/database.js` 已有 V13 `years_experience_raw` 迁移；年限应使用现有可空数值投影，原文保留。正式库当前版本未查询。
- 安全文档与未提交代码存在实际差异：`isReadonlyBusinessColumn()` 当前放行所有非 BLOB 业务列，包含原本 deny-list 中的 `storage_path`；`server/agent.js` 当前把部分网关错误正文拼入错误信息。新检索不能依赖这两处作为安全投影，必须使用自己的固定输入/输出白名单和无正文错误映射；不在本轮回滚用户的通用 Agent 修改。正式发布前需解决该契约差异。
- 测试文档保留多轮历史成绩，并记录过 Agent 时序、V11 文档断言和 V12 维护辅助文件缺失的失败。本轮未运行完整测试、构建或浏览器验收，不能沿用历史“全部通过”。

工作树只读指纹：25 个修改文件按 Git 路径顺序计算内容 SHA-256 后再聚合，值为 `597dc60d1d93a75a3a052b71367741b5918f95aa132f9ab8788f32f7c21bc2fb`；既有 `preview-theme.css` 为 `b0d9f846f732e5092ad646f2dbdb41a4dcf32fef62a7b0a4369a173fad129198`。指纹不包含文件正文。

### 1.2 匿名能力探针实际记录

探针直接调用当前配置的 HTTPS 网关，路径前缀已核实为 `/v1`。凭据只在子进程内存使用，继承系统 CA，保持 TLS 验证，禁止重定向。没有加载应用、打开数据库、启动服务、保存返回向量或调用真实候选人 API；没有打印密钥、网关地址或原始错误正文。

以下耗时是**单次端到端观测值**，包含读取响应体；不是 p50/p95、吞吐或 SLA。部分独立探针并行执行，不能据此比较模型速度。

| 探针 | 实际结果 | 耗时 ms | 可确认的契约 |
| --- | --- | ---: | --- |
| Embedding，1 条匿名文本 | HTTP 200 | 517 | `POST /v1/embeddings`、模型 `text-embedding-v4`、默认 1024 维、浮点数组且全部有限 |
| Embedding，10 条短文本 | HTTP 200，10 个结果 | 1044 | 返回索引与输入一一对应，全部 1024 维 |
| Embedding，11 条短文本 | HTTP 400 | 352 | 超过本次网关批量边界 |
| 11 条边界原因复核 | HTTP 400 | 784 | 错误为 batch 限制且明确涉及 10；原文未记录 |
| Embedding，显式 `dimensions:512` | HTTP 200，512 维 | 182 | 支持本次 512 维请求，不代表任意维度可用 |
| Rerank，2 文档、`top_n:2` | HTTP 200，2 个结果 | 329 | `POST /v1/rerank`、`qwen3-rerank` 可用，相关文档排前 |
| Rerank，3 文档、`top_n:1, return_documents:true` | HTTP 200，1 个结果 | 594 | 第一名 index=1，返回 `document.text` |
| Rerank，50 短文档、`top_n:50` | HTTP 200，50 个不同索引 | 698 | 索引全部位于 0–49，分数有限，相关匿名样本 index=37 排首位 |
| `gpt-6-astra` 严格 Schema，违背格式的用户提示 | HTTP 200，Schema 校验通过 | 13374 | `response_format.json_schema.strict:true` 被接受，required/enum/禁止额外字段样例通过 |
| `gpt-6-astra` 无效 Schema 负对照 | HTTP 400，Schema 类错误 | 1222 | 无效 Schema 未被静默当作普通文本请求 |
| `gpt-6-astra` 嵌套数组/对象 Schema 对抗样例 | HTTP 200，Schema 校验通过 | 4121 | 嵌套字段、枚举和 required 样例通过，无额外 SQL 字段 |
| `gpt-5.6-terra` 正向 Schema 探针 | HTTP 502 | 2080 | 本轮不可确认为可用模型 |
| `gpt-5.6-terra` 无效 Schema 探针 | HTTP 502 | 711 | 无法判断其严格 Schema 能力；不能把 502 当作合规拒绝 |

结论：当前 `gpt-6-astra` 的**所测严格 Schema 子集可用**；不能由有限黑盒测试证明所有 Schema 关键字或底层约束解码行为。服务端本地校验仍为强制边界。Embedding 批量设为最多 10 条；长文本 token 限制、单请求字节上限、限流和价格尚未核实。Rerank 验证至 50 条短文档，未探测供应商绝对上限，也未验证长证据包。

实际请求/响应形状如下，省略的是认证头而不是业务字段；示例文本全部虚构：

```json
{
  "model": "text-embedding-v4",
  "input": ["匿名能力探针：示例工程师熟悉系统设计。"],
  "encoding_format": "float"
}
```

响应顶层有 `object:"list"`、`model`、`data`、`usage`、`id`；`data[]` 含 `object`、`index`、`embedding:number[]`。`dimensions:512` 是已验证可选请求字段。按 `index` 还原输入顺序，不能依赖供应商返回数组天然有序。

```json
{
  "model": "qwen3-rerank",
  "query": "匿名检索：游戏战斗系统策划",
  "documents": ["匿名样本A：设计游戏战斗系统。", "匿名样本B：从事物流库存管理。"],
  "top_n": 2,
  "return_documents": false
}
```

该请求实际返回 `results:[{index:0,relevance_score:0.6917879718897899},{index:1,relevance_score:0.35275186227681193}]` 及 `usage`，**不是 OpenAI Embedding 的 `data[]` 格式**。`return_documents:true` 时结果可含 `document:{text:string}`。适配器按该契约实现；运行请求使用 false，返回正文不能作为证据事实来源。分数只用于当前集合排序。

Chat 请求使用 `messages`、`stream:false`、`max_completion_tokens`、`response_format:{type:"json_schema",json_schema:{name,strict:true,schema}}`，未带 tools/tool_choice；解析 `choices[0].message.content`，检查 JSON、Schema、`finish_reason` 和 refusal。探针分别使用 256/384 的输出 token 上限，正式查询计划预算需另测。

### 1.3 当前检索与前端复核

直接导入纯函数 `normalizeResumeSearch`，未连接数据库；六条查询结果与交接一致：

| 输入 | 当前实际解析 | 审阅方案中的正确语义 |
| --- | --- | --- |
| 上海 游戏策划 战斗系统 | 游戏开发 AND 上海；location 为空 | 当前所在地上海 AND 游戏策划 AND 战斗系统；保留原词 |
| 找3到5年经验的后端工程师 | 后端；min=5，无 max | 后端工程师；3≤总工作年限≤5 |
| 找3年以下经验的后端工程师 | 后端；min=3，无 max | 后端工程师；总工作年限≤3 |
| Unity 或 Unreal | Unity AND Unreal | 必须满足 Unity OR Unreal |
| Unity 不要外包 | 只有 Unity，无排除 | Unity；本人证据范围内排除外包事实 |
| 找熟悉数值策划的人 | 整句为一个概念 | 数值策划；去掉指令前缀和尾语 |

以“目标条件全部保留且逻辑/范围正确”为 exact-match 标准，本轮六条定向样例为 **0/6 = 0%**。这是故障复现集，不能外推到生产查询准确率；未测 Recall、Precision 或排序改善。

- `server/business-search.js:3076` 的候选人 fast 计划先按 FTS rowid 限制每个概念的文档，再映射候选人并做交集/过滤。默认候选人窗口至少 10,000 文档；有来源过滤时可能为 2,000。限制不等于候选人 Top-K，且未包含所有硬条件。
- 当前计划将职位、人才库、stage、导入批次命中映射为候选人命中。仅有 candidate_id 也不保证字段是本人能力：来源 JSON 可含职位要求。
- `candidateSearchFingerprint()` 未绑定数据/索引代际，且未包含 `fields`；新协议必须纳入完整执行语义。
- 向量预留表 `candidate_resume_vectors` 已有 BLOB、模型、维度、chunk_index，但唯一键是 `(document_id, chunk_index, provider, model)`，缺少内容哈希、向量空间版本与构建代际；不能直接混写 512/1024 维或新旧切片。
- `ResumeSearchService` 已有文件型只读 worker、取消、并发默认 2、超时/重试；HTTP API 为 `/api/resume-search` 和 `/api/resume-search/status`。Agent 另走只读查询服务，需共享语义而非复制实现。
- `AssistantDrawer` 已有输入、筛选、结果、请求序号、AbortController 和游标页；结果目前展示内部表名/字段路径及数值 score，初始状态和零结果共用文案。
- 职位/人才库筛选来自 App 已加载列表，选项完整性受外层分页限制。必须保留选择方式并改为独立完整来源。
- `preview-theme.css` 有全局 `display:none !important`、页面/抽屉共用层级与绝对定位；`modern-*` 选择器未在当前组件引用搜索中命中。上述只是静态审计发现，**本轮没有浏览器遮挡或可操作性结论**。
- 机器只读信息：Node `v24.18.0`，Windows，i7-10870H，16 个逻辑处理器，物理内存约 15.8 GiB；未评估可用磁盘空间或当前其他进程占用。

## 2. 推荐架构

### 2.1 统一查询计划与强制边界

查询接口与 Agent 的人才检索工具共用 `SearchPlanV1`。独立规划调用只接收用户查询及最小筛选元数据，不发送候选人、职位 JD 或人才库正文，不提供 SQL/tool 能力。后续 SQL 由服务端固定编译器生成、标识符白名单化、值参数绑定。

建议计划契约：

```ts
type Expr =
  | { kind: "all" | "any"; scope: "candidate" | "record"; children: Expr[] }
  | { kind: "not"; child: Expr }
  | { kind: "term"; text: string; match: "exact" | "concept";
      evidence_scope: "self" | "linked_position" | "talent_pool"; span: [number, number] }
  | { kind: "filter"; field: "years" | "current_location" | "desired_location" |
      "education" | "current_company" | "current_title" | "position_id" |
      "talent_pool_id" | "source" | "archived";
      op: "eq" | "in" | "gte" | "lte" | "gt" | "lt";
      value: string | number | string[]; span: [number, number] };
type SearchPlanV1 = {
  version: 1;
  must: Expr[];
  should: Expr[];
  minimum_should_match: number;
  must_not: Expr[];
  unresolved: { text: string; span: [number, number];
    reason: "ambiguous" | "unsupported" | "conflict";
    impact: "required" | "excluded" | "preference" }[];
};
```

这是拟实现的领域契约；对应 JSON Schema 使用 `$defs`/`anyOf`、全对象 `additionalProperties:false`、枚举和 required。属性组合约束由本地语义校验补足。原始 query、解析来源、prompt/schema 版本、耗时、有效筛选和冲突由服务端添加，不信任模型自报。

执行规则：

1. `must` 全部成立，`must_not` 任一成立即淘汰。`should` 默认只排序，`minimum_should_match` 明确控制必须命中数；“Unity 或 Unreal”编译为 `must` 内的 any 组，不能变成可忽略偏好。嵌套中的地点/年限不得被错误提升为全局 AND；`(Unity AND NOT 外包) OR Unreal` 的 NOT 仅作用于所在分支，不能提升为全局排除。使用 matched/unmatched/unknown 三值逻辑，NOT unknown 仍为 unknown。
2. 最大深度 4、总节点 32、每概念别名最多 12、单术语最多 80 字符。Span 使用 JavaScript UTF-16 的 `[start,end)`，验证范围及与原文的一致性；未消费的实质条件进入 unresolved，不能因词典命中而丢掉中文剩余词。
3. 年限范围优先于单下限规则；“以下/以内”按含边界 `≤`，“不足/少于”按 `<`，“以上/至少”按 `≥`，“超过”按 `>`；“不限”不加条件。用 `years_experience` 数值，NULL 不等于 0，`years_experience_raw` 不临时强制转数值。
4. 裸地点“上海”建议解释为当前所在地，摘要写明“当前所在地：上海”；“意向上海”查求职偏好。没有依据时不把意向地、就读地或招聘职位地点当成当前所在地。行政区别名用本地字典，关系 ID 在服务端解析；重名保持 unresolved，不让模型造 ID。
5. 跨记录 AND 在同一候选人的不同本人经历成立；明确要求“同一项目/同一任职”时使用 record 范围。技能专项年限不能用总工作年限替代，缺少可靠结构化关系时保留 unresolved。
6. 精确短语必须在同一原始来源的连续片段中出现；中文二/三元 token 只用于召回，不能证明短语连续成立。跨分片边界可借同一来源相邻片段与偏移验证，不能拼接不同记录伪造短语。
7. 同义词、上位概念、相关词分开。精确名称/数字/排除不能被语义扩展替代。概念条件可使用审阅过的等价表达和可核验的本人行为规则，例如数值体系/成长曲线设计；“做过游戏”不自动等价于“游戏策划/数值策划”。向量和 Rerank 分数本身都不能使 must 成立。
8. “不要外包”建议排除本人工作/项目/当前任职中的正向外包事实；否定陈述、无法归属或模糊公司性质要单独识别并标记未知，不依据职位 JD 或分组名称推断。界面说明“在已检索本人经历中未发现外包证据”，不承诺现实中从未外包。索引不完整时不能给出排除已充分验证的结论。
9. 显式 UI/兼容 API 筛选优先；与自然语言冲突时返回有效条件和冲突解释。不能静默放宽或无声覆盖。支持只有地点/年限等结构化条件的查询，直接分页资格集合，不为满足旧解析器的关键词要求伪造术语。模型非法 JSON、额外 sql 字段、拒绝、截断、语义冲突、超限、超时均触发确定性规则兜底，并返回降级/未解析项。
10. 规则兜底同样输出完整 Schema、保留 AND/OR/排除/短语/上下限，不回退到当前有缺陷的解析器。无法可靠执行的必需/排除项使条件完整性为 partial；可直接展示已知条件结果，但不能称为“全部条件匹配”，未知项保留在卡片与摘要中。不存在强制确认步骤。

### 2.2 硬过滤、召回与候选人融合

- 先构建候选人资格范围：归档、数值年限、地点、学历、职位关系、人才库关系、明确来源等。在 SQLite 内表达范围，不把全库 ID 装入主线程数组。
- 对每个精确词/短语/概念分别取得**本人证据命中的候选人集合**，再按布尔树做集合交并差。结构化过滤前不截断 FTS rowid；必须先完成候选人资格判断，再选 Top-K。用索引/稀有条件驱动和 `EXPLAIN QUERY PLAN` 控制成本，不只是把 LIMIT 放大。
- 结构化条件嵌在 OR 中时，按分支资格范围求并集；禁止把各分支地点合成互相矛盾的全局条件。排除在候选人完整相关证据范围执行，不能仅检查返回的三条片段。
- FTS 路保留中文原词、技术名词和精确短语；向量路只检索可归属的本人切片。选择性很高的范围使用有界精确向量距离；大范围使用过滤感知的本地 ANN。不能全局 ANN Top-K 后简单过滤并宣称完整召回：若引擎不支持预过滤，采用有上限的迭代扩召回，耗尽预算必须标记 bounded。
- 每路先去重到候选人再融合。初始每路最多 200 位，合并最多 400 位，RRF 初值 `1/(60+rank)`、两路等权；同一事实/来源哈希重复只贡献一次，避免长简历和多次导入占优势。参数由固定评测集决定，不把这些初值称为最优。
- 融合后重新验证所有硬条件、排除和来源版本；任何失败从集合移除，无分数补偿。向量命中缺少可验证必须条件时只能标为未知/不合格，不能以相似度补证据。
- 全业务 `search_all_records` 的跨实体定位功能保留；人才检索将“本人经历”“关联信息”“备注/评估”等证据类型明确分开。关联职位/人才库可满足用户明确的关系条件，但不能满足技能条件，也不进入能力向量。

### 2.3 有界重排和业务证据

- Rerank 初始只重排融合后的前 **50 位**候选人，一人一个证据包。每包最多 3 条、每条最多 600 个字符；单包最多 1800 字符，总请求上限 256 KiB，并另受供应商 token 限制约束。长证据不能静默截掉决定资格的否定句或时间关系。
- 只发送查询与脱敏后的必要本人证据，使用临时样本序号映射候选人，不传姓名、联系方式、证件信息、真实内部 ID、关系 JD、附件路径或整份履历。实际脱敏覆盖率需测试，规则脱敏不是绝对无个人信息的保证。
- 响应必须包含互不重复、范围正确的整数 index 与有限数值 relevance_score；缺失/重复/越界/超时/超限整次回退 RRF，不能丢候选人或相信返回 document 文本。
- 证据事实从本地原始记录重建：`candidate_id/source_record_id/source_kind/content_hash/revision/offsets/condition_ids/match_kind/status`。候选人与字段路径的所有权先校验；来源 JSON 只有经过白名单认定的本人字段可形成能力证据。
- 业务结果展示“工作经历、项目经历、专业技能、附件简历、关联职位、人才库分组”，并区分精确命中、同义表达、语义相关和未知条件。检索排名不得显示为能力百分比；原始 score 保留给兼容 API，默认界面不展示。

### 2.4 API、状态和分页

保留现有 GET `/api/resume-search`、`/status` 和 Agent 工具名；兼容 `q/query/keywords/phrases/match_mode/filters/page/page_size/cursor/fast/include_total`。旧 API 的归档默认和 UI 当前“活动”默认分别保持。`fields/source_types` 必须同时约束两条召回通道，不能被向量忽略。

拟增加同资源的 POST `/api/resume-search`，供自然语言正文与非阻塞条件编辑使用，不增加 UI 入口或确认环节。GET 的 500 字符兼容上限保留；POST 初始最多 8000 字符、请求体 64 KiB。旧调用和新调用都进入同一服务，客户端提交的覆盖项再经本地 Schema/权限校验，不能提交 SQL。

响应增量字段：`plan`、`effective_filters`、`unresolved`、`warnings`、`degradation`、`completeness`、`index_versions`、业务化 evidence。现有 items/pagination/index 保留，不改变每页默认 20、HTTP 最大 100、Agent 默认 20/最大 50 和每人 evidence 最大 5。

完整性分开表示：`conditions:complete|partial`、`retrieval:complete|bounded|partial|index_not_ready`、`ranking:hybrid_reranked|rrf|fts`；`has_more` 是实际续页能力，不能表示全库已搜索完。向量近似/有界搜索不承诺语义全集，未算精确数量时 `total:null`，不可把 Top-K 数字冒充总命中数。

分页采用有界服务端排序快照：首次固定候选集合、前 50 重排结果及其余 RRF 次序，不能每页重新调用模型重排。初值 TTL 10 分钟、全局快照预算 32 MiB/LRU 64 项，游标为不透明标识加 HMAC。绑定规范化计划、全部筛选（包括 fields）、权重/模型/Schema、词法与向量代际及数据修订号。索引/数据变更返回 `409 search_snapshot_stale`，快照过期返回 `410 search_snapshot_expired`，界面保留输入并提供重新检索。

**保留原翻页能力：** 400 位是首轮融合窗口，不是查询总人数或翻页上限。后续页自动从硬条件成立的确定性 FTS 集合继续取数，排除已输出 ID；有向量续游标时在剩余预算内补充。新窗口只追加，已返回页面次序固定；展示分段/有界排序状态，不宣称全库最优排序。精确 FTS 模式保留完整计数/深分页路径；仅语义命中超出预算时如实标记有界，不伪造穷尽。不增加用户必经操作。

查询 worker 使用只读连接；网络调用由独立适配器负责；向量维护不进入只读 worker/Agent 工具。查询取消覆盖网络响应体读取、worker 与结果组装，沿用前端请求序号丢弃迟到结果。

## 3. 模型与向量选型

| 部分 | 推荐 | 已知依据与取舍 |
| --- | --- | --- |
| 查询理解 | 独立 `SEARCH_QUERY_MODEL`，以当前 `gpt-6-astra` 作已验证契约基准/暂定候选 | 正/负严格 Schema 探针通过；延迟为 4.121/13.374 秒，尚不满足稳定低延迟结论。不能更改全局 Agent 模型来接入检索 |
| 备选理解模型 | `gpt-5.6-terra` 暂不采用 | 两次 HTTP 502；模型列表存在不能替代可用性验证。其他模型仅在同契约与匿名质量评测通过后选择 |
| Embedding | `text-embedding-v4`，1024 维作为质量基准，512 维作为容量对照 | 两种维度均实际成功；每批最多 10 条。选择 512 维需 Recall/nDCG 对照达标，不能混用两种向量空间 |
| Rerank | `qwen3-rerank`，候选人 Top-50 | 50 短文档契约成功，长文本预算与限流仍待确认；模型分数不参与硬资格判断 |
| 向量存储 | SQLite 持久化切片元数据、原始 Float32 向量、代际状态 | 保持本机单用户部署；不把向量 BLOB 暴露给普通 Agent |
| 在线向量索引 | 本地 HNSW，优先验证 USearch 的 Windows/Node 24 绑定或独立子进程适配 | 未安装、未验证。支持过滤、持久化、删除及内存计量才可选用；不启用通用 SQLite 动态扩展，不增加外部向量平台 |
| 小集合基准 | 独立 worker 内按块读取 Float32、固定大小 Top-K 堆 | 仅用于≤10,000 切片的资格范围和匿名精确近邻对照；不对十万候选人在 Node 数组中无界扫描 |

切片建议：按主档、教育/工作/项目/技能区块、已确认附件正文分来源，400–800 中文字符、10%–15% 重叠，尽量保持完整句/时间线；内容短于下限不补造。精确来源、区块、原文偏移、content_hash、清洗版本必须保留。主档仅索引岗位/经历等白名单字段；备注、活动、评估、导入批次、职位 JD、人才库描述、联系方式、未确认预览不进入本人能力向量。

清洗必须映射回原文偏移，继承已有附件噪声/血缘处理；不把 `raw_text` 的 opaque token 作为能力文本，也不修改用户留存的 `raw_text`。已确认的视觉内容与确定性证据仍保留来源可靠性标记。

新增独立 `candidate_search_chunks`、`candidate_search_vectors`、`search_vector_generations`、`search_vector_jobs` 比直接复用旧唯一键更清晰；旧预留表保持兼容。新唯一键至少包含 `(chunk_id, content_hash, embedding_space_id)`；空间 ID 包含模型、维度、归一化、切片/清洗版本。记录 provider、必要时供应商模型修订、构建时间；供应商无版本钉住能力时加入固定匿名 canary 漂移检查，不能把同名模型当作永不变化。

维护过程：业务事务只写幂等 dirty/tombstone；网络 Embedding 在事务外运行，返回后 CAS 比较内容哈希/候选人状态。每批最多 10、初始并发 1、限速/退避、取消可恢复；失败不阻断业务 CRUD。新代际 building → validated → ready，文件刷盘与清单完成后原子切换 active 指针；旧代际留作回退。删除/归档先通过资格过滤和 tombstone 立即阻止检索，后台删除切片/ANN 项与快照；不等待重建后才生效。

量级估算仅是算术：若 100,000 位候选人平均 6 切片，600,000×1024×4 字节约 **2.29 GiB**；512 维约 **1.14 GiB**。还不含 HNSW 边、元数据、FTS、WAL、备份和双代际空间。本机 15.8 GiB，因此不能把所有 Float32 BLOB、ANN 和 JS 副本同时常驻；索引量化/磁盘映射和双代际峰值必须实测，未验证前不承诺容量通过。

初始交互预算建议：查询理解最多 8 秒、查询 Embedding 2 秒、本地查询 5 秒、Rerank 2 秒、总体 18 秒；共用截止时间，不逐阶段无限重试，最多并发 2 个查询。理解模型的单次实测已超过 8 秒，因此该模型超时降级会实际发生，是否启用须以匿名完整查询的 p95 与降级率决定。优先优化专用 prompt/输出长度或选择已验证更快模型，不扩大为 Agent 长任务/步骤页面。以上预算是待评测初值，不覆盖已有聊天/附件任务的超时设置。

## 4. 前端保留/修改清单

| 当前区域 | 必须保留 | 允许的修改 |
| --- | --- | --- |
| 主导航 | 现有四个业务入口：工作台、候选人库、人才库分组、职位管理；以及导入候选人、AI 助手、履历检索、附件解析，共 8 个侧栏操作入口及其顺序/用途 | 字体、间距、选中态、边框与焦点可见性；不合并/删减/增加入口 |
| 工具页与主入口 | `/assistant`、`/resume-search`、`/attachment-parser`，现有返回、浏览器前进后退、侧栏收起/移动导航 | 修复页面与抽屉样式作用域及覆盖；不把现有页面改回别的默认展示模式 |
| 候选人库 | 在库/归档/全部范围、列表/职位分组、现有筛选/排序/分页、导入导出、档案、CRUD、批量与关系操作 | 统一密度和按钮层级、长内容换行、滚动区与移动布局；筛选位置/触发习惯保留 |
| 人才库分组 | 左侧分组/右侧成员工作区、分组筛选、成员管理、归档/恢复/删除、现有创建位置 | 调整边界/间距/响应式尺寸，保留独立滚动及窄屏可达性 |
| 职位管理/详情 | 当前列表、状态/筛选/排序/分页、创建编辑、关联/解除、导出、归档删除与详情工作台 | 仅视觉和布局修复 |
| 工作台 | 统计、卡片、快捷入口、原业务跳转与数据口径 | 视觉一致性，不删卡片以减少功能面 |
| 履历检索 | 输入一次直接检索；现有字段/来源/职位/人才库/归档筛选、结果点击打开档案、每页 20 与上一页/下一页 | 增加非阻塞条件摘要、证据展开、完整性/降级说明和重试；保留键盘提交 |
| 聊天/附件/导入 | 持久会话/历史、取消/恢复、Markdown，导入与附件原有确认/差异流程 | 只解决共享样式带来的视觉问题；检索禁止新增向导不意味着删除既有导入确认 |

检索结果组织为：输入框 → 现有筛选 → 一行可换行条件摘要 → 加载/状态 → 候选人结果。条件摘要初次只读即可；可选编辑/移除可通过轻量弹层完成，取消不改变查询，保存直接重新检索，无“确认计划后继续”。

卡片保留点击打开候选人；主要显示当前任职与本人证据摘要，次要显示匹配条件、来源业务名和未知项。“展开证据”与“打开档案”是并列可聚焦控件，不把新按钮嵌入目前包住整卡的 button。排序数字和技术路径不在默认视图露出；故障 code 留于开发诊断/非必需详情。

区分 `idle / loading / success / empty / partial / degraded / error / index_not_ready`。空结果说明实际应用条件，用户自愿点击放宽建议才改条件；异常不显示成功文案，不自动丢弃排除项。初始页不声称“已全量召回”。

筛选选项仍用现有 select：在独立选项请求中按页加载 ID+名称，保持已选项；高数量时分批加载并显示状态/重试，不依赖外层职位页。可新增只读 `/api/resume-search/options?kind=position|talent_pool&cursor=` 返回最小投影；不把新查询框或新选择步骤设为必经。

新检索布局放入 `ResumeSearchPanel.tsx` 和作用域样式，`AssistantDrawer` 继续承载现有 presentation/聊天/附件。保留当前白底与蓝紫主色，收敛字体/间距/边框/焦点 token；状态色与交互色区分，文本对比度≥4.5:1。1440px 保持现有空间组织，768px允许工具栏换行，390px保持单列/现有表格自身滚动；不以全局 overflow:hidden 掩盖溢出。

## 5. 组件删除判定

**当前批准删除清单：空。** 本轮没有运行匿名浏览器场景，无法证明任何组件同时满足“重复、无用途且造成遮挡”。

| 审计对象 | 当前证据 | 判定 |
| --- | --- | --- |
| page/drawer 两种 Assistant presentation | 当前 JSX 条件挂载一份工具页，组件仍支持抽屉使用 | 保留；样式隔离，不以同名类判定重复组件 |
| topbar、移动菜单、桌面侧栏标签 | CSS 按屏宽隐藏部分内容，移动菜单仍有功能 | 保留；复核可达性，不因 display:none 删除 |
| 搜索筛选、详情页签、历史会话、弹窗 | 具有条件渲染和正常交互用途 | 保留；验证展开/关闭/焦点恢复 |
| `sr-only` 文本和文件 input | 提供无障碍命名与上传触发 | 保留 |
| `.modern-*` 样式 | 当前 src 组件引用搜索未命中 | 暂不删除：未证明动态引用不存在，也未证明导致遮挡；死 CSS 与无用组件不是同一问题 |
| `.talent-pool-top-row` 空容器 | JSX 为空且 CSS 隐藏 | 暂不删除：隐藏空容器本身无已证实遮挡，不满足本轮删除条件 |
| 页面 heading 的覆盖规则 | 某些标题/按钮已在当前工作树移位 | 先确认替代控件和全部场景，再局部调整 CSS，不能连带删除业务按钮 |

后续每个删除提议需记录：文件/选择器、所有静态及动态引用、实际挂载数量、触发场景、遮挡前证据、保留替代入口、键盘/三视口回归与删除后证据。缺少任一项则保留并修复样式；不能把“隐藏”作为用途为零的证据。

## 6. 受影响文件

以下均为批准后的拟变更，本轮只新增本方案文件。带“已有修改”的文件以当前工作树为基线局部编辑，逐段复核；不重写整个文件。

| 文件/目录 | 拟职责与修改 |
| --- | --- |
| 新增 `server/search-query-plan.js`、`server/search-query-plan.schema.json` | 规则/模型计划统一、Schema 与语义校验、冲突/unresolved、查询指纹 |
| 新增 `server/search-model-adapters.js` | 三种已测契约、固定出站配置、响应/字节校验、取消、稳定无正文错误码 |
| 新增 `server/search-eligibility.js`、`server/search-evidence.js` | 布尔/资格编译、本人和关联证据范围、偏移与哈希验证、业务投影 |
| 修改 `server/resume-search.js` | 兼容参数适配、候选人级正确召回、旧 GET 语义接入 |
| 修改 `server/business-search.js`（已有修改） | 仅人才检索候选计划/证据查询修复；保留通用全业务检索与现有用户修改，新增边界不继承过宽列政策 |
| 新增 `server/hybrid-search.js`、`server/search-result-snapshots.js` | 双路候选融合、资格复核、重排、完整性/降级与版本分页 |
| 修改 `server/resume-search-service.js`、`server/app.js` | HTTP/worker 共享服务、GET/POST、最小筛选选项、取消与状态 |
| 修改 `server/agent.js`（已有修改） | `search_candidate_resumes` 复用计划与混合服务；不新增工具，不扩大上下文或给规划模型 SQL 能力 |
| 修改 `server/database.js` | 在隔离库设计加法迁移与新向量表/dirty；正式迁移另行批准，迁移本身不调用外部模型 |
| 新增 `server/search-vector-store.js`、`server/search-vector-worker.js`、`server/search-vector-maintenance.js` | 本地向量读接口、HNSW/小集合基准、异步切片和代际管理 |
| 新增 `scripts/search-vector-maintenance.mjs` | 显式数据库路径、匿名/正式隔离、状态/回填/切换；正式回填不是启动副作用 |
| 修改 `src/api.ts`、`src/types.ts` | 增量响应类型、查询取消、条件覆盖与完整选项来源 |
| 新增 `src/components/ResumeSearchPanel.tsx`、`src/components/SearchConditionSummary.tsx`、`src/components/SearchResultCard.tsx`、`src/search.css` | 原位置检索面板、摘要、业务证据与状态样式 |
| 修改 `src/components/AssistantDrawer.tsx`、`src/App.tsx`（已有修改） | 抽取面板、传入独立选项/状态；保留所有当前导航/路由/动作 |
| 修改 `src/styles.css`、`src/preview-theme.css`（后者已有未跟踪文件）、必要时 `src/main.tsx` | 作用域和 token 收敛、三视口遮挡修复，不覆盖整份主题 |
| 条件修改 `TalentPoolPage.tsx`、`PositionTable.tsx`、`CandidateTable.tsx`、`Overview.tsx` | 只在匿名视觉验证确有问题时做最小布局修复；不改功能/默认模式 |
| 修改 `package.json`、`package-lock.json` | 批准后为 JSON Schema 校验/本地向量依赖作必要增量；先验证 Windows/Node24 兼容 |
| 修改 `.env.example`（已有修改） | 仅增加无真实地址/凭据的检索开关与预算说明，检索配置不覆盖 Agent/附件配置 |
| 新增测试与评测文件 | `tests/backend/search-query-plan.test.mjs`、`search-eligibility.test.mjs`、`search-model-adapters.test.mjs`、`search-vector-lifecycle.test.mjs`、`hybrid-search.test.mjs`、`search-result-snapshots.test.mjs`；`tests/fixtures/search-anonymous/`；`tests/evaluation/search-quality.mjs`；`tests/performance/search-hybrid-benchmark.mjs`；`tests/e2e/search-preservation.spec.ts` |
| 复用既有测试 | `resume-search-v6`、`resume-search-api`、`resume-search-service`、`business-search-v8`、`business-search-maintenance`、只读 Agent/附件与字段兼容测试 |
| 更新文档 | `docs/ARCHITECTURE.md`、`docs/API.md`、`docs/AGENT_SECURITY.md`、`docs/TESTING.md`、`docs/OPERATIONS.md`、`docs/README.md`、`README.md`、`CHANGELOG.md`；保持用户已有内容，修正与实现相关的陈旧描述 |

`server/attachment-parser-worker.js`、`server/attachments.js`、`server/attachment-visual-parser.js`、`ImportWizard.tsx` 及其既有匿名测试默认不改；只验证检索消费和样式没有破坏现有契约。`server/readonly-query-worker.js` 默认不扩权，向量不以加载扩展方式接入。

## 7. 分阶段任务

下列命令是**拟实施后的验证命令，本轮未运行**。先写能暴露问题的匿名断言、确认失败，再作最小实现并确认通过；每项独立审阅后继续。新增测试路径须在相应任务创建后运行。

### A. 固化匿名基线与界面功能清单

- [ ] 记录执行时 HEAD、用户修改指纹、Node/SQLite/浏览器、CPU/内存及测试库路径；所有脚本显式绑定新建匿名目录，拒绝正式库、备份库和真实附件目录。
- [ ] 建立 30 条开发查询和固定 60 条验收查询、候选人/证据 qrels 与版本哈希；在旧实现记录全部质量指标，不用六条复现准确率代替总体。
- [ ] 记录 8 个侧栏入口、所有页面路由/展示/筛选/主要操作和当前隐藏用途；使用隔离测试服务采集 1440×900、768×1024、390×844 的基线。
- [ ] 建立评测入口，输出每查询判定与聚合 JSON/CSV；向量和重排尚不存在的基线标为 channel unavailable，不填造结果。

验证入口：`node tests/evaluation/search-quality.mjs --fixture=tests/fixtures/search-anonymous --engine=baseline`。服务端和浏览器测试不使用 `start.ps1`，避免真实启动配置自动生效。

### B. 查询计划与模型适配器

接口：`parseQueryPlan({query, explicitFilters}, {signal, planner}) -> Promise<ValidatedPlan>`，`ValidatedPlan` 为本地校验过的 SearchPlanV1 加服务端 metadata。适配器 `understandQuery`、`embedTexts`、`rerankDocuments` 均接收 AbortSignal，不访问数据库。

- [ ] 六条样例、嵌套逻辑及分支内 NOT、上下限边界、NULL、纯结构化查询、精确短语、显式条件冲突和未消费词建立断言；模型正常、拒绝/无效/SQL 字段/超时都使用匿名替身网关复现。
- [ ] 实现 Schema/语义校验和确定性兜底，核验每条 must/排除都仍在有效计划中。
- [ ] 按实际契约实现批量≤10、index/维度/有限值校验，Rerank results 适配和严格 JSON 响应；网络正文/错误有字节限制并禁止重定向。
- [ ] 使用匿名真实网关复测最终 SearchPlan Schema 的完整关键字子集；成功前不能声称复杂计划已受网关严格约束。

关键断言示例：

```js
assert.equal(plan.must.some(x => x.kind === 'any'), true); // Unity 或 Unreal
assert.equal(plan.must_not.length, 1); // Unity 不要外包
assert.equal(plan.unresolved.length, 0); // 已完整支持的六条样例
assert.equal(JSON.stringify(plan).includes('"sql"'), false);
```

运行：`node --test tests/backend/search-query-plan.test.mjs tests/backend/search-model-adapters.test.mjs`。

### C. 候选人级 FTS 正确性与证据归属

接口：`compileEligibility(plan) -> {sql, parameters}` 仅由服务端调用；`searchEligibleCandidates(plan, {db, budget, signal}) -> CandidateWindow`；`buildEvidence(candidateIds, plan, revision) -> Evidence[]`。SQL 对外不作为模型计划返回。

- [ ] 构造超过旧窗口的噪声文档，唯一合格候选人位于窗口之后；包含不同记录交集、同记录要求、相关职位伪技能、人才库伪技能、归档区块、精确短语跨分片和重复来源。
- [ ] 改为资格范围内候选人级交并差/Top-K，并对全部排除证据执行校验。完善本人字段白名单，保留显式关系检索和全业务记录检索能力。
- [ ] 对照 SQLite 精确 oracle 验证去重/计数/条件成立，记录查询计划、1万/10万容量与主进程可响应性；预算不足返回 partial，不转为无过滤向量。
- [ ] 验证界面与 Agent 同查询、同显式筛选产生同一有效计划与本人证据。

关键断言示例：

```js
assert.ok(result.items.some(x => x.candidate_id === fixture.afterOldWindow));
assert.ok(result.items.some(x => x.candidate_id === fixture.crossRecordMatch));
assert.ok(!result.items.some(x => x.candidate_id === fixture.onlyLinkedJobHasSkill));
assert.ok(!result.items.some(x => x.candidate_id === fixture.excludedOutsourcing));
```

运行：`node --test tests/backend/search-eligibility.test.mjs tests/backend/resume-search-v6.test.mjs tests/backend/business-search-v8.test.mjs`。

### D. 匿名向量索引与生命周期

接口：`VectorStore.search(queryVector, {spaceId, generation, eligibility, k, budget, signal}) -> VectorWindow`，返回 candidate/chunk IDs、distance 和 bounded 状态；`enqueueVectorChanges(changes, transaction)` 不访问网络；`buildGeneration({databasePath, anonymous, signal})` 在事务外处理。

- [ ] 在匿名库验证加法 schema、幂等迁移、旧预留表兼容；取消/重试/CAS、删除/归档/恢复、内容更新、模型维度变化和代际切换失败分别有断言。
- [ ] 验证本地 HNSW 的 Windows ABI、过滤、持久化、删除和空间占用；只为批准的匿名语料生成向量。
- [ ] 按相同标注比较 1024/512、切片大小与 ANN 参数；同时做有界精确近邻 oracle，分开记录 ANN 算法召回和业务 Recall@50。
- [ ] 证明故障时脏向量不返回、旧代际仍可恢复、索引构建不锁住正常候选人写入。未达标就保持正确性已修复的 FTS 通道。

运行：`node --test tests/backend/search-vector-lifecycle.test.mjs`；`node tests/performance/search-hybrid-benchmark.mjs --fixture=anonymous --candidates=10000 --dimensions=1024`，通过后同机重复 100000 和 512 维对照。

### E. 混合融合、重排、分页与降级

接口：`searchTalent(input, {signal}) -> Promise<SearchResponseV1>`；API 和 Agent 均调用该服务，返回兼容字段及增量 metadata。`snapshotStore.create/next` 绑定计划/数据/索引版本并遵守内存预算。

- [ ] 校验候选人级 RRF、硬条件前后复核、Top-50 证据包、重复/越界 rerank index 与超字节错误。
- [ ] 实现首轮冻结排序与兼容深分页；连续翻页无重复/遗漏，筛选编辑归零，旧请求取消不覆盖新结果；索引或候选人修订后游标明确失效。
- [ ] 对模型、Embedding、ANN、Rerank、FTS 各故障注入，逐项验证条件守恒、证据归属、响应完整性和 fallback。全部失败不得返回“成功空列表”。
- [ ] 增量接入 API/Agent，保留原工具名、上下文限额、旧 API response 字段和本机只读边界。

```js
assert.equal(new Set(allPages.map(x => x.candidate_id)).size, allPages.length);
assert.equal(staleResponse.error.code, 'search_snapshot_stale');
assert.equal(fallback.completeness.ranking, 'rrf');
assert.ok(fallback.items.every(x => fixture.hardEligibleIds.has(x.candidate_id)));
```

运行：`node --test tests/backend/hybrid-search.test.mjs tests/backend/search-result-snapshots.test.mjs tests/backend/resume-search-api.test.mjs tests/backend/resume-search-service.test.mjs`，并运行相关 Agent/readonly 回归。

### F. 原位置前端优化与三视口验收

- [ ] 在当前入口抽取检索面板，先记录现有展示/导航操作，再接入新状态与结果；实现独立筛选选项来源，不依赖 App 当前分页。
- [ ] 增加非阻塞摘要/证据/降级/重试，拆分整卡按钮避免嵌套交互，明确空状态与首次状态；保留所有原操作。
- [ ] 按组件用途审计覆盖规则，修复三视口布局和焦点；删除清单仍按第 5 节逐项取证，未取证不删除。
- [ ] 检查输入→直接结果、8 个侧栏入口和全业务功能矩阵、三视口元素命中/滚动/键盘/对话框焦点；保留匿名截图与控制台报告。

浏览器断言包括：

```js
expect(primaryNavigationItems).toEqual(baseline.primaryNavigationItems);
expect(requiredQueryConfirmationCount).toBe(0);
expect(rootScrollWidth).toBeLessThanOrEqual(viewportWidth);
expect(blockedInteractiveControls).toEqual([]);
expect(criticalConsoleErrors).toEqual([]);
```

拟运行：`npx playwright test tests/e2e/search-preservation.spec.ts`（在本任务增加可复现测试配置后）；`npm run build`。

### G. 联合验收、报告和后续发布提案

- [ ] 对同一固定匿名集比较旧基线、修复规则+FTS、模型+FTS、增加向量、再增加重排；记录全部指标、每个关键子集和置信区间，不只挑成功查询。
- [ ] 记录冷热、并发、取消、索引更新、慢网关与失败降级；未执行或不通过项保留，不能用历史结果补齐。
- [ ] 运行完整 `npm test`、`npx tsc --noEmit`、`npm run build`、`npm audit --audit-level=low`、服务端语法检查和 `git diff --check`。已知失败需 fresh 复现与归因；未解决的必要门禁不能称为通过。
- [ ] 更新实现涉及的文档，交付匿名质量/性能/前端报告。准备正式迁移、备份、空间和回退清单，但不执行正式迁移/回填/部署；正式授权单独取得。

## 8. 评测指标与验收门槛

### 8.1 固定匿名集合

拟建 30 条开发查询与 **60 条独立验收查询**，验收集组成：6 条指定查询、18 条中文/英文改写、12 条 AND/OR/NOT/精确短语、8 条跨记录/关联伪命中、8 条归档/删除/分页/索引变化、8 条未知/冲突/否定作用域/提示注入。六条指定输入必须原样保留，改写不替代原样。

每条查询保存人工审阅的计划 gold、全体合格候选人 ID、0–3 级 relevance、精确证据来源/偏移与困难负例。0=不合格/无本人证据，1=弱相关且未充分支持，2=合格并有清晰本人证据，3=高度相关且证据充分。任何硬条件失败或仅关系技能命中强制为 0。不得让被评模型自行产生其唯一评分标准。

质量语料全部合成、ID/电话/邮箱虚构，不从真实库抽样或改名脱敏。包含年限 0/2.99/3/3.01/5/5.01/NULL、当前上海但意向异地及反向样例；Unity-only/Unreal-only/both/neither；本人外包/关联 JD 外包/明确否定/不明公司性质；战斗程序开发但无策划证据的困难负例。

特殊断言：同候选人不同经历可交集、不同候选人不可；同记录要求不跨履历拼接；职位/分组-only 技能不得合格；归档候选人/区块/附件按范围控制；新建/更新/删除、索引 pending/切换使游标稳定或明确失效；超过旧 10,000 文档窗口的唯一合格者可召回；重复导入不额外加分。

### 8.2 必须实际记录的指标

| 指标 | 计算与报告口径 | 推荐门槛（待批准的目标，不是实测结果） |
| --- | --- | --- |
| 条件解析准确率 | 全计划语义 exact-match/全部查询；另报 must/OR/排除/范围/地点/短语/unresolved 的 precision/recall | 固定硬条件回归 100%；60 条总体≥95%；不得丢显式排除 |
| Recall@50 | Top-50 中 grade≥2 数 / 全体 grade≥2 数，候选人去重后计算 | 不低于旧基线及修复 FTS；重点错误子集改善；目标≥0.90 |
| Precision@10 | Top-10 中 grade≥2 数 / 10；少返回按缺位计，不把分母缩小来提高分数 | 全体报告；至少有 10 个正例的标准子集目标≥0.80，困难/稀疏查询单报 |
| nDCG@10 | 按 0–3 relevance、gain=`2^rel-1`、log2 折损、同一 qrels 理想排序 | 总体不回退，目标≥0.85；记录各阶段增量 |
| MRR | 第一个 grade≥2 候选人的倒数排名，未找到为 0 | 不回退，目标≥0.90 |
| 证据归属准确率 | 来源候选人、记录、字段、原文片段和能力/关系类型全部正确的证据 / 全部展示证据 | 100%；关系伪技能 0 条，伪造/错人证据 0 条 |
| 硬条件违规率 | 返回“条件匹配”候选人中任一硬条件/排除失败的比例 | 0%，同时单报 unknown/partial 数量 |
| 延迟 | 端到端及解析/过滤/FTS/向量/融合/重排的 p50/p95，包含失败、排队与降级 | 本地关键词 p95≤2s、复杂本地≤5s；完整混合交互目标 p95≤10s，总截止18s；不达标则不启用该模型配置 |
| 内存 | 主进程/worker/索引进程采样峰值 RSS、同时间整组峰值、快照和构建峰值 | 查询路径目标≤2 GiB，构建≤4 GiB；主进程不得装载全库数组；以本机其他负载复核 |
| 索引体积 | SQLite 业务/FTS/向量新增字节、ANN 文件、WAL、旧/新代际及构建临时峰值分列 | 满足可用磁盘及备份/双代际预算；512 与1024 实测比较，不把算术估算填为结果 |
| 降级成功率 | 注入故障后在预算内返回正确回退/真实失败状态，保留硬条件、证据及 UI 提示的次数 / 注入次数 | 指定故障矩阵100%；另报健康网关自然降级率，不能以频繁降级掩盖选型不可用 |

无正例查询的 Recall/nDCG/MRR 按预先定义口径标记 N/A、报告数量并独立评估零结果正确率，不能悄悄剔除失败查询。相关性未知不是负例；标注不完整的 query 不进入比较，需补全并记录原因。bootstrap 95% 置信区间辅助解释差异，不把微小浮动宣称为提升。

性能在同一机器、代码、固定种子下，1万/10万匿名候选人各测：5 次新进程、30 次预热运行及并发 1/2；新进程冷缓存不等于清除 OS 磁盘缓存，报告明确区分。100ms 间隔采样 RSS，并记录 Node/SQLite/ANN/模型、维度、切片数、模型用量、总调用数、错误与索引版本。质量集使用真实匿名文本的实际 Embedding；随机/复用向量只能用于标注清楚的容量实验，不能作为语义质量或真实分布容量通过的证据。大规模真实匿名 Embedding 的调用费用待确认，费用不足时如实保留未完成门禁。

故障矩阵至少包括：规划 timeout/429/5xx/无效 Schema；Embedding timeout/批量超限/错误维度/NaN/漏项；向量索引缺失/陈旧/损坏/不兼容；Rerank timeout/重复或越界 index/漏项；FTS未ready/SQLITE_BUSY/worker超时；用户取消、旧响应迟到、分页索引变化。每类至少 5 次，局部失败不能暗中放宽查询。

前端验收每个视口都覆盖：导航/入口数量用途不变；列表/分组/筛选/归档/排序/分页/CRUD/导入导出/关系/详情/助手/附件原功能；输入直接出结果无计划确认；条件摘要/证据/重试不阻塞；输入法组合输入不误提交；长中文与英文不溢出；活动控件不被遮罩/absolute元素盖住；滚动后按钮可达；键盘焦点可见、弹窗可关闭并回到触发位置；aria-live 无重复轰炸；关键 console error、未处理异常和意外 4xx/5xx 为 0。记录全部控制台警告并解释，不以截图代替交互断言。

### 8.3 本轮测量状态

本轮已实际记录：六条解析复现 0/6，以及第 1.2 节接口状态、格式、维度、批量边界和单次耗时。**60 条总体解析准确率、Recall@50、Precision@10、nDCG@10、MRR、证据归属准确率、服务延迟分位数、运行峰值内存、实际索引体积、降级成功率和浏览器验收均未运行。**

原因是用户本轮只批准只读探针与方案，尚未批准实现/匿名索引与评测工程。最终实施报告必须填入真实执行数值与匿名产物链接；缺一项即不能声称完整验收。建议产物为 `docs/evidence/search-quality-<执行日期>.json`、`search-performance-<执行日期>.json`、`search-frontend-<执行日期>.md`；日期在执行时确定，不把未来路径冒充已存在结果。

## 9. 回退方案

1. 三个服务端独立开关：查询模型、向量召回、Rerank。Rerank 故障回退候选人 RRF；Embedding/ANN 故障回退**同一已验证计划**的正确性 FTS；理解模型故障回退修复后的规则计划并显示 unresolved。不能回退到“min=5/丢排除”的旧解析器。
2. FTS 不可用但向量可用：仅在所有硬条件/排除能够由可信结构化/本人证据校验时返回有界结果；否则返回 index_not_ready/明确失败，保留输入和可重试状态。禁止读取全库正文外发模型，也不展示“成功无结果”。
3. 回退不重新解释显式硬条件；结果若条件未完全执行必须标 partial，不允许显示完整合格。用户取消始终停止当前查询，不自动重试恢复已取消操作。
4. 索引失败只取消构建代际；active 指针保留已验证旧代际。切换回旧代际仍使用当前数据状态/tombstone过滤，不能恢复已删除/归档的命中。旧查询快照同步作废。
5. 数据库迁移保持加法；旧向量预留表保留。正式切换前备份同一时点 SQLite 文件集与兼容索引清单，并在恢复副本演练。若正式旧代码不兼容新 schema，回退需要同时恢复代码/数据库/索引清单；不能仅 checkout 旧代码或只拷贝主 `.db`。
6. UI 采用面板级可切换实现和独立 CSS。回退仅撤销本任务新增改动，不 git reset/整文件覆盖用户已有主题、工具页、附件和 Agent 修改；原 8 个入口及现有功能始终保留。
7. 当前方案不停止现有服务、不执行正式备份/恢复、不迁移/重建正式索引，也不部署。正式回退演练和发布仍是单独授权范围。

## 10. 待确认依赖

| 依赖 | 当前状态 | 阻塞范围与建议 |
| --- | --- | --- |
| 本方案批准 | 本轮尚未批准实施 | 批准后可进行匿名实现/测试；不包含真实候选人、正式回填/迁移/部署 |
| 查询理解模型质量和延迟 | gpt-6-astra 契约通过但 13.374 秒慢样例存在；terra 两次502 | 先完成规则+FTS；模型开关须经匿名质量/延迟门禁再启用，不拿列表可见当可用 |
| Embedding/Rerank 服务限制 | 10条批量、1024/512维、50文档短包已验证 | 供应商 token/字节上限、长包、QPS、费用及模型版本/保留策略仍待提供或匿名验证；不预先批量生成10万级向量 |
| 本地 ANN 实现 | Windows/Node24 尚未安装/验证 | 先验证预编译、过滤、删除、持久化与内存；不满足则保留FTS并报告向量阶段未完成，不自动引入大型本地模型或外部平台 |
| 匿名 qrels 审阅 | 尚未建立60条固定集 | 准确率与排序质量的正式门禁依赖完整标注；建议由业务使用者复核概念等价/外包作用域等歧义样例 |
| 默认语义 | 本文建议“裸上海=当前所在地”“以下含3”“不要外包=本人证据范围” | 随方案审阅确认；摘要可选修改，不给日常搜索增加必经确认 |
| 既有用户修改的安全/文档差异 | 非BLOB列放行、网关错误正文及部分超时记录不一致 | 新检索先独立收口；正式发布前需明确如何修正通用Agent/文档，不在本轮擅自回滚 |
| 浏览器和容量环境 | 本轮未连接应用/浏览器、未评估磁盘余量 | 批准后使用独立端口、匿名DB、匿名替身网关和三视口实测；保留真实数据隔离 |
| 正式候选人外发与上线 | 本轮明确未授权 | 日后另行确认字段/文本范围、网关留存/地域/训练/删除、费用、备份空间、迁移窗口与回退点 |

本轮交付范围到本方案与匿名能力记录为止。后续实施从 A 开始，逐阶段产出可审阅差异和真实测量结果。
