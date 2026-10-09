# 数据包提取与部署说明（给 IT）

本文说明如何把「人才资产工作台」交接的数据包（5 个 store 模式 zip，只打包**不压缩**，合计约 **161 GB**）
提取到服务器并完成部署。

> 与本文配套：`transfer\README.txt`（ASCII 速查版，随包一起）、
> `docs\PROJECT_HANDOVER_IT.md`（项目整体交接）、`docs\SERVER_RELEASE_HANDOVER_IT.md`（发布交接单）。

---

## 1. 数据包清单

包位于共享目录 `\\192.168.190.58\talent-workbench\transfer\`：

| 包 | 内容 | 大小 | 条目数 | 是否必需 |
| --- | --- | ---: | ---: | --- |
| `01-database.zip` | `recruitment.db` + `-wal`/`-shm` + `search-runtime.json` + `deploy\`（清单） | 17.46 GiB | 17 | **必需** |
| `02-vectors.zip` | `search-vectors\`（f16 usearch 索引 + embedding 缓存 + 代际） | 27.66 GB | 12 | **必需** |
| `03-attachments.zip` | `private\`（简历附件） | 49.86 GB | 260,464 | **必需** |
| `04-archive.zip` | `asset-export\` + `incremental\`（原始资产快照与增量缓存，留档用） | 66.01 GB | 1,714,229 | 可选 |
| `05-reports.zip` | 解析/评测报告 | 0.13 GB | 108 | 可选 |

- 包内路径就是 `C:\talent-data` 的相对结构（例如 `02-vectors.zip` 里是 `search-vectors/...`），**直接解到该目录即可**。
- store 模式：没有压缩，解包几乎不耗 CPU，耗时主要是磁盘写入（本机打包总耗时约 17 分钟，解包时间相近）。
- 目录下另有 `README.txt`（速查）、`pack.log`（打包记录）。

---

## 2. 前置检查

```powershell
# 1) 服务器 C: 剩余空间 ≥300 GB（新数据 161 GB + 旧数据备份约 60 GB + 余量）
Get-Volume -DriveLetter C | Select-Object DriveLetter, @{n='FreeGB';e={[math]::Round($_.SizeRemaining/1GB,1)}}

# 2) 旧数据目录里的认证文件必须存在（LDAP 白名单与会话库，替换数据前要保留）
Test-Path C:\talent-data\auth-allowlist.txt

# 3) 数一下包是否齐全（应为 5 个 zip）
Get-ChildItem \\192.168.190.58\talent-workbench\transfer\*.zip | Select-Object Name, @{n='GB';e={[math]::Round($_.Length/1GB,2)}}
```

---

## 3. 提取步骤（停服窗口内执行）

```powershell
# ① 停服务与自启任务
Stop-ScheduledTask -TaskName TalentWorkbench
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server/index.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# ② 旧数据目录改名保留（不删除；认证文件就在里面）
Rename-Item C:\talent-data C:\talent-data.bak-20261009-<时间>
New-Item -ItemType Directory C:\talent-data | Out-Null

# ③ 依次解包（Windows 自带 tar；建议按 01→05 顺序）
cd \\192.168.190.58\talent-workbench\transfer
tar -xf 01-database.zip    -C C:\talent-data
tar -xf 02-vectors.zip     -C C:\talent-data
tar -xf 03-attachments.zip -C C:\talent-data
tar -xf 04-archive.zip     -C C:\talent-data     # 可选（留档数据）
tar -xf 05-reports.zip     -C C:\talent-data     # 可选

# ④ 认证文件沿用服务器原有（从备份里拷回）
Copy-Item C:\talent-data.bak-20261009-<时间>\auth-allowlist.txt C:\talent-data\ -Force
Copy-Item C:\talent-data.bak-20261009-<时间>\auth.db* C:\talent-data\ -Force -ErrorAction SilentlyContinue
```

> **不要用 f32 重建向量索引**：Windows 上 usearch 的只读 mmap 用 32 位 `GetFileSize()`，
> f32 索引 ≥4 GiB 会报 `File is corrupted: vectors matrix exceeds file size`；`02-vectors.zip` 里就是必需的 f16 索引。

---

## 4. 代码部署（数据已手工解包 → 用 `-SkipData`）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File "\\192.168.190.58\talent-workbench\scripts\deploy-to-server.ps1" `
  -SourceRoot "\\192.168.190.58\talent-workbench" -SkipData
```

脚本会：停服/停任务 → 旧代码改名 `C:\apps\talent-workbench.bak-<时间戳>` → 拷新代码（排除 `node_modules`、`data`、
`.git`、日志与临时文件）→ 创建目录联接 `C:\apps\talent-workbench\data` → `C:\talent-data` →
`npm ci` → `npm run build`。

> `-SkipData` 的含义：数据已经按第 3 步放好，脚本不再触碰 `C:\talent-data`（认证文件也保持原样）。
> 先看计划可加 `-DryRun`。

---

## 5. 启动与验收

```powershell
# 启动（开机也会自动启动）
Start-ScheduledTask -TaskName TalentWorkbench

# 1) 服务存活（公开接口）
Invoke-RestMethod http://127.0.0.1:4173/api/health          # 期望 status=ok

# 2) 数据完整性（条目文件数 / 字节数 / 主库 SHA256）
cd C:\apps\talent-workbench
node scripts\data-inventory.mjs --verify C:\talent-data\deploy\data-manifest.json   # 期望 verified: true

# 3) 代码完整性（可选：把服务器清单拷回开发机比对）
node scripts\deployment-manifest.mjs --out C:\talent-data\deploy\server-manifest.json

# 4) 全功能自检（登录后取会话 Cookie；或临时以 AUTH_ENABLED=false、PORT=4174 起诊断实例）
node scripts\self-test-api.mjs --cookie "tw_session=<值>"    # 期望 32/32

# 5) 浏览器验证
#    打开 https://talent.wooduan.com → 用白名单 LDAP 账号登录 → 检索一条（如「数值策划」）有结果
#    → AI 助手提问一句有回答；未登录访问 /api/candidates 应返回 401
```

登录后还可确认检索状态：`https://talent.wooduan.com/api/resume-search/status` 应显示
`ready=true`、`vector.available/loaded/current=true`、`algorithm=usearch-hnsw-cos-f16`、`query_budget_ms=120000`。

---

## 6. 常见问题

| 现象 | 原因 / 处置 |
| --- | --- |
| `tar: Error opening archive` / CRC 报错 | 包在复制中断损；重新从共享复制该包（或让开发机用 `scripts\pack-data-for-it.ps1 -Force -Only 01` 重打单个包） |
| 解包后空间不足 | 先确认 C: 剩余 ≥300 GB；`04-archive.zip` 是可选留档，可跳过 |
| 解压后 `C:\talent-data\data\...` 多了一层 | 解压目标指错（应直接 `-C C:\talent-data`）；把内容上移一层或重解 |
| 登录失败（所有人） | 认证文件没拷回：确认 `auth-allowlist.txt` 与 `auth.db` 在 `C:\talent-data\`；注意连续输错会触发 5 分钟限流 |
| `/api/resume-search/status` 显示 `vector.loaded=false` | 向量目录没解全或路径不符；确认 `C:\talent-data\search-vectors\` 含 `embedding-cache.sqlite` 与 `generation-*` 目录，且环境变量 `SEARCH_VECTOR_DIRECTORY` 指向它 |
| 维护脚本报 `data\incremental` 找不到 | 目录联接缺失：`cmd /c mklink /J C:\apps\talent-workbench\data C:\talent-data` |
| `data-inventory --verify` 报 `bytes_mismatch` | 包没解完（例如 03 中断）；重新解该包后再校验 |

---

## 7. 回滚（约 5 分钟）

1. 停服务与任务；
2. `C:\talent-data` 改名 `*.failed-<时间>`、`C:\apps\talent-workbench` 改名 `*.failed-<时间>`；
3. 把 `C:\talent-data.bak-<时间>`、`C:\apps\talent-workbench.bak-<时间>` 改回原名；
4. 启动任务，复核 `/api/health`、登录与一条真实检索。

> 没有 down migration：**代码与数据必须一起回滚**。

---

## 8. 提取完成后的清理

数据校验通过、服务正常后，请告知开发机方关闭共享（避免敏感数据长期暴露）：

```powershell
# 在开发机上以管理员身份执行
powershell -NoProfile -ExecutionPolicy Bypass -File D:\talent-asset-workbench\scripts\setup-transfer-share.ps1 -Remove
```
