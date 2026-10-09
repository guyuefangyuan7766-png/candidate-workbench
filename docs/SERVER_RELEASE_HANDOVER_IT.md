# 发布交接单：人才资产工作台 0.7.0（替换服务器现有版本）

**交付方**：开发（CBOY-01933 / D:\talent-asset-workbench）
**接收方**：IT（服务器 192.168.8.12）
**版本**：candidate-workbench **0.7.0**（上一版服务器部署为 C 盘项目 `北森` 的 0.5.0/0.6.0）

---

## 0. 结论先行

**可以原位替换，不需要重新部署一套**：

- 代码路径、数据路径、启动脚本、任务计划、环境变量与现有部署完全一致；
- 两边数据库 schema 都是 **V14**（`agent_session_ownership`），无需迁移步骤；
- 替换后仍由 nginx 提供 `https://talent.wooduan.com`，仍由任务计划 `TalentWorkbench` 开机自启。

需要 IT 确认的两点：

1. **数据是否一起替换**（新库 119,084 人 / 156 万简历文档；服务器现有库约 140,381 人 / 45.6 万简历文档）。
   推荐一起替换（新功能围绕新库）；旧目录不改回删除，只改名备份，可回滚。
2. **认证文件必须保留**：`C:\talent-data\auth-allowlist.txt` 与 `auth.db` 要沿用服务器现有文件
   （替换数据目录时不要覆盖成开发机版本——开发机没有这两个文件，部署脚本会自动从备份里带过来）。

---

## 1. 新旧版本对照（开发已实测）

| 项 | 服务器现状（C 盘项目） | 新版本（本项目） |
| --- | --- | --- |
| 代码目录 | `C:\apps\talent-workbench` | 同（原位替换） |
| 数据目录 | `C:\talent-data` | 同（原位替换） |
| 自启任务 | `TalentWorkbench` → `start.ps1` | 同（脚本与旧版逐字节一致） |
| 入口 | nginx → `127.0.0.1:4173`（HTTPS） | 同 |
| 应用版本 | 0.5.0 / 0.6.0 | **0.7.0** |
| 数据库 schema | V14 | **V14**（一致） |
| 候选人数 | ≈140,381 | **119,084** |
| 简历文档数 | 455,744 | **1,559,913** |
| 向量索引 | f32 / 630,978 chunk | **f16** / 1,457,263 vectors（generation-67619cdd…） |
| 业务检索索引 | ≈260 万行 | 5,560,867 行（已按新策略收缩，覆盖 121/121 ready） |
| 主库体积 | ≈38.9 GB | **17.46 GiB**（VACUUM 后） |
| Node 要求 | ≥24（服务器 v26.9.0 ✓） | ≥24（同） |

**关键差异**：向量索引必须是 **f16**。usearch 2.26.2 在 Windows 上只读 mmap 用 32 位
`GetFileSize()`，f32 索引 ≥4 GiB 会报 `File is corrupted: vectors matrix exceeds file size`
且无法打开；f16（≈3 GB）才能正常加载。**请勿用 f32 重建向量索引。**

---

## 2. 交付物清单

| 内容 | 位置（开发机） | 说明 |
| --- | --- | --- |
| 源代码 | `D:\talent-asset-workbench`（排除 `node_modules`、`data`、`.git`、`*.log`、`.tmp-*`） | 594 个文件，清单见下表 |
| 文件清单 | `data\deploy\local-manifest.json` | 逐文件 SHA256，用于验收比对 |
| 数据：主库 | `data\recruitment.db`、`-wal`、`-shm` | 三件同一次复制 |
| 数据：向量 | `data\search-vectors\` | 28.3 GB（含 `embedding-cache.sqlite`） |
| 数据：附件 | `data\private\` | 51 GB |
| 检索配置 | `data\search-runtime.json` | 预算 120000 ms / planner qwen3.8-flash |
| 部署脚本 | `scripts\deploy-to-server.ps1`、`data\deploy\run-deploy.cmd` | 一键原位替换（含备份） |
| 自测脚本 | `scripts\self-test-api.mjs` | 32 项检查（含 AI 助手） |
| 一致性脚本 | `scripts\deployment-manifest.mjs` | 生成/比对 SHA256 清单 |

复制总容量约 **97 GB**（DB 17.9 + 向量 28.3 + 附件 51），预计 20–60 分钟（走 RDP 映射或内网共享）。

---

## 3. 发布步骤（推荐路径：RDP 磁盘映射 + 一条命令）

**前置检查**：① 服务器 C 盘剩余 ≥250 GB；② 已通知使用方停用（停机窗口内没人检索）；
③ Node ≥24（现有 v26.9.0 满足）。

1. 用管理员 RDP 登录 `192.168.8.12`，连接时勾选/映射开发机 D 盘：
   `mstsc /v:192.168.8.12 /drive:D,`（会话内出现 `\\tsclient\D`）
2. 在服务器上以**管理员 PowerShell** 执行：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "\\tsclient\D\talent-asset-workbench\scripts\deploy-to-server.ps1" -SourceRoot "\\tsclient\D\talent-asset-workbench"
   ```

   或双击 `\\tsclient\D\talent-asset-workbench\data\deploy\run-deploy.cmd`。

   脚本按顺序做（不会删除任何东西）：
   - 停止 `server/index.mjs` 进程与 `TalentWorkbench` 任务；
   - 旧代码 → `C:\apps\talent-workbench.bak-<时间戳>`，旧数据 → `C:\talent-data.bak-<时间戳>`；
   - robocopy 拷贝新代码（排除 `node_modules`/`data`/`.git`/日志/临时文件）；
   - robocopy 拷贝数据（DB 三件套 + 向量 + 附件 + `search-runtime.json`）；
   - **从旧数据备份里带回** `auth-allowlist.txt`、`auth.db(-wal/-shm)`；
   - `npm ci` + `npm run build`。
3. 核对环境变量（系统级 + 用户级都要有；沿用现有配置即可，不要清空）：

   ```
   HOST=127.0.0.1   PORT=4173
   DB_PATH=C:\talent-data\recruitment.db
   SEARCH_VECTOR_DIRECTORY=C:\talent-data\search-vectors
   SEARCH_REMOTE_ENABLED=true   SEARCH_VECTOR_MAINTENANCE_ENABLED=true
   AGENT_BASE_URL / AGENT_API_KEY / AGENT_MODEL
   NODE_USE_SYSTEM_CA=1
   AUTH_ENABLED=true  LDAP_URL / LDAP_USER_DN_TEMPLATE / LDAP_ALLOW_PLAINTEXT
   AUTH_ALLOWLIST_FILE=C:\talent-data\auth-allowlist.txt
   AUTH_DB_PATH=C:\talent-data\auth.db
   AUTH_COOKIE_SECURE=true  AUTH_TRUST_PROXY=true
   ```
4. 启动服务：`Start-ScheduledTask -TaskName TalentWorkbench`（或直接跑 `start.ps1`）。

---

## 4. 验收清单（逐条打勾）

| # | 检查 | 期望 |
| --- | --- | --- |
| 1 | `Invoke-RestMethod http://127.0.0.1:4173/api/health` | `status=ok` |
| 2 | 登录后在浏览器打开 `https://talent.wooduan.com/api/resume-search/status`（带会话 Cookie） | `ready=true`；`vector.available/loaded/current=true`；`algorithm=usearch-hnsw-cos-f16`；`query_budget_ms=120000`。注：开启认证后只有 `/api/health`、`/api/auth/*` 是公开接口，其余需要登录态 |
| 3 | 真实检索一条（如「数值策划」） | HTTP 200、items 非空、`ranking=hybrid_reranked` 或 `rrf`；记录耗时 |
| 4 | 自测脚本（在代码目录）：浏览器登录后取会话 Cookie，再 `node scripts/self-test-api.mjs --cookie "tw_session=<值>"`；或临时以 `AUTH_ENABLED=false`、`PORT=4174` 另起一个实例做本地自检（验完立即停掉） | 期望 **32/32**（开发机 2026-10-08 实测 32/32，证据 `docs/evidence/self-test-2026-10-08.json`） |
| 5 | 浏览器打开 `https://talent.wooduan.com`，用白名单账号登录 | 登录成功、侧栏显示账号；未登录访问 `/api/candidates` 返回 401。**注意：连续输错会触发 5 分钟限流** |
| 6 | AI 助手提问一句（如"给我一位候选人的姓名"） | 有回答且引用真实候选人 |
| 7 | 文件一致性：服务器上 `node scripts/deployment-manifest.mjs --out C:\talent-data\deploy\server-manifest.json`，开发机 `node scripts/deployment-manifest.mjs --compare data\deploy\local-manifest.json <server-manifest.json>` | `identical: true` |

---

## 5. 回滚（约 5 分钟）

1. 停服务与任务：`Stop-ScheduledTask -TaskName TalentWorkbench` + 结束 `server/index.mjs` 进程；
2. 把新目录改名为 `*.failed-<时间>`，把 `*.bak-<时间戳>` 改回 `C:\apps\talent-workbench` 与 `C:\talent-data`；
3. 启动任务 → 复核第 4 节第 1、2、5 项。

**注意：本应用没有 down migration，回滚必须"代码 + 数据"一起回滚**（只回代码会留下不匹配的 schema）。

---

## 6. 已知限制与注意事项（交接重点）

1. **不要复制 `node_modules`**：十万级小文件经 RDP 映射会静默丢失，必须在服务器上 `npm ci`。
2. **向量索引必须是 f16**（见第 1 节），不要用 f32 重建。
3. **检索耗时**：宽泛查询（两词意图）实测 20–70 秒；预算已放宽到 120 秒；偶发 `rerank_unavailable`
   降级（结果仍返回，排序退回 RRF）。不要在检索中重复提交同一查询（会叠加负载）。
4. **业务索引已收缩**：Agent 的"全字段检索"不再覆盖 `source_record_id` / `sha256` / `parse_status` /
   `structured_data.*` / `raw_payload.*` 等元数据（业务确认后的取舍）；这些数据仍可用 SQL 精确查询。
5. **认证**：白名单文件删除某账号最迟 30 秒生效，不需要重启；紧急撤销全部会话用
   `AUTH_SESSION_REVOKE_ALL=true` 重启一次，用完立即移除。
6. **开机维护**：`SEARCH_VECTOR_MAINTENANCE_ENABLED=true` 时每次开机做一次增量向量维护（约 20–60 秒），
   期间检索可用但略慢。
7. **数据更新（同步）**：目前依赖开发机的 WDCloud 插件拉取增量（服务器自身拉不了）。发布后若要让数据持续更新，
   需约定"开发机拉取 → 传 `data\incremental\` 增量包 → 服务器执行导入"的流程，或在服务器安装插件并登录。
8. **本次发布脚本尚未在服务器实跑过**（开发机 dry-run 通过）。首次执行建议先加 `-DryRun` 看一遍计划。

---

## 7. 交付信息

- 发布包来源：`D:\talent-asset-workbench`（版本 0.7.0）
- 变更记录：`CHANGELOG.md`（0.7.0 条目）
- 测试记录：`docs/TESTING.md` 2026-10-08 章节、`docs/evidence/self-test-2026-10-08.json`
- 上传清单：`docs/SERVER_UPLOAD_CHECKLIST.md`
- 建议发布窗口：______（业务低峰，预计 30–60 分钟）
- 发布执行人：______　复核人：______　完成时间：______
