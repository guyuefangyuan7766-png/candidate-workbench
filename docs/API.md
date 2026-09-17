# 本地 API 参考

## 2026-09 人才检索增量（应用 0.2.0 / schema V13）

正式本机服务沿用 0.2.0 / V13；远程混合检索补充的实际启用、索引与验收状态见 [补充交付](handoffs/2026-09-10-search-hybrid-formal-supplement.md)。开关、配置完整和索引可用是不同状态，不能只凭开关判断成功。

`GET /api/resume-search/status` 保留既有本地索引状态，新增 `hybrid` 与 `vector_maintenance`。`hybrid.model` 为远程开关/配置布尔值；`hybrid.vector` 包含 available、loaded、current、generation、chunks、vectors、dimensions、memory_mapped；`hybrid.worker` 包含 ready、active、queued、max_queue 和 query_budget_ms。`vector_maintenance` 包含 enabled、**schedule、boot_marker、ran_this_boot**、running、state、last_success、脱敏计数和稳定错误码；调度自 `0.4.0` 起为「每个开机周期执行一次」，不再返回 `interval_ms`（`SEARCH_VECTOR_MAINTENANCE_INTERVAL_MS` 不再参与调度）。状态不含网关、密钥、数据库路径或候选人正文，配置布尔值不是最近请求成功率。

单常驻检索 worker，默认最多排队 8 项；新查询默认 18 秒总预算，满队列返回 `search_busy/429`，超时 `search_timeout/504`，取消 `search_cancelled/499`。数据或向量代际改变时游标返回 409，客户端保留输入并允许直接重试。前端仍是输入框加结果，所有条件摘要/降级/完整性信息均非阻塞。

`GET /api/resume-search` 和 `POST /api/resume-search` 共用结构化查询计划，POST 使用 JSON body。保留 `q/query`、`keywords`、`phrases`、`match_mode`、字段/来源/职位/人才库/归档筛选和分页；客户端不接受 `plan` 或 SQL。

结果保留 `items/pagination`，增加 `condition_summary`、`completeness`、`degradation`。证据的 `source_label/ownership/match_kind` 表达业务来源、本人归属和等价命中；分数仅作相对排序。`search_candidate_resumes` 工具复用相同执行器，通用业务记录查询仍用 `search_all_records`。

`GET /api/resume-search/options?kind=position|talent_pool&page=1&page_size=100` 独立返回全部活动筛选选项，每页最多100项。

游标绑定查询、筛选、页大小、缓存排序、数据库修改和向量代际，有效期5分钟。每页返回 `pagination.current_cursor`，返回第一页也复用该凭据；下一页使用 `next_cursor`。数据变化返回 `409 search_cursor_stale/search_index_changed`，过期后重新检索。取消返回 `search_cancelled`；worker最多并发2、45秒预算。页面旧结果在重试期间保留，但明确显示状态。

兼容原 `stage`、`include_archived`、`evidence_limit`、camelCase 年限/字段/职位/页大小别名。阶段为硬条件，`evidence_limit` 为1至5。查询理解默认最多30秒（`SEARCH_QUERY_TIMEOUT_MS`只可缩短），查询Embedding及Rerank每请求最多5秒；客户端48秒。原18秒总体和10秒p95目标未通过；正式启用保留这些预算并以明确降级交付，不把未达性能门禁伪装成完整混合成功。

`SEARCH_REMOTE_ENABLED=false` 为默认值，远程理解/Embedding/Rerank 需要显式启用。补充前“正式数据外发和向量回填另行安排”是历史状态；2026-09-17 第十三轮增量维护改造后，正式 generation 为 `generation-2dfa743f-c1b4-4e41-8d9f-3d61c963e78a`，维护状态为 `ready`，共 `429,630` 文档和 `630,978` vectors。未配置或未 ready 的向量仍返回明确本地降级，不能声称语义检索可用；最新匿名质量中仍有正常降级和 p95 `14,821.83ms`，详见补充交接记录。

## 使用边界

默认基地址为 `http://127.0.0.1:4173/api`。当前 API 只服务本机单用户版，没有认证、RBAC、字段级权限或租户隔离，不应通过代理或端口转发对外暴露。要转为部门共享软件，必须先增加服务端身份和权限边界。

浏览器写请求还有一层 Origin 边界：除 `GET` / `HEAD` 外，服务端在 `express.json()` 和 multipart 解析器之前检查 `Origin`。缺少 `Origin` 的本机客户端、回环 Origin 和 `CORS_ORIGIN` 明确追加的 Origin 可以继续；其他 Origin 的写请求以及不允许的预检请求直接返回 `403 origin_not_allowed`，请求体不会进入 JSON 或附件解析器。这是本机版的跨域写入收口，不是认证、RBAC 或面向多人部署的 CSRF 防护。

正常接受并进入应用响应链的请求会设置 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`，以及包含 `default-src 'self'`、`base-uri 'none'`、`object-src 'none'` 和 `frame-ancestors 'none'` 的 Content Security Policy。前置 Origin 拒绝和请求体解析错误不应被表述为必然携带完整的应用响应头集合。

统一 JSON 错误：

```json
{
  "error": {
    "code": "validation_error",
    "message": "字段校验失败",
    "details": []
  }
}
```

常见状态码：`400` 参数错误，`404` 不存在，`409` 重复或冲突，`413` 大小/数量超限，`415` 文件类型不支持，`422` 字段校验失败。

## 基础端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | SQLite 连通性和服务时间 |
| GET | `/stages` | 旧全局招聘阶段，仅作兼容 |
| GET | `/dashboard` | 候选人、职位和人才库统计 |
| GET | `/agent/status` | Agent 配置状态、模型名、只读标志和工具名 |
| GET | `/candidates/import/config` | 候选人批量导入当前字节上限、预览条数、格式和资源限制；兼容路径 `/import/config` |

`GET /dashboard` 保留历史字段 `by_stage`，新界面和 Agent 不应使用它。人才库统计位于：

```json
{
  "talent_summary": {
    "by_pool": [{ "id": "pool-id", "name": "Engineering", "color": "#2563eb", "count": 12 }],
    "by_education": [{ "education": "硕士", "count": 8 }],
    "by_job_seeking_status": [{ "status": "在看机会", "count": 5 }],
    "unassigned_pool_count": 3
  }
}
```

其他仪表盘字段包括 `totals`、`by_source`、`recent_candidates`、`position_totals`、`positions_by_status`、`recent_positions`、`unassigned_candidates` 和 `recent_update_count`。

## 候选人

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/candidates` | 分页查询，响应含 `positions` 和 `talent_pools` |
| POST | `/candidates` | 新建候选人 |
| GET | `/candidates/:id` | 候选人详情与关联资料 |
| GET | `/candidates/:id/avatar` | 校验候选人照片 URL 后返回 `302` 跳转 |
| PATCH | `/candidates/:id` | 更新允许的候选人字段 |
| POST | `/candidates/:id/archive` | 软归档 |
| POST | `/candidates/archive-batch` | 事务式批量软归档，1 至 100 个候选人 |
| POST | `/candidates/:id/restore` | 恢复 |
| POST | `/candidates/permanent-delete/preview` | 预览 1-100 位已归档候选人的删除影响并签发一次性 token |
| POST | `/candidates/permanent-delete/commit` | 使用 `preview_token` 原子提交单条或批量删除 |
| POST | `/candidates/:id/permanent-delete/preview` | 单条候选人预览兼容路径 |
| POST | `/candidates/:id/permanent-delete` | 单条候选人提交兼容路径；body 仍只携带 `preview_token` |
| GET | `/candidates/:id/positions` | 查询关联职位 |
| PUT | `/candidates/:id/preferences` | 整体新建或更新求职偏好 |
| PUT | `/candidates/:id/profile-sections` | 事务式替换当前资料区块，旧区块软归档 |
| GET/POST | `/candidates/:id/notes` | 查询/添加备注 |
| GET | `/candidates/:id/activities` | 查询活动 |

### 列表查询

`GET /candidates` 支持：

- `page`、`page_size`，默认 1 和 20，每页最多 100。
- `archived=include|only|exclude`。
- `search`、`source`、`owner`、`source_system`、`tag`。
- `position_id=<id>` 或 `position_id=unassigned`。
- `pool_id=<id>` 或 `pool_id=unassigned`。
- 精确筛选 `education`、`school`、`major`、`gender`、`job_seeking_status`；`gender` 规范化并只接受 `男|女|其他|未说明` 及受支持别名。
- 兼容参数 `stage`；新界面不应发送。
- `sort=name|created_at|updated_at|stage|current_company|years_experience|education|highest_school|highest_major|job_seeking_status|resume_updated_at`。
- `order=asc|desc`。

`years_experience` 排序只使用可安全解释的数值投影；未知文本和空值的投影为 `null`，不会被转换成 `0`。

`search` 只检索非敏感人才字段：姓名、公司、当前任职、地点、负责人、来源、学历、学校、专业、求职状态、标签和关联职位名称。它不检索电话、邮箱、期望薪资、原始行、历史评估或授权内容。LIKE 通配符按普通字符处理，标签筛选按 JSON 数组元素精确匹配。

V7 候选人页面从筛选区移除“专业”并增加“性别”，性别选择会调用上述服务端参数化查询；分页总数和导出使用同一条件。`major` 查询参数仍保留给旧客户端，专业字段、导入、详情和导出没有删除。

候选人列表默认不返回：

`phone`、`email`、`photo_url`、`expected_salary`、`source_record_id`、`import_batch_id`、`self_summary`、`stage`。

有证件照的候选人只返回 `has_photo: true`。该布尔值不包含远程主机、路径或签名查询参数。

列表和导出排序都追加 `id ASC` 作为稳定次级键。

### 归档、恢复与永久删除

批量归档请求：

```http
POST /api/candidates/archive-batch
Content-Type: application/json

{ "candidate_ids": ["candidate-1", "candidate-2"] }
```

输入数组最多 100 项，每项为 1 至 200 字符的 ID；服务端先去重。任一候选人不存在、已经归档或状态在事务中变化时整批失败，不部分写入。成功响应包含 `input_count`、`requested_count`、`duplicate_input_count`、`archived_count` 和 `archived_ids`。

永久删除分为一次预览和一次提交；不再要求输入确认词：

```http
POST /api/candidates/permanent-delete/preview
Content-Type: application/json

{ "candidate_ids": ["candidate-1", "candidate-2"] }
```

```json
{
  "preview_token": "opaque-one-time-token",
  "expires_at": "2026-08-05T12:02:00.000Z",
  "candidate_count": 2,
  "impact": {
    "irreversible": true,
    "attachment_count": 1,
    "position_relation_count": 3,
    "talent_pool_relation_count": 2,
    "deletes": [],
    "preserves": ["共享职位", "共享人才库", "导入批次"],
    "boundary": "不影响北森等来源系统、既有导出副本和历史备份"
  }
}
```

提交：

```http
POST /api/candidates/permanent-delete/commit
Content-Type: application/json

{ "preview_token": "opaque-one-time-token" }
```

- 输入去重后必须为 1-100 个 ID；候选人必须全部存在且已归档，否则返回 `409`。
- 默认 token 有效期 2 分钟，只能使用一次，并绑定操作类型、排序后的候选人 ID 和预览时 `updated_at`。
- 提交在 `BEGIN IMMEDIATE` 事务内重新校验全部存在性、归档状态和版本；任一目标异常，整批不删除。过期、跨操作或重放 token 同样返回 `409`。
- 单条兼容路径 `/candidates/:id/permanent-delete` 还要求 URL `:id` 与 token 快照的唯一候选人完全一致；批量 token 或其他候选人 token 返回 `409 deletion_preview_target_mismatch`。职位单条路径执行同等校验。
- 成功响应含 `deleted`、`deleted_count`、`candidate_ids`、`deleted_at`、`audit_ids` 和 `attachment_cleanup_queued_count`；单条时兼容返回 `candidate_id` / `audit_id`。
- 删除清除候选人主档及全部从属记录、附件元数据和检索索引，并在事务内把物理附件加入清理队列；共享职位、人才库和导入批次保留。审计只含候选人 ID 哈希与时间。

永久删除只影响当前应用数据库，不能删除北森等来源系统记录、既有导出副本或历史数据库备份。

### 详情与敏感投影

`GET /candidates/:id` 默认返回主资料、备注、活动、职位、人才库、非高敏资料区块、求职偏好安全投影，以及来源/评估/授权/申请记录的安全元数据。

默认不返回电话、邮箱、`photo_url`、期望薪资、高敏资料区块、高敏评估值、授权值或任何 `raw_payload`。有照片时返回 `has_photo`；有原始值的子记录会返回 `raw_payload_available: true`。

```text
GET /api/candidates/:id?include_sensitive=true
```

只有显式传入 `include_sensitive=true` 才返回完整联系方式、原始 `photo_url`、薪资、高敏区块和已解析的 `raw_payload` JSON。该开关只支持单值 `true|false`。

头像显示使用：

```text
GET /api/candidates/:id/avatar
```

候选人或有效照片不存在时返回 `404`；有效地址必须使用 HTTP/HTTPS 协议，URL 路径必须以 `.jpg`、`.jpeg`、`.png` 或 `.webp` 结尾，允许签名查询参数。成功时返回 `302`，并设置 `Cache-Control: private, max-age=300`、`Referrer-Policy: no-referrer` 和禁止搜索索引的响应头。当前端点不代理或保存图片字节，浏览器仍会访问远程照片地址。

```text
GET /api/candidates/:id?include_legacy_stage=true
```

`include_legacy_stage=true` 单独返回旧 `stage`。`include_sensitive=true` 不会自动开启旧阶段。这两个开关在当前无认证版本中不等于权限控制，部署为多用户服务前必须加入身份与字段权限。

备注和活动为现有详情功能，默认仍随候选人详情返回，不受 `include_sensitive` 开关控制。备注可能由用户写入个人信息，多用户版需在服务端另行施加备注查看权限；V6 Agent 可按用户问题通过独立只读连接读取备注和活动。

### 候选人写入字段

除旧有姓名、联系方式、当前经历、地点、工作年限、学历、来源、负责人、标签和血缘字段外，`POST/PATCH /candidates` 还支持：

- `highest_school`、`highest_major`
- `gender`：规范化为 `男|女|其他|未说明`
- `birth_date`：有效且不晚于今天的完整日期，规范化为 `YYYY-MM-DD`
- `age`：0 至 120 的整数；用于缺少完整出生日期时的来源年龄回退
- `job_seeking_status`
- `resume_updated_at`
- `self_summary`
- `photo_url`：高敏字段，只接受不超过 2048 字符、协议为 HTTP/HTTPS 且路径以 `.jpg`、`.jpeg`、`.png` 或 `.webp` 结尾的 URL；允许签名查询参数

#### 工作年限字段（V13）

`POST /api/candidates`、`PATCH /api/candidates/:id`、候选人详情、导入预览和 CSV/XLSX 导出使用以下契约：

| 字段 | 方向 | 约束 |
| --- | --- | --- |
| `years_experience` | 请求/响应 | 请求兼容数字或文本；响应为 `number \| null` 的数值投影。仅无歧义且有限非负的值产生数值，不能用 `Number(value ?? 0)` 把未知或缺失改为 `0`。 |
| `years_experience_raw` | 响应 | `string`；保存非空来源文本，没有来源值时为 `''`。它不是普通客户端可独立伪造的写入字段，导入、附件和 API 输入都经统一校验生成数值/原文对。 |
| `years_experience_display` | 响应 | 计算字符串：原文非空时为原文，否则为格式化数值；两者没有时为 `''`。用户界面不得显示字面量 `null`。 |

明确 `0` 的响应保持数值 `0`、原文 `0`、展示 `0`；未知文本如 `经验不详` 保留原文、数值为 `null`；显式空字符串 PATCH 清空为原文 `''` 和数值 `null`。未提供字段的增量更新不改动已有工作年限。工作年限格式本身不产生行错误，电话/邮箱格式或身份冲突仍按各自规则返回错误/冲突。

#### 入职信息字段（V12）

`POST /api/candidates`、`PATCH /api/candidates/:id`、候选人详情和 CSV/XLSX 导出支持以下三个字段：

| API 字段 | 中文标签 | 输入/响应约束 |
| --- | --- | --- |
| `hire_position` | 入职职位 | 可空文本；去首尾空白后保留非空原文，最长 300 个字符；它是入职事实，不是招聘职位关联键 |
| `hire_status` | 入职状态 | 可空文本；去首尾空白后保留非空原文，最长 200 个字符，不强制固定枚举 |
| `hire_date` | 入职日期 | 可空；REST/结构化 JSON 仅接受 ISO、斜线或中文年月日文本，校验真实日期后统一响应/落库为 `YYYY-MM-DD`；允许未来日期 |

示例：

```json
{
  "name": "候选人示例",
  "hire_position": "游戏服务端开发工程师",
  "hire_status": "待入职",
  "hire_date": "2026-09-17"
}
```

成功的详情响应包含三个字段；各空值返回 `null`。非法日期（例如 `2026-02-30`）、超过 200 个字符的状态或超过 300 个字符的入职职位返回统一 `422 validation_error`。当 `hire_date` 有值而 `hire_status` 为空时，写入层自动保存精确状态 `不确定`；已有明确状态不会被日期补写覆盖。对已有候选人执行 PATCH 时，未提供字段保持原值；导入更新中的空日期、空状态和空入职职位也不会清除已有值。

Excel 数值日期只在 `.xlsx`/`.xlsm`/BIFF8 `.xls` 文件解析边界按 Excel 1900 日期系统转换；REST、结构化 JSON、附件建议以及 CSV 中形似序列号的文本均拒绝数值日期。这样既保留真实工作簿日期单元格，也避免普通 API 数字被误解释为日期。

档案只在 `hire_position`、`hire_status`、`hire_date` 至少一项有值时展示“入职信息”区块；三项全空时仅隐藏该区块，不隐藏候选人主档。`hire_position` 不读取或写入 `candidate_preferences.employment_status`，也不参与 `candidate_positions` 关系。

这三个字段不读取或写入 `candidate_preferences.employment_status`，也不会把旧 `candidates.stage` 自动映射为入职状态。导出中文列名为 `入职职位`、`入职状态`、`入职日期`，并与候选人其他导出字段保持同一行。

`stage` 仍可写入以兼容历史客户端，但新人才库界面不应用它组织工作。去重使用标准化邮箱、电话或 `source_system + source_record_id`，绝不只按姓名。

`source_record_id` 是外部来源候选人编号；北森轮廓把大小写准确的“应聘者ID”写入该字段。候选人详情可以把它显示为“应聘者编号”，不得用内部 `candidates.id` UUID 替代。详情同时返回 `gender`、`birth_date` 和数值型 `age`；界面有完整生日时按当前日期计算展示年龄，否则回退到保存的 `age`。

schema v4 会为既有候选人执行一次非破坏性照片回填：仅当 `photo_url` 为空时，从既有候选人来源记录中的“证件照”读取并执行相同的协议与图片路径扩展名校验；它不开放新的外部 API，不覆盖已有照片，活动记录也不包含 URL。

### 求职偏好

```http
PUT /api/candidates/:id/preferences
Content-Type: application/json

{
  "employment_status": "在看机会",
  "desired_titles": ["Platform Engineer"],
  "desired_locations": ["上海"],
  "employment_type": "全职",
  "expected_salary": "30k-40k",
  "availability": "30 天",
  "raw_payload": {}
}
```

职位和地点各最多 50 项；`raw_payload` 必须是 JSON 对象。写入会记录 `preferences_updated` 活动。

### 资料区块

`section_type` 的 canonical 值为 `education|experience|project|internship|skill|campus|language|certificate|award|training|publication|management|other`。解析器和旧客户端的 `education_experience`、`work_experience`、`project_experience`、`skills`、`additional_information` 等别名只在输入边界兼容，服务端始终持久化 canonical 类型；`self_summary`/`resume_summary` 写入 `candidates.self_summary`，不重复提交为履历区块。

```http
PUT /api/candidates/:id/profile-sections
Content-Type: application/json

{
  "sections": [
    {
      "id": "optional-existing-id",
      "section_type": "experience",
      "title": "工作经历",
      "content": "...",
      "structured_data": {},
      "sort_order": 0,
      "sensitivity": "internal",
      "source_record_id": "optional-source-id"
    }
  ]
}
```

单次最多 100 个区块；`sensitivity` 支持 `public|internal|high`。请求是整组替换，未重用的旧区块软归档。

附件创建正文可携带 `profile_sections`；单文件/批量创建会把候选人、头像和确认的履历区块放在同一事务提交。附件生成的 `source_system=attachment_preview` 和 `attachment-preview:<preview>:<record>` 仅用于幂等与审计，不是外部候选人编号。偏好仍通过 `/candidates/:id/preferences` 保存，失败时客户端可重试而不会重复创建候选人。

## 人才库

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/talent-pools` | 分页查询 |
| POST | `/talent-pools` | 新建 |
| GET | `/talent-pools/:id` | 详情 |
| PATCH | `/talent-pools/:id` | 更新 |
| POST | `/talent-pools/:id/archive` | 软归档；V6.1 UI 携带版本，兼容旧无版本调用 |
| POST | `/talent-pools/archive-batch` | 按版本事务式批量归档，最多 100 个分组 |
| POST | `/talent-pools/:id/restore` | 恢复；V6.1 UI 携带版本，兼容旧无版本调用 |
| POST | `/talent-pools/restore-batch` | 按版本事务式批量恢复，最多 100 个分组 |
| POST | `/talent-pools/:id/permanent-delete` | 按版本永久删除单个已归档分组 |
| POST | `/talent-pools/permanent-delete-batch` | 按版本事务式永久删除最多 100 个已归档分组 |
| GET | `/talent-pools/:id/candidates` | 分页查询库内候选人 |
| POST | `/talent-pools/:id/candidates` | 批量加入 |
| DELETE | `/talent-pools/:id/candidates` | 批量移出 |

人才库字段为 `name` （1 至 200 字符）、`description` （最多 5000 字符）和 `color` （`#RRGGBB`）。名称大小写不敏感唯一；`candidate_count` 由查询时计算。

`GET /talent-pools` 支持 `search`、`archived`、`page`、`page_size`、`sort=name|created_at|updated_at|candidate_count` 和 `order`。

批量归档、恢复和永久删除使用同一版本绑定请求结构：

```json
{
  "records": [
    { "id": "pool-1", "expected_updated_at": "2026-08-05T12:00:00.000Z" },
    { "id": "pool-2", "expected_updated_at": "2026-08-05T12:00:01.000Z" }
  ]
}
```

`records` 必须包含 1 至 100 个互不重复的分组；ID 和 `expected_updated_at` 都不能为空。服务端在单个 SQLite 事务中重新校验所有分组的存在性、归档状态和版本。归档只接受活动分组；恢复和永久删除只接受已归档分组。任一目标缺失、状态不符或版本变化时返回 `409`，整批不写入；超过 100 个返回 `413`。

V6.1 前端对单条归档、恢复和永久删除都发送 `{ "expected_updated_at": "..." }`。服务端对所有批量操作和单条/批量永久删除强制要求版本；为兼容 V6 客户端，旧单条归档/恢复路由仍允许省略版本，但仍重新校验目标状态，状态不符返回 `409`。单条归档/恢复携带版本时同时执行乐观并发校验。

批量归档/恢复成功响应含 `operation`、`requested_count`、`updated_count`、`updated_ids` 和更新后的 `items`。永久删除成功响应含 `deleted_count`、`deleted_ids`、`affected_candidate_count` 和 `relation_count`；单条兼容路径另含 `talent_pool_id`。永久删除只移除 `talent_pools` 主记录和 `candidate_talent_pools` 关系，不删除候选人、职位、附件、备注、活动、履历或其他候选人资料。活动分组直接永久删除返回 `409 talent_pool_permanent_delete_conflict`。

加入和移出请求：

```json
{ "candidate_ids": ["candidate-id-1", "candidate-id-2"] }
```

单次 1 至 100 个 ID，事务式处理。加入响应含 `linked_count`、`already_linked_count`、`linked_ids`；移出响应含 `unlinked_count`、`not_linked_count`、`unlinked_ids`。已归档人才库或候选人不允许新增或移除关联；候选人必须先恢复才能调整人才库关系。

## 职位

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/positions` | 分页查询/新建 |
| GET/PATCH | `/positions/:id` | 详情/更新 |
| POST | `/positions/:id/archive` / `/restore` | 归档/恢复 |
| POST | `/positions/archive-batch` | 按版本事务式批量归档活动职位，最多 100 个 |
| GET | `/positions/:id/candidates` | 分页查询关联候选人 |
| POST/DELETE | `/positions/:id/candidates` | 批量关联/解除 |
| DELETE | `/positions/:id/candidates/:candidateId` | 解除单条关系 |
| POST | `/positions/permanent-delete/preview` | 预览 1-100 个已归档职位的影响并签发 token |
| POST | `/positions/permanent-delete/commit` | 使用 token 原子提交单条或批量职位删除 |
| POST | `/positions/:id/permanent-delete/preview` | 单条职位预览兼容路径 |
| POST | `/positions/:id/permanent-delete` | 单条职位提交兼容路径 |

职位核心字段为 `title`、`department`、`location`、`owner`、`headcount`、`status`、`description`、`tags`。导入血缘扩展字段为 `source_system`、`source_record_id`、`external_code`、`category`、`professional_line`、`job_sequence`、`headcount_type`、`project_name`。

职位查询支持原有分页、归档、状态、部门、负责人、地点、排序和搜索参数。搜索现同时覆盖 `external_code`、`category` 和 `professional_line`。

职位批量归档 body 为 `{ "records": [{ "id": "position-id", "expected_updated_at": "..." }] }`。`records` 必须包含 1 至 100 个互不重复的活动职位。服务端在一个 SQLite 事务中重新校验全部职位的存在性、活动状态和版本；任一目标缺失、已经归档或版本变化时返回 `409 position_archive_conflict` 且不归档任何职位，超过 100 个返回 `413`。归档只设置职位软归档状态，不删除候选人或既有关系。

关联端点单次最多 100 名候选人，事务式验证全部 ID。已关闭或已归档职位不能新增关联；已归档候选人不能关联或解除关系；解除关系不删除主实体。

职位永久删除使用与候选人相同的两步 token 协议，preview body 为 `{ "position_ids": [...] }`，commit body 为 `{ "preview_token": "..." }`。预览响应额外返回 `position_count`、`affected_candidate_count` 和职位专属 `impact`。活动职位返回 `409 position_not_archived`；提交时任一职位不存在、恢复或版本变化都会整批回滚。

删除事务写入每位受影响候选人的 `position_permanently_deleted` 活动、删除职位主行及关系/从属记录，并为每个职位写只含职位 ID SHA-256、受影响候选人数和时间的最小审计。它绝不删除候选人、人才库、候选人附件、备注或其他候选人档案。成功响应含 `deleted_count`、`position_ids`、`affected_candidate_count`、`candidate_activity_count`、`audit_ids` 和 `deleted_at`。

## 简历附件与履历检索

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/attachments/previews` | `multipart/form-data` 上传 `file`，可选 `candidate_id`；完成同步校验与安全暂存后返回 `202` 和解析任务信息 |
| GET | `/attachments/previews/:id` | 轮询仍有效的解析预览，直到 `ready` 或 `failed` 等明确终态 |
| DELETE | `/attachments/previews/:id` | 取消预览并清理隔离文件 |
| POST | `/attachments/previews/:id/confirm` | 用户确认选择字段/履历区块并保存附件 |
| POST | `/attachments/previews/:id/candidates` | 从单文件未匹配记录创建候选人，并保存确认的履历区块/头像 |
| POST | `/attachment-batches/:batch_id/items/:item_id/candidates` | 从批量附件未匹配记录创建候选人，契约与单文件创建一致 |
| GET | `/candidates/:id/attachments` | 列出候选人附件元数据 |
| GET | `/attachments/:id/text` | 返回附件元数据和解析文本；`Cache-Control: no-store` |
| GET | `/attachments/:id/download` | 私有受控下载；不公开附件目录 |
| GET | `/resume-search` | FTS5 全量履历检索，按候选人聚合证据 |

上传支持 `.pdf`（文本型、扫描型或混合型）、`.docx`、`.xlsx`、`.xlsm`、合法 BIFF8 `.xls`、UTF-8 `.csv` 和 UTF-8 `.txt`，单文件最大 15 MB。服务端联合校验扩展名、MIME 和签名/Office 容器；原始文件名被清洗，隔离文件和正式文件均使用随机内部名。同步校验失败直接返回结构化 `4xx/5xx`；进入后台解析后，`.doc`、加密文件、损坏文件、伪扩展名、非 BIFF8 XLS、无效 OCR 文本和超限内容会落入 `failed` 终态并返回安全、具体的 `error_code`、`error` 与 `retryable`。扫描或无文本 PDF 在视觉能力未启用时仍可形成确定性空文本预览；启用视觉能力但渲染器不可用时返回可确认的文本结果和 `pipeline.visual=fallback`，而不是伪造 OCR 文本。

确定性文本先在本地规则链路中处理。PDF 文本项根据归一化页面坐标分组为视觉行，再按同一行的 `x` 排列；重复的三单元及以上密集行、以及日期/职位与公司/学校对齐的时间线行，优先保持行内标签、值、日期关系。只有两侧具有独立纵向内容且没有时间线证据时才按垂直栏输出，列边界不稳定时保守按视觉行输出；单个无效坐标 span 只在其局部按来源顺序降级。单文件 PDF、DOCX 和 TXT 的确定性正文以 `records[].values.raw_text` 保留（包括供审计的 opaque token 和独立 `~`，受既有长度上限约束），规则清洗只作用于公开 section、evidence 和 suggestion，不删除 `raw_text`。该正文是几何重排后的文本提取结果，不是原始文件字节副本。扫描件/无文本 PDF 仍不提供 OCR；本链路不依赖视觉模型或外部 API。模型建议仅作为补充，不得覆盖 `raw_text` 或绕过确认流程。

创建成功响应为 `202 Accepted`，同时返回 `Location: /api/attachments/previews/:id` 与 `Retry-After: 1`。前端应保存首次响应中的 `preview_token`，按 `poll_after_ms` 轮询 `Location`，不得让一次浏览器请求一直等待解析器或模型建议。

预览响应的核心结构：

```json
{
  "preview_id": "...",
  "preview_token": "...",
  "status": "parsing",
  "poll_after_ms": 750,
  "expires_at": "...",
  "file": { "original_filename": "resume.pdf", "mime_type": "application/pdf", "file_size": 1234, "sha256": "...", "format": "pdf" },
  "records": []
}
```

解析成功后，GET 返回 `status: "ready"` 和记录：

```json
{
  "preview_id": "...",
  "preview_token": "...",
  "status": "ready",
  "expires_at": "...",
  "file": { "original_filename": "resume.pdf", "mime_type": "application/pdf", "file_size": 1234, "sha256": "...", "format": "pdf" },
  "records": [{
    "record_id": "...",
    "row_number": 1,
    "identity": { "phone": "+8613800000000", "email": "user@example.test" },
    "match": { "status": "high_confidence", "candidate_id": "...", "reason": "..." },
    "suggestions": [{ "field": "current_company", "value": "Example", "confidence": "high", "source": "deterministic_text", "evidence_status": "text_verified", "evidence_refs": [{ "page": 1, "text": "当前公司：Example" }], "evidence": "当前公司：Example", "current_value": null, "default_selected": true }],
    "sections": []
  }]
}
```

解析失败后，GET 返回例如 `{ "status": "failed", "error_code": "encrypted_pdf_unsupported", "error": "不支持加密或带密码的 PDF", "retryable": false }`。未知异常不会返回堆栈、内部路径或解析器原始错误。

PDF/DOCX 产生一条候选记录；Excel/CSV 每个非空数据行独立产生记录。自动定位仅用现有电话/邮箱标准化后精确匹配：双字段同一候选人为高置信，单字段唯一命中仍需用户确认；双字段命中不同候选人返回 `identity_conflict`，任一字段多候选命中或命中归档档案阻断。手机号和邮箱均未匹配时，页面可用解析姓名调用现有候选人搜索 API 手动选择，或复用现有候选人创建 API、校验、重复检查和审计流程新建后继续确认；姓名、公司、学校、职位和文件名仍不参与自动合并。

确认 body：

```json
{
  "preview_token": "...",
  "records": [{
    "record_id": "...",
    "candidate_id": "...",
    "expected_updated_at": "...",
    "selected_fields": ["current_company", "tags"],
    "selected_sections": ["section-id"],
    "merge_mode": "merge"
  }],
  "confirm_replace_sections": false
}
```

服务端重新校验 token、预览状态/有效期、候选人存在/未归档/版本、身份冲突、字段和区块选择。空建议值不会清除已有值；区块 `merge` 按 canonical family 和内容签名去重，`replace` 只软归档已导入的目标 family，不触碰未选区块或手工区块；`self_summary` 只更新主档字段。相同候选人 + SHA-256 + `resume` 幂等。

候选人编号显示严格区分系统 `candidate.id`、受信任外部编号和附件内部 lineage key。附件没有明确外部编号时，详情页不渲染“应聘者编号”，也不以文件名、行号、UUID 或 `attachment-preview:` 值代替。

生产服务在 Agent 网关配置完整时会调用同一网关生成文本补充建议：最多发送提取文本前 120,000 字符和前 100 条预览记录，使用 JSON Schema `candidate_attachment_suggestions`，不携带 tools/tool choice，系统提示把附件 JSON 视为不可信数据。默认 `ATTACHMENT_TEXT_SCHEMA_MODE=strict`；只有显式设置为 `compat` 才发送 `strict:false`，且兼容结果仍经本地严格字段白名单、Schema、证据和值校验，绝不标记为 strict。文本通道的 `ATTACHMENT_TEXT_TIMEOUT_MS` 和 `ATTACHMENT_TEXT_MAX_RESPONSE_BYTES` 只收紧有界请求。端点配置错误使用 `attachment_suggestion_endpoint_invalid` 或 `attachment_suggestion_endpoint_insecure`（均不可重试），不输出网关地址/凭据。PDF 视觉通道是独立的固定服务，只在显式 `image_input` 能力和完整视觉配置下接收受限 PNG 页面，不把 `extracted_text` 当作图像输入；端点仅支持 `http`/`https`，生产拒绝明文 HTTP，开发/测试仅允许非生产显式 loopback HTTP（这是与 trusted-private 例外分开的测试通道）。视觉端点默认拒绝私网解析结果；只有 hostname 精确列入 `ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS` 时，且 URL 使用 HTTPS、（若配置）同时通过 `ATTACHMENT_VISUAL_ALLOWED_HOSTS`，才允许 DNS 结果全部属于 RFC1918/IPv6 ULA 公司私网。该配置只接受精确 DNS 主机名，不接受 IP 字面量、通配符、后缀匹配、`.localhost`/`.internal`/`.local`/metadata 保留主机名或混合公网/私网答案；loopback、metadata、link-local、multicast、保留地址、IPv4-mapped、NAT64 和 6to4 等危险目标仍逐项拒绝。其他公网 HTTPS 主机仍可用 `ATTACHMENT_VISUAL_ALLOWED_HOSTS` 限制。主机名在请求前解析，所有 DNS 结果逐一校验并使用 pinned lookup。端点拒绝使用不含 URL 的稳定错误码 `visual_endpoint_invalid`、`visual_endpoint_insecure`、`visual_endpoint_blocked`、`visual_endpoint_unapproved`，DNS 不可用降级为 `visual_unavailable`。默认 `ATTACHMENT_VISUAL_SCHEMA_MODE=strict`；视觉 compat 同样只能显式开启且仍经本地严格校验。请求使用 `stream:false`、无 tools，并拒绝 HTTP 重定向。网关未配置、超时、错误或返回无效 JSON 时，API 保留本地规则建议并继续返回可确认预览；模型建议从不直接写数据库。

文本附件建议端点默认拒绝私网解析结果；只有精确列入 `ATTACHMENT_TEXT_TRUSTED_PRIVATE_HOSTS` 的 HTTPS DNS 主机名，且所有 DNS 返回地址均为 RFC1918/IPv6 ULA 时才放行，不接受 IP 字面量、通配符/后缀匹配或混合公网/私网答案。主机名在请求前解析并使用 pinned lookup，配置变更后需重启服务。

文本模型建议的附件服务外层等待窗口为 15 秒；适配器内部仍执行自身的 60 秒请求上限。窗口耗尽时仅降级模型建议，保留本地确定性解析结果和人工确认流程。

预览变为 `confirmed`、`cancelled` 或 `expired` 时，服务端清空该临时记录的 `extracted_text` 和 `records_json` 并移除隔离路径，只保留文件最小元数据、状态、错误码/时间等审计信息。确认后的完整正文位于正式候选人附件记录，不在预览中保留副本。

### PDF 双通道解析契约

PDF 预览在视觉能力显式声明为 `ATTACHMENT_VISUAL_CAPABILITY=image_input`、且本地配置完整时采用两条独立但不等价的通道：确定性文本通道始终负责文本、身份标准化、数据库身份匹配和基础字段/区块；视觉通道只在已渲染的 PDF 页可用时提出补充建议。该声明不执行标准化的主动探测或健康检查；网关是否可用、响应是否合规只在实际视觉请求/响应期间验证，并以安全 fallback 反映。预览顶层的 `parser_version` 当前为本地确定性解析器版本；`pipeline` 是异步任务完成后的通道状态，而非客户可设置的输入。

内部 HTTPS 网关可将精确主机名加入 `ATTACHMENT_TEXT_TRUSTED_PRIVATE_HOSTS` 和 `ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS`，并设置 `NODE_USE_SYSTEM_CA=1` 让 Node 24 使用 Windows 系统根证书。视觉模型通过 `ATTACHMENT_VISUAL_MODEL` 配置；模型超时或响应不符合本地 JSON Schema 时保持确定性结果并标记 `review_required`，不会自动确认。

```json
{
  "status": "ready",
  "parser_version": "local-resume-parser-v3",
  "review_required": false,
  "pipeline": {
    "text": { "status": "ready", "content_type": "text" },
    "text_model": { "status": "ready", "schema_mode": "strict", "retryable": false },
    "visual": {
      "status": "ready",
      "used_fallback": false,
      "capability": "image_input",
      "parser_version": "attachment-visual-parser-v1",
      "prompt_version": "attachment-visual-prompt-v3"
    }
  }
}
```

任务尚在 `parsing` 时，响应仍含同一 `parser_version` 和 `pipeline`：文本状态为 `parsing`，文本模型状态为 `pending|not_run`，PDF 视觉状态为 `not_run`，并带 `poll_after_ms`；终态为 `ready`、`failed`、`cancelled` 或 `expired`。`failed` 以顶层 `error_code`、`error`、`retryable` 表示解析失败；不要把 `pipeline.visual=fallback` 误认为整个预览失败。`pipeline.text_model` 与 `pipeline.visual` 各自保留 `status`、`schema_mode`、`error_code` 和 `retryable`；一个通道失败不会伪装成另一个通道成功。

`pipeline.text.content_type` 对 PDF 为 `text|scanned|mixed`，对非 PDF 为其已解析格式。扫描/混合 PDF、视觉未运行或视觉 fallback 时，顶层和 pipeline 都返回 `review_required: true`；任一格式的 `pipeline.text_model.status=fallback` 也会要求人工核对。这表示需要人工核对，不表示解析任务失败。纯文本 PDF 只有视觉成功且文本模型未 fallback 时才可为 `review_required: false`。非 PDF 的 `pipeline.visual` 为 `not_applicable`，不会因视觉通道自身要求复核；文本模型未 fallback 时 `review_required: false`，否则仍为 `true`。视觉降级不会撤销已完成的确定性文本结果。PDF 是目前唯一可能使用图像通道的格式；DOCX、XLSX、XLSM、BIFF8 XLS、UTF-8 CSV 和 TXT 仅走确定性通道。

记录中的每个字段建议和履历区块可包含 `source`、`evidence`、`evidence_refs`、`confidence`、`default_selected` 和可选 `conflict`。视觉候选还带 `evidence_status: "text_verified"|"unverified"`：前者表示同页文本层包含并核对了最小证据，后者只表示页面图像中可供人工复核的证据，默认不勾选且不参与自动栏目替换。`source` 为 `deterministic_text`、`deterministic_table`、`model_text`、`visual` 或合并后的 `merged`。`evidence_refs` 的稳定投影为页码和最小文本证据：`[{ "page": 1, "text": "..." }]`。仅当 PDF.js 已从该页文本层提取并校验 span 时，引用才可额外带归一化 `bbox: { "x", "y", "width", "height" }`；视觉模型不得返回或生成坐标，纯图像页也不能伪造 bbox。

视觉履历区块的 `structured_data` 只允许 `organization`、`role`、`start_date`、`end_date`、`period` 五个白名单键。只有同一条 `text_verified` 证据逐字包含对应值时才持久化这些关系；视觉-only 的区块可以展示给用户，但不能用短证据反向推导公司/职位/时间关系。未知键、坐标、无证据字段、字段重复或其他 Schema 违反都会以 `visual_invalid_schema` 安全降级。

文本通道优先于视觉通道：电话和邮箱只来自确定性文本标准化及精确数据库匹配，视觉建议不会改变身份；视觉建议与既有同字段值不一致时保留既有值并取消默认选择。稳定冲突对象为：

```json
{
  "code": "channel_value_conflict",
  "source": "visual",
  "existing_source": "deterministic_text",
  "existing_value": "...",
  "proposed_value": "...",
  "evidence_refs": [{ "page": 1, "text": "..." }],
  "message": "文本与视觉通道结果不一致，已保留文本结果并取消默认选择"
}
```

视觉区块调整已确定栏目边界时使用 `visual_replaces_deterministic_section`，同样要求人工选择。历史任职不能因视觉建议写成当前公司或当前职位，除非证据明确表明当前/在职关系。所有建议仍须由用户在确认端点显式选择，服务端会再次执行 token、版本、归档状态、身份冲突和字段校验。

视觉能力状态和降级使用稳定错误码，不把网关原始错误、路径、附件正文或凭据返回给调用方。当前包括 `visual_capability_disabled`、`visual_capability_unknown`、`visual_configuration_invalid`、`visual_pages_unavailable`、`pdf_visual_renderer_unavailable`、`pdf_visual_page_limit`、`pdf_visual_dimensions_invalid`、`pdf_visual_pixel_limit`、`pdf_visual_total_pixel_limit`、`pdf_visual_total_memory_limit`、`pdf_visual_png_limit`、`pdf_visual_total_png_limit`、`pdf_visual_render_timeout`、`pdf_visual_render_failed`、`visual_timeout`、`visual_http_error`、`visual_invalid_json`、`visual_invalid_schema`、`visual_response_too_large` 和 `visual_unavailable`。文本模型端点策略错误为 `attachment_suggestion_endpoint_invalid`、`attachment_suggestion_endpoint_insecure`，均不可重试；其他文本模型错误出现在 `pipeline.text_model.error_code`。解析器仍可能以既有 `pdf_no_text`、`pdf_parse_failed`、`parse_timeout`、`parser_unavailable` 等稳定 `error_code` 进入 `failed`；客户端应以 code 分支，不应解析中文消息。

PDF Worker 的页面视觉渲染最多 12 页、3,000,000 像素/页、18,000,000 总像素、64 MiB 累计 RGBA raster、4 MiB PNG/页和 24 MiB 总 PNG；raster 预算在原生 canvas 分配前按 `width * height * 4` 检查。每页渲染最多 8 秒，整份 PDF 的顺序页面渲染共用 30 秒预算，后续页面只能使用该文档渲染预算的剩余时间。视觉适配器的默认资源上限为最多 12 页、4,000,000 像素/页、3 MiB/页、12 MiB 总图像、8,000 字符/页、100 条记录、512 KiB 响应和 15 秒请求超时；附件服务另有 45 秒外层预算。环境变量或进程内 override 只能把这些预算下调，超过硬上限会被 clamp，不会扩大外发包络。页面 PNG、Base64、OCR 全文和模型原始响应只存在于 Worker/请求/合并期间，成功、失败、取消和过期路径都会清空。

`GET /resume-search` 接受 `q|query`、`keywords`、`match_mode=all|any`、`archived=include|exclude|only`、`location`、`min_years`、`max_years`、`stage`、`position_id`、`talent_pool_id|pool_id`、`source_types`、`page`、`page_size` 和 `evidence_limit`。每页最多 100；Agent 工具进一步限制为最多 50、默认 20，每位候选人最多 1 至 5 条 evidence。`min_years` 与 `max_years` 是兼容查询输入，各自仅接受 0 至 80；该限制不限制 `candidates.years_experience` 的存储或导入值，且 `NULL` 投影不参与数值范围匹配。V8 保留这个兼容路径和参数，但底层已从三类履历正文升级为政策业务表全字段 FTS5：候选人主档、关系、职位、人才库、阶段、导入批次、备注、活动、来源 JSON、履历区块和附件正文都可形成候选人证据。

响应仍按候选人去重并保留 `candidate_id`、`name`、`score`、`bm25_score`、`matched_fields`、`snippets`、`reasons`、分页和标准化条件，同时提供结构化 `evidence`。每条 evidence 包含 `document_id`、实体类型/ID、来源表/行、稳定 `field_path`、段坐标、`matched_terms`、实际命中词、同义词扩展标志和可合并重叠高亮的 `snippet`。职位、人才库、阶段或导入批次命中会映射到关联候选人，不因多条来源文档重复候选人。默认多概念查询先为召回 Top-20 建立候选人范围关系子集，并为每个概念优先返回真实命中 evidence；这不会提高 `page_size`、`evidence_limit` 或 Agent 上下文上限。FTS5 不可用或索引 checkpoint/coverage 未达到 ready 时返回 `503`，不会静默读取全库正文。

## 文件导入

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/candidates/import/config` | 返回当前批量导入配置；兼容路径 `/import/config` |
| POST | `/candidates/import/preview` | `multipart/form-data` 上传并预览 |
| POST | `/candidates/import/commit` | 使用一次性 `preview_token` 提交 |
| POST | `/imports/candidates` | 兼容结构化导入 |

`/import/preview` 和 `/import/commit` 是兼容路径。支持 `.xlsx`、`.xlsm`、UTF-8 `.csv` 和未加密的 Excel 97-2003 BIFF8 `.xls`。`.xls` 在解析前校验 OLE2 文件签名；仅修改扩展名的伪文件、加密工作簿或非 BIFF8 工作簿返回 `422`。

批量导入文件上限由 `CANDIDATE_IMPORT_MAX_BYTES` 配置，默认 `67108864` bytes（64 MiB）。配置端点响应形如：

```json
{
  "max_file_size_bytes": 67108864,
  "preview_row_limit": 20,
  "preview_ttl_ms": 1800000,
  "preview_store_max_entries": 2,
  "max_concurrent_previews": 1,
  "commit_failure_detail_limit": 100,
  "allowed_extensions": [".csv", ".xlsx", ".xlsm", ".xls"],
  "resource_limits": {
    "max_worksheets": 64,
    "max_columns": 1024,
    "max_cells": 6000000,
    "max_cell_characters": 200000,
    "max_total_characters": 134217728,
    "max_zip_entries": 10000,
    "max_central_directory_bytes": 16777216,
    "max_uncompressed_bytes": 805306368,
    "max_entry_uncompressed_bytes": 536870912,
    "max_compression_ratio": 2000,
    "max_parse_ms": 180000,
    "max_worker_old_generation_mb": 1024,
    "max_worker_young_generation_mb": 128,
    "max_worker_code_range_mb": 64,
    "max_worker_stack_mb": 8
  }
}
```

这些资源限制以服务端当前响应为准。系统不按候选人数或数据行数设置业务硬上限；超过上传字节上限返回 `413 limit_file_size` 并在 `details.max_file_size_bytes` 返回实际限制，格式损坏或触发解析资源边界返回对应的 `415`/`422` 错误。候选人上传使用磁盘临时文件和随机内部名，预览响应最多返回 20 行；简历附件继续使用独立的 15 MiB 限制，不受该环境变量影响。

每个服务进程最多同时执行一个候选人上传/解析；并发锁在 Multer 接收文件前取得，并在成功、错误或断连时释放。请求竞争时返回 `429 import_busy`、`Retry-After: 1` 和 `details.max_concurrent_previews=1`。解析运行在独立 worker 中，父线程负责 180 秒墙钟终止并施加上例 V8 内存资源参数。Office ZIP 在工作簿解析前校验 central/local header、路径/大小写重复项、本地范围及重叠，拒绝跨卷/分段、加密、ZIP64、符号链接和不支持的 flags/压缩方法，并验证实际 stored/inflate 字节、CRC、声明大小和压缩比；声明体积不能替代实际解压计数。

完整预览只为提交短期保存在进程内，默认 30 分钟有效且最多 2 个条目，定期清理过期项；容量满时淘汰最旧的非提交中预览，服务关闭时清空。外部响应仍最多返回 20 行。提交成功会消费 token，提交失败允许修正后重试。通用和北森提交的逐行失败详情最多返回 100 条，并附 `failure_details_returned`、`failure_details_limit`、`failure_details_omitted` 和 `failure_details_truncated`；批次总失败数不因明细截断而改变。临时文件清理默认尝试 3 次并以 25 ms 线性退避，最终失败返回 `500 import_temp_cleanup_failed` 并废弃相应预览。

导入有两种语义：

1. **通用候选人导入**：写入候选人和批次；当用户显式映射招聘职位字段时，还会预览并在提交事务中匹配/创建职位及关系。旧 `stage` 不再自动映射，但显式手工 mapping/default 仍可用于兼容。
2. **北森人才库导入**：任一支持格式的首工作表/CSV 表头包含大小写准确的“应聘者ID”时启用。“申请ID”和职位信息为可选；完全没有招聘职位字段时可只写候选人并跳过关系。显式职位字段无效、缺少新职位名称、匹配歧义或命中归档职位时，受影响源行失败且不写入候选人、职位、关系或原始载荷；职位关系可建立时写入职位关系和申请血缘，有真实评估载荷时可用申请 ID 标识评估。

北森文件中的 `最后职位类投递的职位id` 是关联招聘职位字段，不是入职职位字段。工作簿存在该专用表头时，单行空值不创建 `candidate_positions`，不得回退普通 `职位编号` 或入职职位；只有整表缺少专用表头时普通编号才可兼容回退。导入器将非空专用值作为职位外部键；真实历史导出中该列有时实际承载职位显示名，此时会结合同一候选人的 `最后职位类投递时间` 与既有申请来源中的 `最后投递时间`，在同名职位中解析唯一的 canonical `positions.external_code`。解析成功后写入 `candidate_positions`；没有历史唯一命中时保留该值作为稳定回退键并创建 `draft` 职位，歧义不会静默绑定。`入职职位` 只写 `candidates.hire_position`，绝不作为招聘职位关系键。

一次 100 人验收应至少核对：预览有效/失败行数及关系计数；提交后 `hire_position`、`hire_date` 和日期无状态时的 `hire_status=不确定`；每位有职位键候选人的 `candidate_positions`；至少一条 `candidate_talent_pools`；至少一条 `source_records`（有效、最初或最后来源）；以及重放不新增候选人、职位、职位关系、人才库关系或来源历史。SQLite `integrity_check` 和外键检查必须通过。当前记录分两层：20260821 为 `:memory:` 隔离导入（`formal_database_commit=false`）；2026-08-24 正式 HTTP 预览/提交为 100/100/0、0 导入/100 更新/0 失败/0 跳过，职位预览 create/match/link/conflict 为 0/32/36/0。用户豁免该提交后的全库摘要、逐行字段、完整性/外键后检和恢复演练，故 API 验收文档不将其列为已完成。

通用映射和北森轮廓均支持 `gender`/“性别”、`birth_date`/“出生日期”和 `age`/“年龄”。北森“应聘者ID”继续写入外部 `source_record_id`，不会被内部 UUID 替代；同一 ID 的多行非空补充规则保持不变。

北森预览返回 `profile: "beisen_talent"`、`summary.candidate_records`、`application_records`、`position_records`、`missing_identity_rows`、`missing_candidate_id_rows`、`skipped_application_rows` 和 `position_preview`。提交结果返回候选人/申请/职位计数、职位创建/匹配数、关系创建数和人才库创建数。`candidate_count` 是成功处理的唯一候选人数，不是源行数；`imported_rows + updated_rows + skipped_rows + failed_rows` 必须等于预览的 `total_rows`。

通用映射中的招聘职位目标字段为：

- `position_title`
- `position_external_code`
- `position_department`
- `position_location`
- `position_owner`
- `position_source_system`
- `position_source_record_id`

`current_title` 仍表示候选人当前任职，不能替代 `position_title`。无显式职位来源系统时使用导入 `source_system`，再回退 `excel_import`。

通用和北森预览都可返回：

```json
{
  "position_preview": {
    "create_count": 1,
    "match_count": 2,
    "ambiguous_count": 0,
    "invalid_count": 0,
    "archived_conflict_count": 0,
    "link_count": 3,
    "items": []
  }
}
```

职位 item 的 `action` 为 `create|match|ambiguous|invalid|archived_conflict`，并包含原因、来源标识、名称、部门、地点、负责人、候选匹配数和源行号等适用字段。匹配顺序为稳定来源键、标准化“名称 + 部门 + 地点”、唯一未归档同名；无匹配创建 `draft`，歧义或归档冲突阻断。提交返回 `position_count`、`positions_created`、`positions_matched` 和 `links_created`。职位创建和关系写入与候选人提交同事务，唯一约束和 `INSERT OR IGNORE` 防止重放重复。

北森候选人按 `(source_system='beisen', source_record_id=应聘者ID)` 增量更新。相同 ID 在文件内先合并，后出现的非空标量覆盖先出现值；跨批次提交也仅写入非空字段。非空姓名和“证件照” URL 可以纠正或更新，空姓名、空照片及其他空值不清除旧值，标签使用集合并集并截断到前 50 个，来源 `raw_payload` 也只用非空字段补充或覆盖。姓名始终不是自动合并键。已有 ID 的增量文件可以省略姓名；新 ID 必须提供姓名。标准化手机或邮箱属于另一候选人时返回 `identity_conflict`，不会自动合并。北森预览中的候选人只含 `has_photo`，不含 `photo_url`。

`申请ID` 只在该行能够建立职位关系或包含可结构化的评估载荷时参与文件内重复和既有归属校验；无可用职位且无评估载荷时即使重复也只作为未使用信息跳过。有效申请 ID 已属于另一候选人时返回 `application_identity_conflict`，提交前再次校验，绝不把申请、关系或评估改绑到新候选人。Offer/录用字段只保留在候选人来源 `raw_payload`；`自我评价` 写入 `candidates.self_summary`，二者都不创建 `candidate_assessments`。

失败行不贡献候选人、职位、关系或任何 `raw_payload`。重复提交不会重复创建候选人、职位或关系，但会更新候选人的 `updated_at`、`import_batch_id` 并写入 `candidate_import_updated` 活动，从而影响最近更新排序；该行为是重放安全而非严格状态幂等。详细规则见 [IMPORT_GUIDE.md](IMPORT_GUIDE.md)。

## 导出

`GET /candidates/export?format=xlsx|csv` 或兼容路径 `/export`。支持候选人查询筛选且不分页，包括 V7 `gender` 条件；页面移除的 `major` 筛选仍作为兼容查询参数保留。

导出是显式数据提取操作，包含电话、邮箱、薪资、来源 ID 和旧阶段等候选人字段，但 CSV/XLSX 都明确排除 `photo_url`。它不包含职位关系、人才库关系、原始 `raw_payload`、面试/测评历史、授权记录或照片附件，不能作为完整数据库备份。

CSV 使用 UTF-8 BOM，并中和以 `= + - @ TAB CR` 开头的文本以防公式注入。XLSX 保留原字符串。

## Agent

V9 前端使用 SQLite 持久会话和异步任务 API。旧 `POST /agent/query` 仅作为兼容适配器保留，也会进入同一个有界任务队列；响应带 `Deprecation: true` 和迁移提示，不是当前抽屉的默认调用路径。

### 持久会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/agent/sessions` | 新建活动会话；可选 `{ "title": "..." }`，返回 `201` |
| GET | `/agent/sessions?status=active|archived|all&page=&page_size=` | 按更新时间倒序分页；默认每页 20，最多 100 |
| GET | `/agent/sessions/:id` | 读取会话元数据和消息数量 |
| PATCH | `/agent/sessions/:id` | 重命名或设置 `status=active|archived`；归档中的活动请求返回 `409` |
| DELETE | `/agent/sessions/:id` | 永久删除会话，并级联删除消息与摘要；忙状态返回 `409` |
| GET | `/agent/sessions/:id/messages?page_size=&before_sequence=` | 读取最新或更早消息；默认 50，最多 100 |
| POST | `/agent/sessions/:id/messages` | 接受一轮任务；必须携带 `message` 和 `client_request_id` |
| GET | `/agent/sessions/:id/tasks?recoverable=1` | 列出会话可恢复任务；活动任务以及带保留结果的终态任务可恢复 |
| GET | `/agent/tasks/:task_id` | 读取任务真实阶段、耗时、结果、错误和可执行操作 |
| POST | `/agent/tasks/:task_id/cancel` | 请求取消排队中或运行中的任务 |
| POST | `/agent/tasks/:task_id/retry-answer` | 对带保留结果的 `partial` 任务从证据快照继续执行，证据不足时可继续调用只读工具 |

会话列表返回页码分页；消息使用序号游标：

```json
{
  "items": [],
  "pagination": {
    "page_size": 50,
    "has_more": true,
    "next_before_sequence": 17
  }
}
```

发送请求示例：

```json
{
  "message": "继续比较刚才两位候选人的项目经历",
  "client_request_id": "客户端生成且本轮唯一的 ID"
}
```

`message` 最多 20,000 字符，`client_request_id` 为 1 至 200 字符。服务端用“会话 ID + 规范化正文”的 SHA-256 绑定幂等 ID：首次任务在默认 650 ms 短窗口内完成时返回 `201`；仍在处理时返回 `202`、`state=processing` 和 `Retry-After: 1`；相同 ID、会话和正文的重放返回原任务，不重复查询或调用模型。同一 ID 被不同内容/会话复用、同会话同时发送其他请求或归档会话写入返回 `409`。

前端对长任务采用持续等待而不是固定的 30 秒失败窗口：提交请求的兼容等待预算为 100 秒，任务状态读取单次请求预算为 20 秒；超时和调用方取消覆盖 `fetch`、完整响应体读取及 JSON 解析，不能在已收到响应头后无限等待。状态请求超时、`408`、`5xx` 或网络短暂中断时保留同一个 `task_id`/`client_request_id` 和 preferred session，按退避间隔自动重连并持续轮询；只有 preferred session 明确 `404`、`410` 或已归档时才选择其他会话。task `404` 会回到会话消息/任务列表按同一请求 ID 恢复，而不是直接丢弃任务。切换会话会使旧会话迟到的提交/恢复响应失效，未知的未来任务状态按非终态继续读取。对话页把服务端真实阶段展示为“进入队列 → 分析问题 → 查询数据 → 整理证据 → 生成回答”，同时显示阶段耗时、首批证据和结果数；用户可以取消任务，刷新页面会从会话任务表恢复轮询。只有服务端明确返回 `completed|partial|failed|cancelled` 时才结束本轮，不再把一次 HTTP 状态读取超时提示为任务失败。

任务状态为 `queued|planning|querying|retrieving|composing|completed|partial|failed|cancelled`。`timings` 按实际阶段记录毫秒数，并在首个数据库快照保存时增加 `first_evidence_ms`；该值不是前端模拟进度。任务信封的核心结构为：

```json
{
  "state": "processing",
  "replayed": false,
  "task": {
    "task_id": "...",
    "trace_id": "...",
    "status": "querying",
    "stage": "querying",
    "result": null,
    "result_count": 0,
    "has_more": false,
    "timings": { "queued": 12 },
    "error": null,
    "can_cancel": true,
    "can_retry_answer": false,
    "heartbeat_at": "...",
    "deadline_at": "...",
    "elapsed_ms": 120
  }
}
```

数据库查询成功但后续执行失败时，任务进入 `partial` 并保留受限工具结果、Top-K ID、命中字段和 evidence。此时 `can_retry_answer=true`；兼容路径 `retry-answer` 会从保留证据恢复完整编排，证据足够时直接生成回答，证据不足时继续执行新的 SQL/FTS 等只读工具。取消已是终态的任务会返回当前任务；带保留结果的 `cancelled` 任务仍属于可恢复任务，刷新后继续展示结果。未知任务返回 `404 agent_task_not_found`。队列满返回 `429 task_overloaded`。

任务错误和只读工具错误封套使用稳定代码；任务级错误同时保存失败阶段。二者都不把 SQL、数据库路径、模型配置或敏感结果写入提示：

| code | 含义 |
| --- | --- |
| `query_timeout` | SQL/FTS 只读子进程超出该工具阶段预算并被终止 |
| `model_timeout` | 模型规划或回答阶段超时 |
| `gateway_unavailable` | 模型网关连接失败或服务端故障 |
| `agent_gateway_error` / `agent_gateway_invalid_response` | 网关返回错误状态或无效响应结构 |
| `task_overloaded` | 并发与排队预算已满 |
| `task_cancelled` | 用户明确取消任务 |
| `agent_interrupted` | 服务进程中断；持久任务会在服务恢复后重新排队并继续执行 |
| `invalid_query_plan` / `readonly_policy_blocked` | 查询计划无效或被只读策略拒绝 |
| `fts_unavailable` / `search_index_not_ready` | FTS5 或全字段索引状态不可用，禁止退化为全库正文外发 |
| `result_too_large` / `agent_context_limit` | 持久结果或模型上下文超过受控上限 |
| `internal_error` | 无法进一步安全分类的内部错误 |

任务错误对象包含 `code`、`stage`、`message`、`retryable`、`retained_result`。`retained_result=true` 表示数据库证据仍可展示；前端不应把这些错误统一替换成“发送失败，请重新提问”。工具级授权错误也可能保留底层稳定代码，例如 `query_not_authorized`，供模型在剩余预算内修正只读查询。

消息状态为 `processing|completed|failed`，任务状态与消息状态分开保存。响应包含序号、角色、正文、模型、工具名、错误码和输入/输出字节统计。所有会话、消息、任务和兼容问答响应均使用 `Cache-Control: private, no-store`。长会话摘要是服务端内部状态，不通过普通会话 API 或 Agent 只读工具直接暴露。

删除会话只删除本机 Agent 会话、消息和摘要，不删除候选人、职位、人才库、附件或查询审计。归档会话可通过 PATCH 恢复为 `active` 后继续；归档本身不是删除。

### 兼容问答与工具

`POST /agent/query`：

```json
{
  "message": "查看 Engineering 人才库的学历分布",
  "history": []
}
```

`GET /agent/status` 返回 `full_readonly: true`、`access_mode: sqlite_full_readonly_on_demand`、`sensitive_fields: unmasked_on_request`、`persistent_sessions: true`、`async_tasks: true`、独立只读连接状态、18 个工具名、向量检索状态和任务执行边界。默认同时运行 2 个、排队 20 个；单个 SQL、FTS、模型规划和回答阶段的首次尝试分别为 3/8/90/90 秒并带有限退避重试，模型重试单次最多 120 秒，短同步窗口为 650 ms。同一批工具最多并发 4 个，但总工具调用和总执行时间不设固定截止；状态中的 `deadline_ms` 与 `max_tool_calls` 为 `null`。服务通过语义重复检测、真实证据进展和上下文上限防止无进展循环，不能以这些保护替代完整结果。实际值可由服务端配置覆盖并通过状态端点核对，但不会返回凭据或网关地址。现有网关未确认 Embedding 时，`vector_search.enabled=false`、`fallback=sqlite_fts5`；服务不会连接其他 Embedding 服务。

工具白名单：

1. `get_schema_catalog`
2. `execute_readonly_query`
3. `query_candidates`
4. `get_candidate_full`
5. `query_candidate_notes`
6. `query_candidate_activities`
7. `query_candidate_sources`
8. `query_candidate_assessments`
9. `query_positions`
10. `get_position_full`
11. `query_talent_pools`
12. `aggregate_recruitment_data`
13. `search_all_records`
14. `search_candidate_resumes`
15. `get_candidate_resume`
16. `query_candidate_attachments`
17. `get_attachment_text`
18. `export_query_results`

`POST /agent/tools/:name` 可直接调用白名单工具；未知工具返回 `404 tool_not_found`。结构化工具的表、字段和关联由服务端 schema 目录解析，支持 `eq|ne|contains|in|gte|lte|is_null`、最多 12 个关联、8 个排序字段、分页和聚合/分组，客户端标识符不会直接拼接 SQL。

`search_all_records` 用于候选人、职位、人才库、来源、附件和最小删除审计等实体的跨表全业务字段检索，按实体去重并返回真实来源表、字段路径、命中词和证据区间。`search_candidate_resumes` 用于候选人级召回，把候选人直接字段和关系映射命中聚合为 Top-K 候选人与必要证据；两者都由 SQLite/FTS5 扫描全量索引并通过分页限制返回量。Agent 默认使用 `include_total=false`/`fast=true`，通过有界 BM25 过采样、当前页和 `has_more` 避免为宽泛检索计算全量精确窗口；只有明确要求精确数量时才启用完整计数。`fast=true` 不能与 `include_total=true` 同时使用。

`execute_readonly_query` 只接受一条 `SELECT` 或只读 CTE及绑定参数，常规最大 100 行、1 MB、默认 3 秒。底层使用文件型数据库独立只读 worker、`query_only=ON`、`trusted_schema=OFF`、禁用扩展和 SQLite authorizer；写入、DDL、写 PRAGMA、`ATTACH`/`DETACH`、多语句、未在目录中的表/列和未允许函数被拒绝。`export_query_results` 使用同一保护生成本地 CSV，最多 50,000 行/25 MB；通过 `GET /agent/exports/:id` 下载。

SQL/FTS 查询、`business_search_sync`、模型网关等待、Agent 工具执行和响应组装都会写入 `agent_query_audits` 分段记录。V9 额外写入 `trace_id`、`task_id` 和 `phase`。记录只含阶段/工具名、表/列/函数范围、耗时、返回行数和错误码，不含用户问题、Agent 回复、工具参数/结果或敏感正文；非查询阶段范围为空、行数为 0。

Agent 可以按用户问题读取未打码手机号/邮箱、照片地址、薪资、备注、活动、完整履历、评估、授权、`raw_payload`、附件文本、归档数据和最小删除审计。它不会主动导出整库；数据库负责全量扫描与聚合，模型只接收当前分页、聚合或 Top-K。所有数据库文本、历史消息和摘要都被标记为不可信输入。Agent 没有任何新增、修改、归档、恢复、关系、附件确认、删除、通用终端或任意 HTTP 工具。

普通 Agent 目录只公开显式业务政策表及允许字段。`agent_sessions`、`agent_messages`、`agent_session_summaries`、附件预览/清理、迁移账本、搜索内部表和 FTS shadow 表均不可由 `execute_readonly_query` 读取；附件 `storage_path` 和向量 BLOB 也被列策略及结果过滤隔离。服务端拥有的搜索工具可以访问内部 FTS，但不能把这些受限列带回模型。详见 [AGENT_SECURITY.md](AGENT_SECURITY.md)。
