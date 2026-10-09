# 服务器上传清单（人才资产工作台）

面向 2026-10-09 的上线操作，沿用 C 盘项目（`C:\Users\cboy\Documents\北森`）已验证的部署形态：
**代码与数据分离、RDP 映射复制源码、服务器上 `npm ci`、任务计划自启、nginx 反代提供 HTTPS**。

> 事实来源：`C:\Users\cboy\Documents\北森\docs\DEPLOYMENT_LOCAL_SERVER.md` 与 `SERVER_DEPLOYMENT_RECORD.md`。
> 当前服务器：`192.168.8.12`（Windows Server 2022），入口 `https://talent.wooduan.com`（nginx 在 `192.168.8.167`）。

---

## 1. 目标布局

```text
C:\apps\talent-workbench\      <- 代码（本仓库，排除 node_modules / data）
C:\talent-data\recruitment.db  <- 主库文件集（db + -wal + -shm 必须同一次复制）
C:\talent-data\search-vectors\ <- 向量索引目录（f16 代际）
C:\talent-data\private\        <- 附件与导入私有目录
C:\talent-data\search-runtime.json   <- 检索运行配置（无凭据）
C:\talent-data\auth.db + auth-allowlist.txt   <- 若启用 LDAP 认证
```

## 2. 上传前（开发机 D:\talent-asset-workbench）

1. **停服务**，确认 `server/index.mjs` 进程为 0，让 WAL 合并：
   `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/index.mjs*' }`
2. 生成部署清单（用于上传后逐文件比对）：
   `node scripts/deployment-manifest.mjs --out data\deploy\local-manifest.json`
3. 打包代码：**排除** `node_modules\`、`data\`、`.git\`、`*.log`、`.tmp-*`。
4. 准备数据文件集（单独复制）：
   - `data\recruitment.db`、`data\recruitment.db-wal`、`data\recruitment.db-shm`（三件同一次复制）；
   - `data\search-vectors\`（含 `generation-*` 代际与 `embedding-cache.sqlite`）；
   - `data\private\`（附件）；
   - `data\search-runtime.json`（检索开关/模型/预算，不含密钥）。

## 3. 服务器侧步骤

1. 安装 Node.js ≥ 24（`node --version` 校验）。
2. 通过 **RDP 硬盘映射**复制源码到 `C:\apps\talent-workbench`（**不要复制 `node_modules`**：十万级小文件会静默丢失，C 盘项目已实测踩过）。
3. 复制数据文件集到 `C:\talent-data`（保持与开发机相同的相对结构）。
4. 在代码目录执行：`npm ci`，然后 `npm run build`（`start.ps1` 也会自动构建）。
5. 配置环境变量（系统级 + 用户级各一份，见 C 盘项目第 6 节），本项目必需：

| 变量 | 值 |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `4173` |
| `DB_PATH` | `C:\talent-data\recruitment.db` |
| `SEARCH_VECTOR_DIRECTORY` | `C:\talent-data\search-vectors` |
| `SEARCH_REMOTE_ENABLED` | `true` |
| `SEARCH_VECTOR_MAINTENANCE_ENABLED` | `true`（每开机周期一次增量维护） |
| `AGENT_BASE_URL` / `AGENT_API_KEY` | 模型网关（AI 助手 + 混合检索必需） |
| `NODE_USE_SYSTEM_CA` | `1`（内网 HTTPS 网关读 Windows 证书存储） |
| `AUTH_ENABLED` 及 `LDAP_*` | 按 C 盘项目第 6 节；开启前先建好白名单文件 |

   检索侧模型/预算持久化在 `data\search-runtime.json`（启动时自动加载）：
   `SEARCH_QUERY_MODEL=qwen3.8-flash`、`SEARCH_QUERY_REASONING_EFFORT=none`、
   `SEARCH_QUERY_BUDGET_MS=120000`。
6. 启动服务并验证：
   - `GET /api/health` → `status=ok`；
   - `GET /api/resume-search/status` → `hybrid.vector.available/loaded/current=true`、
     `algorithm=usearch-hnsw-cos-f16`、`query_budget_ms=120000`；
   - 真实检索 1 条（如「数值策划」）→ 200 + items 非空 + `ranking=hybrid_reranked`；
   - AI 助手发一轮问答 → 有回复且能引用候选人数据。
7. 设置任务计划 `TalentWorkbench`：操作指向 `pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "C:\apps\talent-workbench\start.ps1"`，
   起始位置为代码目录，启动延迟 2 分钟、失败重试 3 次（细节见 C 盘项目步骤 7）。

## 4. 与 C 盘项目的关键差异（本项目特有）

| 项 | 说明 |
| --- | --- |
| 向量索引必须是 **f16** | usearch 2.26.2 在 Windows 上只读 mmap 用 32 位 `GetFileSize()`，f32 索引 ≥4 GiB 必然报 `vectors matrix exceeds file size`；f16 ≈3 GB 可正常加载。状态接口必须显示 `usearch-hnsw-cos-f16`。 |
| 检索预算 | `SEARCH_QUERY_BUDGET_MS=120000`（C 盘项目 30 s；本项目 145 万向量 + 收缩后的业务索引实测需要更长预算）。 |
| 业务索引已收缩 | `search_documents_v2` 从 2,527 万行降到约 556 万行（排除 `source_record_id`/`sort_order`/`sha256`/`parse_status`/`structured_data.*`/`raw_payload.*` 等元数据）。部署后 `checkpoint=ready`、`dirty=0` 即可。 |
| worker 收敛修复 | 后台维护不再续跑历史整库回填队列（`allowBackfill:false` + 陈旧队列自愈），不会再出现"约 50 分钟一轮"的循环。 |
| 增量同步依赖 | WDCloud `talent-pool-agent` 的拉取需要本机插件与登录（`C:/Users/cboy/.codex/plugins/cache/wdcloud-plugin/...`）。服务器若要自行同步，需在服务器安装插件并登录；否则维持「开发机拉取 → 传 `data/incremental/` 增量包 → 服务器导入」。 |
| 主库体积 | 2026-10-08 收缩 + VACUUM 后 `recruitment.db` 为 **17.46 GiB**（收缩前 39.8 GiB）；业务索引 `search_documents_v2` 5,560,867 行、FTS 同步、`checkpoint=ready`、覆盖 121/121。 |
| 自测证据 | `docs/evidence/self-test-2026-10-08.json`：32/32 通过（含 AI 助手一轮问答 + 3 个只读工具）；上线后建议在服务器上重跑 `node scripts/self-test-api.mjs`。 |

## 5. 上传后一致性校验

```powershell
# 服务器上
node scripts/deployment-manifest.mjs --out C:\talent-data\deploy\server-manifest.json
# 开发机上比对（两份清单逐文件 SHA256）
node scripts/deployment-manifest.mjs --compare data\deploy\local-manifest.json <服务器拷回的 server-manifest.json>
```

`identical: true` 表示源码逐字节一致；`only_left/only_right/differ` 会列出差异文件。

## 6. 回滚

1. 停服务；
2. 恢复旧代码**和**升级前的数据库文件集（当前没有 down migration，只回退代码会留下不匹配的 schema）；
3. 启动并复核 `health` / `resume-search/status` / 一次真实检索。
