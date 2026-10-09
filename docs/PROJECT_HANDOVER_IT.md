# 项目交接文档：人才资产工作台（candidate-workbench 0.7.0）

| 项 | 内容 |
| --- | --- |
| 交接对象 | IT（服务器运维 / 应用发布） |
| 交接方 | 原开发负责人（此后不再负责该项目） |
| 项目名称 | 人才资产工作台（代码 `candidate-workbench`，版本 **0.7.0**） |
| 代码仓库 | 公司 GitLab：`http://gitlab.wd.com/cboy/candidate-workbench`（主）；GitHub 私有镜像：`https://github.com/guyuefangyuan7766-png/candidate-workbench` |
| 生产服务器 | `192.168.8.12`（Windows Server 2022，管理员 `Administrator`） |
| 访问入口 | `https://talent.wooduan.com`（nginx @ 192.168.8.167 反代 → `127.0.0.1:4173`） |
| 数据规模 | 主库 17.46 GiB / 119,084 候选人 / 1,559,913 简历文档；全部数据合计 **160.71 GiB** |
| 交接状态 | 代码与数据已就绪；**首次上线与后续增量流程均有脚本与文档**；服务器侧尚未实跑过发布脚本 |

> 配套文档（都在本仓库 `docs/`）：
> - 发布交接单（首次上线）：`docs/SERVER_RELEASE_HANDOVER_IT.md`
> - 上传清单（开发侧）：`docs/SERVER_UPLOAD_CHECKLIST.md`
> - 变更记录：`CHANGELOG.md`；测试记录：`docs/TESTING.md`
> - 数据清单（校验用）：`data/deploy/data-manifest.json`
> - 代码清单（校验用）：`data/deploy/local-manifest.json`

---

## 1. 系统概览

### 1.1 用途与使用者

- 用途：公司人才库（北森共享资产）的本地副本 + 简历解析 + 全文/向量混合检索 + 只读 AI 助手。
- 使用者：约 15 名授权招聘人员（LDAP 账号 + 白名单），通过 `https://talent.wooduan.com` 访问。
- 数据性质：**敏感**（候选人姓名/手机/邮箱/薪资/简历正文），服务器与附件目录按敏感数据管理。

### 1.2 技术架构

| 层 | 实现 |
| --- | --- |
| 前端 | React 19 + Vite（构建产物 `dist/`，由 Node 服务托管） |
| 服务端 | Node.js ≥24 + Express 5（`server/index.mjs`，单进程，监听 `127.0.0.1:4173`） |
| 数据库 | SQLite（`recruitment.db`，schema **V14**），FTS5 全文索引 |
| 向量检索 | `usearch` **f16** HNSW 索引（1,457,263 vectors × 1024 维，约 3 GB） |
| 模型网关 | 公司网关（`AGENT_BASE_URL` / `AGENT_API_KEY`）：查询理解、Embedding、重排、简历解析、AI 助手 |
| 认证 | 公司 LDAP（`ldap://ldap.wan5d.com:389`）+ 本地白名单 + 独立会话库 `auth.db` |

### 1.3 部署拓扑

```text
浏览器 --HTTPS--> talent.wooduan.com (nginx @ 192.168.8.167)
                 --HTTP--> 127.0.0.1:4173 (本应用, 192.168.8.12)
代码: C:\apps\talent-workbench\          （+ data 目录联接 → C:\talent-data）
数据: C:\talent-data\                    （主库 / 向量 / 附件 / 认证 / 增量缓存）
自启: 任务计划 TalentWorkbench → start.ps1
```

---

## 2. 代码与仓库

### 2.1 仓库与分支

| 远端 | 地址 | 说明 |
| --- | --- | --- |
| `gitlab`（主） | `http://gitlab.wd.com/cboy/candidate-workbench` | 公司内网；`main` 为默认分支，`test22` 为历史开发分支 |
| `origin`（备） | `https://github.com/guyuefangyuan7766-png/candidate-workbench` | 私有镜像，内容与 GitLab 一致 |

- 当前代码提交：`main = 7709dfe`、`test22 = 14a5262`（两者内容一致）。
- 建议后续约定：功能/修复在分支开发 → 合并到 `main` → 发布时以 `main` 为准；**只在一个仓改，另一个仓同步**（或直接停用 GitHub 镜像以免漂移）。
- 历史里那个 292 MB 的检查转储已从 Git 历史剔除并在 `.gitignore` 忽略；不要再提交 `outputs/**/*.ndjson`（GitHub 单文件 100 MB 上限）。

### 2.2 本地开发/构建要求

- Node.js ≥ 24（服务器现为 v26.9.0）
- `npm ci` → `npm run build` → `node server/index.mjs`
- **不要**把 `node_modules` 复制到服务器（十万级小文件经 RDP 映射会静默丢失）

### 2.3 代码完整性校验

```powershell
node scripts/deployment-manifest.mjs --out data\deploy\local-manifest.json      # 开发机
node scripts/deployment-manifest.mjs --out C:\talent-data\deploy\server-manifest.json   # 服务器
node scripts/deployment-manifest.mjs --compare <local.json> <server.json>       # identical: true
```

---

## 3. 数据资产

### 3.1 全量清单（`data/deploy/data-manifest.json`，449 条目 / 806,852 文件 / 160.71 GiB）

| 分类 | 条目 | 文件数 | 大小 | 服务器落点 |
| --- | --- | ---: | ---: | --- |
| 运行必需 | `recruitment.db`（+`-wal`/`-shm`） | 3 | 17.46 GiB | `C:\talent-data\recruitment.db` |
| 运行必需 | `search-vectors\` | 9 | 27.66 GB | `C:\talent-data\search-vectors\` |
| 运行必需 | `private\`（附件） | 260,455 | 49.79 GiB | `C:\talent-data\private\` |
| 运行必需 | `search-runtime.json` | 1 | <1 MB | `C:\talent-data\search-runtime.json` |
| 留档 | `asset-export\`（原始资产快照） | 347,133 | 47.88 GB | `C:\talent-data\asset-export\` |
| 留档 | `incremental\`（增量缓存） | 198,708 | 17.64 GB | `C:\talent-data\incremental\` |
| 报告 | phase3/审计/评测报告 | 134 | 0.13 GiB | `C:\talent-data\` |
| 可忽略 | `*.log` / `*.pid` / 调试输出 | 409 | 0.14 GiB | — |

### 3.2 完整性校验

```powershell
node scripts/data-inventory.mjs --out data\deploy\data-manifest.json                 # 开发机生成
node scripts/data-inventory.mjs --verify C:\talent-data\deploy\data-manifest.json    # 服务器核对
```

核对项：条目文件数、字节数、`recruitment.db` 与 `search-runtime.json` 的 SHA256。

### 3.3 数据口径（不要破坏的约定）

1. **消失的候选人只标记不删除**：`candidate_asset_index.is_deleted = 1`，档案/附件保留，重新出现自动回 0。
2. **附件永久保留**：不提供"批量删除附件"的运维入口。
3. **不要直接编辑/覆盖 `recruitment.db`**：数据更新一律走导入脚本（保证触发器维护的搜索索引一致）。
4. **schema V14**：代码启动会自动做幂等迁移；没有 down migration，回滚需代码+数据一起。

---

## 4. 方向一：把当前项目更新到服务器（首次全量）

> 详细步骤见 `docs/SERVER_RELEASE_HANDOVER_IT.md`；这里给要点。

### 4.1 前置

- 停机窗口 1–3 小时；服务器 `C:` 剩余 **≥300 GB**；
- 开发机本地服务已停止（否则主库/WAL 可能在复制中变化）；
- 服务器现有 `C:\talent-data\auth-allowlist.txt` 必须存在（脚本会前置校验，缺了直接拒绝）；
- 管理员 RDP 映射开发机 D 盘：`mstsc /v:192.168.8.12 /drive:D,`。

### 4.2 执行

```powershell
# 先看计划
powershell -NoProfile -ExecutionPolicy Bypass -File "\\tsclient\D\talent-asset-workbench\scripts\deploy-to-server.ps1" -SourceRoot "\\tsclient\D\talent-asset-workbench" -IncludeArchive -DryRun
# 正式执行（-IncludeArchive = 连原始快照与增量缓存一起交接）
powershell -NoProfile -ExecutionPolicy Bypass -File "\\tsclient\D\talent-asset-workbench\scripts\deploy-to-server.ps1" -SourceRoot "\\tsclient\D\talent-asset-workbench" -IncludeArchive
# 启动
Start-ScheduledTask -TaskName TalentWorkbench
```

脚本自动完成：停服/停任务 → 旧代码与旧数据改名 `*.bak-<时间戳>`（不删）→ 拷代码 → 拷全部数据 →
**保留服务器现有认证文件** → 建目录联接 `C:\apps\talent-workbench\data` → `C:\talent-data` → `npm ci` → `npm run build`。

### 4.3 验收

1. `http://127.0.0.1:4173/api/health` → `status=ok`
2. 登录后 `https://talent.wooduan.com/api/resume-search/status` → `ready/available/loaded/current=true`、`algorithm=usearch-hnsw-cos-f16`、`query_budget_ms=120000`
3. 界面真实检索一条（如「数值策划」）有结果
4. `node scripts/self-test-api.mjs --cookie "tw_session=<值>"` → **32/32**
5. LDAP 登录成功（未登录访问 `/api/candidates` 应 401；连续输错会限流 5 分钟）
6. AI 助手提问一句有回答
7. `deployment-manifest --compare` → `identical: true`；`data-inventory --verify` → `verified: true`

### 4.4 回滚

停服/停任务 → 新目录改名 `*.failed-<时间>` → `*.bak-<时间戳>` 改回原名 → 启动 → 复核 1/2/5。
**必须代码 + 数据一起回滚**（无 down migration）。

---

## 5. 方向二：增量更新（日常数据同步）

### 5.1 现状与依赖（交接关键）

当前增量链路依赖**三个只在开发侧具备的条件**：

| 依赖 | 现状 | 交接后可选方案 |
| --- | --- | --- |
| WDCloud 插件 + 登录（`talent-pool-agent`） | 只装在原开发机，凭据在 Windows 凭据管理器 | ① IT 接管该开发机；② 在服务器安装插件并登录；③ 改由资产侧定期导出 zip 给 IT |
| 模型网关（`AGENT_BASE_URL`/`AGENT_API_KEY`） | 服务器已有（AI 助手与检索都在用） | 沿用；注意密钥轮换 |
| 附件与向量维护脚本 | 在代码仓库 `scripts/` 内 | 沿用（本仓库自带） |

> **上线后如果 IT 不接管"拉取"这一段，数据就会停在交付时的快照**，只有人工导入增量包才会更新。这是本交接最大的持续性风险，建议交接会上明确归属。

### 5.2 手工流程（现状，可用）

**开发侧（或接管方）产出增量包**

```powershell
node scripts/incremental-sync.mjs --check                                # 对比上游清单，算新增/变化/消失
node scripts/incremental-sync.mjs --download --targeted --profiles-full  # 只下载差集分片（断点续传）
node scripts/pack-incremental-for-it.mjs --apply                         # 产出 data\packages\incremental-<时间戳>.zip
```

**服务器侧应用（停服）**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\apps\talent-workbench\scripts\apply-incremental-package.ps1" -Package "<zip 路径>"
```

脚本顺序：停服/停任务 → 解包到 `C:\talent-data\incremental`（合并不删除）→ `import-incremental --apply` →
解析新原件（模型网关）→ `persist-attachment-text --apply` → 刷新 f16 向量索引 →
收敛业务索引 → 提示启动。可选 `-SkipParse` / `-SkipVector` / `-DryRun`。

### 5.3 建议的自动化（后续优化项）

1. 把"拉取 + 打包"搬到一台常开机器（IT 接管开发机，或服务器装插件），用任务计划每周/每日跑一次；
2. 服务器侧把 `apply-incremental-package.ps1` 挂在维护窗口自动执行；
3. 给跑批加失败告警（邮件/企业微信）：检查 `data/incremental-pipeline-report.json` 的 `state=failed`；
4. 变更可观察性：同步后自动跑一次 `/api/health` 与一条固定查询，结果写日志。

### 5.4 注意事项

- **绝不直接覆盖 `recruitment.db`**；增量一律通过 `import-incremental` 写库。
- 白名单/认证库不参与数据同步（保持服务器本地）。
- 增量包体积：只含差集候选人的档案与简历（本次 245 人约 300 MB；如果不去重会到 8.5 GB）。

---

## 6. 日常运维

### 6.1 启停

```powershell
Start-ScheduledTask -TaskName TalentWorkbench      # 启动（开机也自动启动，延迟 2 分钟）
Stop-ScheduledTask  -TaskName TalentWorkbench       # 停任务
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/index.mjs*' }
# 手工启动：powershell -NoProfile -ExecutionPolicy Bypass -File C:\apps\talent-workbench\start.ps1
```

### 6.2 健康检查与自检

| 检查 | 命令/入口 | 期望 |
| --- | --- | --- |
| 服务存活 | `GET /api/health` | `status=ok` |
| 检索状态 | `GET /api/resume-search/status`（登录态） | `f16` + `loaded/current=true` |
| 全功能自检 | `node scripts/self-test-api.mjs --cookie "tw_session=<值>"` | 32/32 |
| 认证状态 | `GET /api/auth/status` | `enabled: true` |

### 6.3 日志位置

| 日志 | 位置 |
| --- | --- |
| 服务 stdout/stderr | 任务计划的输出重定向（C 盘项目原有约定）或 `C:\talent-data\*.log` 系列 |
| 解析长跑 | `C:\talent-data\phase3-full*.log`、`phase3-full-progress.jsonl` |
| 向量维护 | 维护脚本输出（`--formal` 运行时打印），状态见 `/api/resume-search/status` |
| 增量同步 | `C:\talent-data\incremental-pipeline-report.json`、`data/incremental/*.log` |

### 6.4 备份与恢复（**当前缺口，建议优先补**）

- 需要备份：`C:\talent-data\recruitment.db`(+wal/shm)、`search-vectors\`、`private\`、`auth.db`、`auth-allowlist.txt`、`search-runtime.json`。
- 现状：没有自动备份任务；建议每日/每周 robocopy 到独立磁盘 + 定期验证可恢复性。
- 恢复：停服 → 用备份覆盖数据目录 → 启动 → 复核健康检查与一次检索。

### 6.5 磁盘与容量

- 数据 160.71 GiB；发布时会保留旧数据备份（`*.bak-*`），因此同一时刻磁盘峰值约 220 GB。
- 增量缓存（`data/incremental`）会持续增长，建议按季度清理已导入成功的分片 zip（保留 manifest 与最新一轮）。

### 6.6 索引维护

| 场景 | 命令 |
| --- | --- |
| 向量索引日常增量 | `node scripts/search-vector-maintenance.mjs --formal --database C:\talent-data\recruitment.db --directory C:\talent-data\search-vectors --dimensions 1024 --concurrency 4` |
| 业务索引不收敛（dirty 清不掉/反复整库回填） | 停服后 `node scripts/converge-business-search.mjs --apply`（拉到 `checkpoint=ready`、`dirty=0`） |
| 业务索引需要重建 | `node scripts/rebuild-business-search.mjs --apply`（丢表重建，数小时） |
| 主库回收空间 | 停服后 `node scripts/vacuum-database.mjs --apply`（本次 39.8 GiB → 17.46 GiB） |

---

## 7. 账号、凭据与权限

| 项 | 位置/说明 | 轮换建议 |
| --- | --- | --- |
| 服务器管理员 | `192.168.8.12` / `Administrator`（本地管理员） | 交接后改密码，仅运维掌握；建议改专用运维账号 |
| 应用认证 | 公司 LDAP + `C:\talent-data\auth-allowlist.txt`（一行一个登录名，删人 30 秒生效） | 离职即删白名单；紧急撤销 `AUTH_SESSION_REVOKE_ALL=true` 重启一次 |
| 模型网关密钥 | 服务器环境变量 `AGENT_API_KEY`（系统级+用户级） | 按公司策略轮换；轮换后重启服务 |
| GitLab / GitHub | 个人账号（`cboy` / `guyuefangyuan7766-png`）；凭据存在开发机 Windows 凭据管理器 | 建议把仓库所有权转给团队账号或群组 |
| 数据库/附件 | 明文存储（无静态加密） | 依赖 BitLocker + NTFS 权限；开发机副本也应加密或删除 |

---

## 8. 已知限制与风险

| # | 风险 | 影响 | 现状/建议 |
| --- | --- | --- | --- |
| 1 | **增量同步依赖开发机插件与登录** | 无人接管则数据停滞 | 见 §5.1，交接会明确归属 |
| 2 | 检索慢：宽泛两词查询 20–70 秒，偶发 `rerank_unavailable` 降级 | 体验一般，但结果可用 | 见 §10 优化项（重排超时/缓存/预热） |
| 3 | 向量索引必须 f16 | 用 f32 重建则索引打不开 | 已固化在代码与文档；重建务必 f16 |
| 4 | 业务索引已收缩（元数据字段不再进全文索引） | Agent 无法按 `source_record_id`/`raw_payload.*` 等关键词搜 | 业务确认过的取舍；需要的话按 §10 恢复并重建 |
| 5 | 白名单内无 RBAC、无字段级权限 | 15 个账号可见未打码手机/邮箱/薪资 | 需产品/安全立项（§10） |
| 6 | 数据质量：`current_title` / `self_summary` 全空（119,084 人）、39,502 份原件无正文、34 人专业是排名标签、30 人学校是数字代码 | 列表观感与检索覆盖率 | 见 §10 数据治理项 |
| 7 | 全量后端测试存在 8 个既有失败（历史记录：730 项 / 715 通过） | 无法直接用 CI 做门禁 | 先跑 `npm test` 复核再决定修复范围 |
| 8 | 没有自动备份 | 磁盘故障即数据丢失 | 建议优先补备份任务（§6.4） |

---

## 9. 故障排查手册

| 症状 | 可能原因 | 处置 |
| --- | --- | --- |
| 页面打不开 / 502 | 服务未启动或端口被占 | 查 `server/index.mjs` 进程、任务计划状态；看启动日志 |
| 登录失败（全员） | 白名单文件缺失、LDAP 不通、`AUTH_*` 环境变量丢失 | 查 `C:\talent-data\auth-allowlist.txt`、`/api/auth/status`、`ldap.wan5d.com:389`；注意连续输错触发 5 分钟限流 |
| 检索报 503 `fts_index_building` | 业务索引未 ready（dirty 未清/正在回填） | 停服跑 `converge-business-search.mjs --apply`；确认 `checkpoint=ready` 再起服务 |
| 检索 504 或 60–120 秒才返回 | 网关慢 / 重排超时 | 属已知现象；见 §10 优化项；确认 `SEARCH_QUERY_BUDGET_MS=120000` |
| `File is corrupted: vectors matrix exceeds file size` | 用了 f32 且 ≥4 GiB | 重建为 f16 索引 |
| 搜索状态 `vector.loaded=false` | 向量目录缺失/路径错/索引损坏 | 查 `SEARCH_VECTOR_DIRECTORY`、目录完整性；必要时重建向量索引（数小时） |
| 磁盘写满 / 服务异常 | 增量缓存与旧备份堆积 | 清理 `data/incremental/_zips`、旧的 `*.bak-*`（确认无需回滚后） |
| AI 助手无响应 | 网关不可用或密钥失效 | 查 `AGENT_BASE_URL`/`AGENT_API_KEY`、服务器出站、`/api/agent/status` |

---

## 10. 后续优化方向（给接手方）

### P0（建议 1 个月内）

| 项 | 说明 | 预期收益 | 工作量 |
| --- | --- | --- | --- |
| **自动备份** | 主库 + 向量 + 附件 + 认证文件每日/每周备份与恢复演练 | 消除单点数据丢失风险 | 1–2 天 |
| **增量同步归属落地** | 明确由谁执行拉取（接管开发机 / 服务器装插件 / 资产侧导出），并挂计划任务 + 失败告警 | 数据不再停滞 | 2–3 天 |
| **重排超时 + 缓存** | 给 `hybrid-search.js` 的重排调用加独立超时（如 15 s）并即时降级；相同查询加 5–10 分钟结果缓存 | 最坏 60–120 s → 约 20 s 内返回 | 1–2 天 |
| **向量索引预热** | 服务启动后主动 warmup，消除"开机第一次查询特别慢" | 首查体验 | 0.5 天 |

### P1（数据质量，1–3 个月）

| 项 | 现状 | 建议动作 |
| --- | --- | --- |
| `current_title` / `self_summary` 全空 | 119,084 人 | 从 profile.json 与解析产物回填（列表展示"最近职位"） |
| 原件无正文 | 39,502 份（约 36%） | 跑一轮"仅提取正文"（本地免费），把覆盖率补到 >90% |
| 专业/学校字段异常 | 34 人专业是 QS/985 标签、30 人学校是数字代码、8 人学历是代码 | 加清洗映射与黑名单，全库刷一遍 |
| 上游缺口 | 7 份缺文件、6 条无 candidateId | 建台账，与资产维护方对齐 |
| 检索评测集 | 仅 43 条查询 | 扩到 100+ 条并纳入回归（`scripts/evaluate-hybrid-search.mjs`） |

### P2（能力与合规，按立项推进）

| 项 | 说明 |
| --- | --- |
| RBAC / 字段级权限 | 目前白名单内人人可见敏感字段；需产品+安全立项 |
| 检索进一步提速 | 缩小业务索引字段、并行化 planner/rerank、换更快的查询模型 |
| 同步链路服务器自持 | 在服务器安装 WDCloud 插件并登录，实现"无人值守同步" |
| CI 质量门禁 | 修复既有 8 个后端测试失败，建立 `npm test` + `tsc` + 构建的流水线 |
| 文档治理 | 定期更新 `docs/SERVER_DEPLOYMENT_RECORD.md` 为真实状态；把本交接文档纳入知识库 |

---

## 11. 交接清单（逐项确认并签字）

| # | 交接内容 | 位置 | 确认 |
| --- | --- | --- | --- |
| 1 | 代码仓库访问权（GitLab 主、GitHub 备；建议转群组/团队账号） | `gitlab.wd.com/cboy/candidate-workbench` | ☐ |
| 2 | 服务器账号与部署路径（`C:\apps\talent-workbench`、`C:\talent-data`） | 192.168.8.12 | ☐ |
| 3 | 全量数据（160.71 GiB，含清单与校验方法） | `data/deploy/data-manifest.json` | ☐ |
| 4 | 首次上线脚本与步骤 | `docs/SERVER_RELEASE_HANDOVER_IT.md`、`scripts/deploy-to-server.ps1` | ☐ |
| 5 | 增量更新脚本与流程 | `scripts/pack-incremental-for-it.mjs`、`scripts/apply-incremental-package.ps1` | ☐ |
| 6 | 自检与校验脚本（32 项 + SHA256 比对） | `scripts/self-test-api.mjs`、`deployment-manifest.mjs`、`data-inventory.mjs` | ☐ |
| 7 | 认证与白名单管理方式 | `auth-allowlist.txt` / `auth.db` / LDAP 配置 | ☐ |
| 8 | 模型网关密钥归属与轮换方式 | 服务器环境变量 | ☐ |
| 9 | 已知限制与风险清单（§8） | 本文档 | ☐ |
| 10 | 后续优化路线图（§10） | 本文档 | ☐ |

| 角色 | 姓名 | 日期 | 签字 |
| --- | --- | --- | --- |
| 交出方（原开发负责人） | ______ | ______ | ______ |
| 接收方（IT） | ______ | ______ | ______ |
| 见证（上级/项目经理） | ______ | ______ | ______ |
