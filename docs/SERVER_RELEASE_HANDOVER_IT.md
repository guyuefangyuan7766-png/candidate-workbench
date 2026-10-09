# 发布交接单（给 IT）：人才资产工作台 0.7.0 全量上线（代码 + 全部数据）

| 项 | 内容 |
| --- | --- |
| 发布版本 | **candidate-workbench 0.7.0** |
| 发布内容 | **代码 + 全部数据整体替换**（认证文件沿用服务器现有，见第 3 节） |
| 数据总量 | 约 **160 GB**（运行必需 ≈95 GB + 留档数据 ≈65 GB） |
| 目标服务器 | `192.168.8.12`（Windows Server 2022，本地管理员 `Administrator`） |
| 替换对象 | 服务器现有部署（源自 C 盘项目 `北森`）：`C:\apps\talent-workbench`、`C:\talent-data` |
| 入口 | `https://talent.wooduan.com`（nginx 反代 → `127.0.0.1:4173`），保持不变 |
| 自启 | 任务计划 `TalentWorkbench` → `start.ps1`，保持不变 |
| 预计时长 | **1–3 小时**（160 GB 数据复制 + 构建），需停机窗口 |
| 发布包来源 | 开发机 `D:\talent-asset-workbench` |

---

## 1. 发布范围（做什么 / 不做什么）

**要做**

1. 停掉旧服务与自启任务；
2. 旧代码、旧数据**改名保留**（`*.bak-<时间戳>`，不删除）；
3. 拷贝新代码（排除 `node_modules`、`data`、`.git`、日志与临时文件）；
4. **拷贝全部数据**（见第 4 节清单：运行必需 + 原始资产快照 + 增量缓存 + 报告）；
5. **保留并沿用服务器现有的认证文件**：`auth-allowlist.txt`、`auth.db`（见第 3 节）；
6. 创建目录联接 `C:\apps\talent-workbench\data` → `C:\talent-data`（维护脚本按 `<代码>\data` 解析数据）；
7. 在服务器上 `npm ci` + `npm run build`，启动并验收。

**不要做**

- 不要复制开发机的 `node_modules`（十万级小文件经 RDP 映射会静默丢失）；
- 不要重装 Node、不要改 nginx、不要改任务计划、不要改环境变量（沿用现有配置）；
- 不要删除旧代码/旧数据目录（回滚依赖它们）；
- 不要用 f32 重建向量索引（见第 8 节）。

---

## 2. 新旧版本对照（开发已实测）

| 项 | 服务器现状（旧版，C 盘项目） | 新版本（本次发布） |
| --- | --- | --- |
| 应用版本 | 0.5.0 / 0.6.0 | **0.7.0** |
| 数据库 schema | V14（`agent_session_ownership`） | **V14（一致，无迁移缺口）** |
| `start.ps1` / `start.cmd` | — | **与旧版逐字节相同**（环境变量白名单一致） |
| 候选人数 | ≈140,381 | **119,084**（旧库完整保留为备份） |
| 简历文档 | 455,744 | **1,559,913** |
| 向量索引 | f32 / 630,978 chunk | **f16 / 1,457,263 vectors**（`generation-67619cdd-…`） |
| 业务检索索引 | ≈260 万行 | 5,560,867 行（已收缩，覆盖 121/121 ready） |
| 主库体积 | ≈38.9 GB | **17.46 GiB**（VACUUM 后） |
| 开发机自测 | — | `scripts/self-test-api.mjs` **32/32 通过** |

---

## 3. 认证文件（必须沿用服务器现有，不得用开发机版本覆盖）

服务器以 `AUTH_ENABLED=true` + 公司 LDAP 运行，认证状态不在代码仓库里：

| 文件 | 路径（服务器） | 处理方式 |
| --- | --- | --- |
| 账号白名单 | `C:\talent-data\auth-allowlist.txt` | **必须沿用服务器现有文件**（删人最迟 30 秒生效） |
| 认证库（会话） | `C:\talent-data\auth.db`（含 `-wal`/`-shm`） | **必须沿用服务器现有文件** |

部署脚本内置两道保护：① **前置校验**——`AUTH_ENABLED=true` 而白名单缺失时**直接拒绝执行**、不动任何文件；
② **自动带回**——替换数据时把旧数据目录里的 `auth-allowlist.txt`、`auth.db(-wal/-shm)` 复制进新目录
（输出 `carrying over auth file …`）。

---

## 4. 数据交接清单（全量）

数据来源：开发机 `D:\talent-asset-workbench\data\`；服务器落点：`C:\talent-data\`（保持相同相对结构）。
完整清单（含每个条目的文件数与 SHA256）见 **`data/deploy/data-manifest.json`**。

### 4.1 运行必需（服务器必须）

| 条目 | 开发机路径 | 大小 | 服务器落点 |
| --- | --- | ---: | --- |
| 主库 | `data\recruitment.db`（+ `-wal`/`-shm`） | 17.46 GiB | `C:\talent-data\recruitment.db` |
| 向量索引 | `data\search-vectors\` | 27.66 GB | `C:\talent-data\search-vectors\` |
| 附件目录 | `data\private\` | 49.79 GB | `C:\talent-data\private\` |
| 检索配置 | `data\search-runtime.json` | <1 MB | `C:\talent-data\search-runtime.json` |
| 小计 | | **≈95 GB** | |

### 4.2 留档数据（建议一起交接，服务器非必需）

| 条目 | 开发机路径 | 大小 | 说明 |
| --- | --- | ---: | --- |
| 原始资产快照 | `data\asset-export\` | 47.88 GB | 上游共享资产的原始档案/简历/索引（47.9 GB） |
| 增量缓存 | `data\incremental\` | 17.64 GB | 各轮增量拉取的分片与解压产物（后续增量同步复用） |
| 小计 | | **≈65 GB** | |

### 4.3 报告与审计（小体积，建议一起交接）

`data\phase3-full-report.json`（约 110 MB）、`data\avatar-audit\`、`data\parse-retry-list.jsonl`、
`data\self-test-report.json`、`data\business-search-shrink-report.jsonl` 等。

### 4.4 可忽略（开发机临时产物）

`data\*.log`、`data\*.pid`、`data\extract-*\`、`data\phase3-b2000-*\` 等调试输出（总量 <1 GB）。

### 4.5 完整性校验（开发机与服务器各跑一次）

```powershell
# 开发机：生成清单（含 recruitment.db 的 SHA256）
node scripts/data-inventory.mjs --out data\deploy\data-manifest.json

# 服务器（数据拷完后）：按清单核对文件数、字节数与主库 SHA256
node scripts/data-inventory.mjs --verify C:\talent-data\deploy\data-manifest.json
```

`{"verified": true, ...}` 表示数据与开发机逐项一致；出现差异时会逐条列出 `missing / files_mismatch / bytes_mismatch / sha256_mismatch`。

---

## 5. 发布步骤（首次全量）

### 5.1 发布前检查

- [ ] 已通知使用方进入停机窗口（期间不要检索、不要导入）；
- [ ] **开发机本地服务已停止**（`server/index.mjs` 进程为 0），否则主库/WAL 可能在复制中变化；
- [ ] 服务器 `C:` 剩余空间 **≥300 GB**（新数据 ≈160 GB + 旧数据保留 ≈60 GB）；
- [ ] 确认 `C:\talent-data\auth-allowlist.txt` 存在；
- [ ] Node ≥24（现有 v26.9.0 满足）；
- [ ] 开发机已生成代码清单 `data\deploy\local-manifest.json` 与数据清单 `data\deploy\data-manifest.json`。

### 5.2 执行（RDP 磁盘映射 + 一条命令）

1. 管理员 RDP 登录时映射开发机 D 盘：`mstsc /v:192.168.8.12 /drive:D,`（会话内可见 `\\tsclient\D`）。
2. 先看计划（不落盘）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "\\tsclient\D\talent-asset-workbench\scripts\deploy-to-server.ps1" -SourceRoot "\\tsclient\D\talent-asset-workbench" -IncludeArchive -DryRun
   ```

3. 确认无误后正式执行（`-IncludeArchive` = 连原始快照与增量缓存一起交接）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "\\tsclient\D\talent-asset-workbench\scripts\deploy-to-server.ps1" -SourceRoot "\\tsclient\D\talent-asset-workbench" -IncludeArchive
   ```

   脚本顺序：停服务与任务 → 旧代码/数据改名备份 → 拷新代码 → 拷数据（运行必需 + 留档）→
   带回认证文件 → 创建 `data` 目录联接 → `npm ci` → `npm run build`。

### 5.3 启动

```powershell
Start-ScheduledTask -TaskName TalentWorkbench
```

---

## 6. 验收清单（逐条打勾）

| # | 检查 | 期望 |
| --- | --- | --- |
| 1 | `Invoke-RestMethod http://127.0.0.1:4173/api/health` | `status=ok`（公开接口） |
| 2 | 登录后打开 `https://talent.wooduan.com/api/resume-search/status` | `ready=true`；`vector.available/loaded/current=true`；`algorithm=usearch-hnsw-cos-f16`；`query_budget_ms=120000` |
| 3 | 界面真实检索一条（如「数值策划」） | 有结果、无报错（宽泛查询 20–70 秒属正常） |
| 4 | 自测脚本：`node scripts/self-test-api.mjs --cookie "tw_session=<值>"`（或临时 `AUTH_ENABLED=false`、`PORT=4174` 起诊断实例） | **32/32 通过** |
| 5 | 浏览器登录 `https://talent.wooduan.com` | 登录成功；未登录访问 `/api/candidates` 返回 401；**连续输错会触发 5 分钟限流** |
| 6 | AI 助手提问一句 | 有回答且引用真实候选人 |
| 7 | 代码一致性：服务器 `node scripts/deployment-manifest.mjs --out C:\talent-data\deploy\server-manifest.json`，开发机 `--compare` | `identical: true` |
| 8 | 数据一致性：服务器 `node scripts/data-inventory.mjs --verify C:\talent-data\deploy\data-manifest.json` | `verified: true` |
| 9 | 抽查：随机打开 1 份附件原件预览、1 位候选人的「附件简历」页签 | 正常渲染 |

---

## 7. 回滚（约 5 分钟）

1. 停服务与任务：`Stop-ScheduledTask -TaskName TalentWorkbench`，并结束 `server/index.mjs` 进程；
2. 新目录改名为 `*.failed-<时间>`；
3. 把 `C:\apps\talent-workbench.bak-<时间戳>`、`C:\talent-data.bak-<时间戳>` 改回原名；
4. 启动任务，复核第 6 节第 1、2、5 项。

> 没有 down migration：**回滚必须"代码 + 数据"一起回滚**。认证文件在备份目录里同样保留。

---

## 8. 已知限制与注意事项

1. **向量索引必须是 f16**：Windows 上 usearch 2.26.2 的只读 mmap 用 32 位 `GetFileSize()`，
   f32 索引 ≥4 GiB 会报 `File is corrupted: vectors matrix exceeds file size` 并打不开；f16（≈3 GB）正常。
2. **检索耗时**：宽泛两词查询实测 20–70 秒，预算 120 秒；偶发 `rerank_unavailable` 降级（结果仍返回，排序退回 RRF）。
3. **业务索引已收缩**：Agent 的"全字段检索"不再覆盖 `source_record_id` / `sha256` / `parse_status` /
   `structured_data.*` / `raw_payload.*` 等元数据（业务确认后的取舍）；这些数据仍可用 SQL 精确查询。
4. **认证**：白名单删人最迟 30 秒生效；紧急撤销全部会话用 `AUTH_SESSION_REVOKE_ALL=true` 重启一次，用完移除。
5. **开机维护**：`SEARCH_VECTOR_MAINTENANCE_ENABLED=true` 时每次开机做一次增量向量维护（约 20–60 秒）。
6. **脚本状态**：`deploy-to-server.ps1` 已在开发机通过语法校验与 DryRun，**尚未在服务器实跑过**；请先看一次 `-DryRun` 输出。

---

## 9. 附录：后续数据更新（可选，增量而不是整库）

首次发布之后若只是常规更新（新增/变更少量候选人），不必再传 160 GB：

**开发侧产出增量包**

```powershell
node scripts/incremental-sync.mjs --check
node scripts/incremental-sync.mjs --download --targeted --profiles-full
node scripts/pack-incremental-for-it.mjs --apply        # 产出 data\packages\incremental-<时间戳>.zip
```

**IT 侧应用**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\apps\talent-workbench\scripts\apply-incremental-package.ps1" -Package "<zip 路径>"
```

（可选参数 `-SkipParse` / `-SkipVector` / `-DryRun`；不要直接覆盖 `recruitment.db`，增量一律走导入脚本。）

---

## 10. 交付信息

| 项 | 内容 |
| --- | --- |
| 发布包路径 | `D:\talent-asset-workbench`（版本 0.7.0） |
| 代码清单 | `data\deploy\local-manifest.json`（595 个文件，SHA256） |
| **数据清单** | **`data\deploy\data-manifest.json`（条目级文件数/字节数 + 主库 SHA256）** |
| 首次部署脚本 | `scripts\deploy-to-server.ps1`（`-IncludeArchive` 携带留档数据）、`scripts\run-deploy-on-server.cmd` |
| 数据校验脚本 | `scripts\data-inventory.mjs`（`--out` 生成 / `--verify` 校验） |
| 代码校验脚本 | `scripts\deployment-manifest.mjs`（`--out` / `--compare`） |
| 自检脚本 | `scripts\self-test-api.mjs`（32 项） |
| 后续增量同步 | `scripts\pack-incremental-for-it.mjs`（开发侧）、`scripts\apply-incremental-package.ps1`（服务器侧） |
| 变更记录 | `CHANGELOG.md`（0.7.0 条目） |
| 测试证据 | `docs\TESTING.md`（2026-10-08 章节）、`docs\evidence\self-test-2026-10-08.json` |
| 数据库 | 119,084 候选人 / 1,559,913 简历文档 / schema V14 / 17.46 GiB |
| 向量索引 | f16 / 1,457,263 vectors / `generation-67619cdd-2943-4de6-9010-6533a821f8c2` |
| 建议发布窗口 | ______（业务低峰，1–3 小时） |
| 发布执行人 / 复核人 | ______ / ______ |
| 完成时间 | ______ |
