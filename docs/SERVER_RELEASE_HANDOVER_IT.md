# 发布交接单（给 IT）：人才资产工作台 0.7.0 全量上线

| 项 | 内容 |
| --- | --- |
| 发布版本 | **candidate-workbench 0.7.0** |
| 发布内容 | **代码 + 数据整体替换**（认证文件沿用服务器现有，见第 3 节） |
| 目标服务器 | `192.168.8.12`（Windows Server 2022，本地管理员 `Administrator`） |
| 替换对象 | 服务器现有部署（源自 C 盘项目 `北森`）：`C:\apps\talent-workbench`、`C:\talent-data` |
| 入口 | `https://talent.wooduan.com`（nginx 反代 → `127.0.0.1:4173`），保持不变 |
| 自启 | 任务计划 `TalentWorkbench` → `start.ps1`，保持不变 |
| 预计时长 | **30–60 分钟**（取决于 ~97 GB 数据复制速度），需停机窗口 |
| 发布包来源 | 开发机 `D:\talent-asset-workbench`（或由开发拷贝到共享目录） |

---

## 1. 发布范围（做什么 / 不做什么）

**要做**

1. 停掉旧服务与自启任务；
2. 旧代码、旧数据**改名保留**（`*.bak-<时间戳>`，不删除）；
3. 拷贝新代码（排除 `node_modules`、`data`、`.git`、日志与临时文件）；
4. **整体替换数据**：主库三件套、向量索引目录、附件目录、检索配置文件；
5. **保留并沿用服务器现有的认证文件**：`auth-allowlist.txt`、`auth.db`（详见第 3 节）；
6. 在服务器上 `npm ci` + `npm run build`；
7. 启动服务并按第 5 节验收。

**不要做**

- 不要复制开发机的 `node_modules`（十万级小文件经 RDP 映射会静默丢失）；
- 不要重装 Node、不要改 nginx、不要改任务计划、不要改环境变量（沿用现有配置即可）；
- 不要删除旧代码/旧数据目录（回滚依赖它们）；
- 不要用 f32 重建向量索引（见第 7 节）。

---

## 2. 新旧版本对照（开发已实测）

| 项 | 服务器现状（旧版，C 盘项目） | 新版本（本次发布） |
| --- | --- | --- |
| 应用版本 | 0.5.0 / 0.6.0 | **0.7.0** |
| 数据库 schema | V14（`agent_session_ownership`） | **V14（一致，无迁移缺口）** |
| `start.ps1` / `start.cmd` | — | **与旧版逐字节相同**（环境变量白名单一致） |
| 候选人数 | ≈140,381 | **119,084**（旧库完整保留为备份） |
| 简历文档 | 455,744 | **1,559,913**（含原件解析产物） |
| 向量索引 | f32 / 630,978 chunk | **f16 / 1,457,263 vectors**（`generation-67619cdd-…`） |
| 业务检索索引 | ≈260 万行 | 5,560,867 行（已按新策略收缩，覆盖 121/121 ready） |
| 主库体积 | ≈38.9 GB | **17.46 GiB**（VACUUM 后） |
| 开发机自测 | — | `scripts/self-test-api.mjs` **32/32 通过**（证据 `docs/evidence/self-test-2026-10-08.json`） |

> 数据替换是**明确要求**：新版本的解析产物、f16 向量索引与收缩后的业务索引都基于新库；
> 旧库不删除，改名保留在 `C:\talent-data.bak-<时间戳>`，随时可整体回滚（第 6 节）。

---

## 3. 认证文件（必须沿用服务器现有，不得用开发机版本覆盖）

服务器以 `AUTH_ENABLED=true` + 公司 LDAP 运行，认证状态不在代码仓库里：

| 文件 | 路径（服务器） | 处理方式 |
| --- | --- | --- |
| 账号白名单 | `C:\talent-data\auth-allowlist.txt` | **必须沿用服务器现有文件**（一行一个登录名；删人最迟 30 秒生效） |
| 认证库（会话） | `C:\talent-data\auth.db`（含 `-wal`/`-shm`） | **必须沿用服务器现有文件**（保存的是会话令牌哈希，可安全保留） |

部署脚本已经内置两道保护：

1. **前置校验**：如果 `AUTH_ENABLED=true` 而 `C:\talent-data\auth-allowlist.txt` 不存在，脚本**直接拒绝执行**，
   不会动任何文件；
2. **自动带回**：替换数据时把旧数据目录里的 `auth-allowlist.txt`、`auth.db(-wal/-shm)` 复制进新数据目录
   （输出 `carrying over auth file …`）。

如果白名单文件真的丢失，请先从备份 `C:\talent-data.bak-*` 取回，再重新执行发布。

---

## 4. 发布步骤

### 4.1 发布前检查（5 分钟）

- [ ] 已通知使用方进入停机窗口（期间不要检索、不要导入）；
- [ ] **开发机本地服务已停止**（`server/index.mjs` 进程为 0）——否则复制过程中主库/WAL 可能变化，导致数据不一致；
- [ ] 服务器 `C:` 剩余空间 **≥250 GB**（新数据 ≈97 GB + 旧数据保留 ≈60 GB）；
- [ ] 确认 `C:\talent-data\auth-allowlist.txt` 存在；
- [ ] 确认 Node ≥24（现有 v26.9.0 满足）；
- [ ] 开发机已生成文件清单 `data\deploy\local-manifest.json`（594 个文件，SHA256）。

### 4.2 执行（推荐：RDP 磁盘映射 + 一条命令）

1. 管理员 RDP 登录服务器时映射开发机 D 盘：`mstsc /v:192.168.8.12 /drive:D,`（会话内可见 `\\tsclient\D`）。
2. 在服务器上以**管理员 PowerShell** 先看计划（不落盘）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "\\tsclient\D\talent-asset-workbench\scripts\deploy-to-server.ps1" -SourceRoot "\\tsclient\D\talent-asset-workbench" -DryRun
   ```

3. 确认无误后正式执行（或双击 `\\tsclient\D\talent-asset-workbench\scripts\run-deploy-on-server.cmd`）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "\\tsclient\D\talent-asset-workbench\scripts\deploy-to-server.ps1" -SourceRoot "\\tsclient\D\talent-asset-workbench"
   ```

   脚本按顺序执行：停服务与任务 → 旧代码/数据改名备份 → 拷新代码 → 拷数据（DB 三件套 + 向量 + 附件 +
   `search-runtime.json`）→ 带回认证文件 → `npm ci` → `npm run build`。

### 4.3 启动

```powershell
Start-ScheduledTask -TaskName TalentWorkbench
```

（或按现有运维手册直接运行 `C:\apps\talent-workbench\start.ps1`。）

---

## 5. 验收清单（逐条打勾）

| # | 检查 | 期望 |
| --- | --- | --- |
| 1 | `Invoke-RestMethod http://127.0.0.1:4173/api/health` | `status=ok`（该接口公开，无需登录） |
| 2 | 浏览器登录后打开 `https://talent.wooduan.com/api/resume-search/status` | `ready=true`；`vector.available/loaded/current=true`；`algorithm=usearch-hnsw-cos-f16`；`query_budget_ms=120000` |
| 3 | 在界面真实检索一条（如「数值策划」） | 有结果、无报错；记录耗时（宽泛查询 20–70 秒属正常） |
| 4 | 自测脚本：浏览器取会话 Cookie 后 `node scripts/self-test-api.mjs --cookie "tw_session=<值>"`（或临时以 `AUTH_ENABLED=false`、`PORT=4174` 另起诊断实例） | **32/32 通过** |
| 5 | 浏览器打开 `https://talent.wooduan.com`，用白名单账号登录 | 登录成功、侧栏显示账号；未登录访问 `/api/candidates` 返回 401。**连续输错会触发 5 分钟限流** |
| 6 | AI 助手提问一句（如"给我一位候选人的姓名"） | 有回答且引用真实候选人数据 |
| 7 | 一致性：服务器 `node scripts/deployment-manifest.mjs --out C:\talent-data\deploy\server-manifest.json`，开发机 `node scripts/deployment-manifest.mjs --compare data\deploy\local-manifest.json <server-manifest.json>` | `identical: true` |
| 8 | 抽查：随机打开 1 份附件的原件预览、1 位候选人的"附件简历"页签 | 正常渲染 |

---

## 6. 回滚（约 5 分钟）

1. 停服务与任务：`Stop-ScheduledTask -TaskName TalentWorkbench`，并结束 `server/index.mjs` 进程；
2. 把新目录改名为 `*.failed-<时间>`；
3. 把 `C:\apps\talent-workbench.bak-<时间戳>`、`C:\talent-data.bak-<时间戳>` 改回原名；
4. 启动任务，复核第 5 节第 1、2、5 项。

> 本应用没有 down migration：**回滚必须"代码 + 数据"一起回滚**，只回代码会留下不匹配的 schema。
> 认证文件（`auth-allowlist.txt` / `auth.db`）在新旧数据目录里都保留着，回滚不需要额外处理。

---

## 7. 已知限制与注意事项

1. **向量索引必须是 f16**：usearch 2.26.2 在 Windows 上的只读 mmap 使用 32 位 `GetFileSize()`，
   f32 索引 ≥4 GiB 会报 `File is corrupted: vectors matrix exceeds file size` 且无法打开；f16（≈3 GB）正常。
   如遇向量重建，务必以 f16 进行。
2. **检索耗时**：宽泛两词查询实测 20–70 秒；预算已放宽至 120 秒；偶发 `rerank_unavailable` 降级
   （结果仍返回，排序退回 RRF）。请勿重复提交同一查询。
3. **业务索引已收缩**：Agent 的"全字段检索"不再覆盖 `source_record_id` / `sha256` / `parse_status` /
   `structured_data.*` / `raw_payload.*` 等元数据（业务确认后的取舍）；这些数据仍可经 SQL 精确查询。
4. **开机维护**：`SEARCH_VECTOR_MAINTENANCE_ENABLED=true` 时每次开机做一次增量向量维护（约 20–60 秒），
   期间检索可用但略慢。
5. **认证**：白名单删除账号最迟 30 秒生效；紧急撤销全部会话用 `AUTH_SESSION_REVOKE_ALL=true` 重启一次，
   用完立即移除。
6. **数据更新（增量同步）**：目前依赖开发机的 WDCloud 插件拉取（服务器自身无法拉取）。
   发布后如需持续更新数据，请与开发约定："开发机拉取 → 传 `data\incremental\` 增量包 → 服务器执行导入"，
   或在服务器安装该插件并登录（需另行审批）。
7. **脚本状态**：`deploy-to-server.ps1` 已在开发机通过 DryRun 与语法校验，**尚未在服务器实跑过**；
   请按 4.2 先看一次 DryRun 输出再正式执行。

---

## 8. 交付信息

| 项 | 内容 |
| --- | --- |
| 发布包路径 | `D:\talent-asset-workbench`（版本 0.7.0；文件清单 `data\deploy\local-manifest.json`） |
| 部署脚本 | `scripts\deploy-to-server.ps1`、`scripts\run-deploy-on-server.cmd` |
| 变更记录 | `CHANGELOG.md`（0.7.0 条目） |
| 测试证据 | `docs/TESTING.md`（2026-10-08 章节）、`docs/evidence/self-test-2026-10-08.json` |
| 上传清单（内部） | `docs/SERVER_UPLOAD_CHECKLIST.md` |
| 数据库 | 119,084 候选人 / 1,559,913 简历文档 / schema V14 / 17.46 GiB |
| 向量索引 | f16 / 1,457,263 vectors / `generation-67619cdd-2943-4de6-9010-6533a821f8c2` |
| 建议发布窗口 | ______（业务低峰，30–60 分钟） |
| 发布执行人 / 复核人 | ______ / ______ |
| 完成时间 | ______ |

