# 数据交接共享说明（给 IT）

开发机已开启一个**只读 SMB 共享**，用于把「人才资产工作台」的代码与全部数据（160.71 GiB）复制到服务器。

---

## 1. 共享信息

| 项 | 值 |
| --- | --- |
| 提供方 | 开发机 `CBOY-01933`（域账号 `wd\cboy`） |
| 访问地址 | `\\192.168.190.58\talent-workbench`（或 `\\cboy-01933\talent-workbench`） |
| 共享路径 | `D:\talent-asset-workbench`（含源码与 `data\` 全部数据） |
| 共享权限 | `Everyone` → **读取**（只读，不可写/不可删） |
| NTFS | `Everyone` → 读取与执行 |
| 防火墙 | 仅放行 **192.168.8.12（服务器）** 与 `192.168.190.0/23`（开发机所在网段）：TCP 445 + ICMPv4 |
| 数据内容 | 代码（595 文件）、主库 17.46 GiB、向量索引 27.66 GB、附件 49.79 GiB、原始快照 47.88 GB、增量缓存 17.64 GB 等 |
| 清单 | 共享内 `data\deploy\data-manifest.json`（条目级文件数/字节数 + 主库 SHA256）、`data\deploy\local-manifest.json`（代码 SHA256） |

### 1.1 已打包的数据（推荐按包复制，避免 80 万个散文件）

共享内 `transfer\` 目录已用 **store 模式（只打包、不压缩）** 生成 6 个 zip，复制与校验都比散文件快得多：

| 包 | 内容 | 大小 |
| --- | --- | ---: |
| `01-database.zip` | `recruitment.db`(+`-wal`/`-shm`)、`search-runtime.json`、`deploy\`（清单） | 17.46 GiB |
| `02-vectors.zip` | `search-vectors\`（f16 向量索引，**不要用 f32 重建**） | 27.66 GB |
| `03-attachments.zip` | `private\`（附件） | 49.79 GiB |
| `04-archive.zip` | `asset-export\` + `incremental\`（留档数据，可选） | 65.52 GiB |
| `05-reports.zip` | 解析/评测报告（可选） | 0.13 GiB |
| `06-parsed-resume.zip` | **解析补全简历文本包**（`parsed-sections.jsonl` + `origin-text.jsonl` + `manifest.json` + `checksums.sha256`；**不要解到 `C:\talent-data`**，是给人才资产 / WDCloud 共享资产用的） | 840.9 MB |

（同目录下 `README.txt` 是给 IT 的提取说明，`pack.log` 是打包记录。）

> `06-parsed-resume.zip` 的用途、字段定义、合并到 WDCloud 人才库资产（`ka_talent_pool_files`）的步骤与
> 验收清单，见 `docs/IT_PARSED_RESUME_HANDOVER.md`；散文件目录为
> `transfer\parsed-resume-20261010\`（69,642 + 69,629 行，SHA256 见包内 `checksums.sha256`）。

**在服务器上提取**（Windows 自带 `tar`，解压目标是 `C:\talent-data`，包内就是该目录的相对结构）：

```powershell
tar -xf 01-database.zip   -C C:\talent-data
tar -xf 02-vectors.zip    -C C:\talent-data
tar -xf 03-attachments.zip -C C:\talent-data
tar -xf 04-archive.zip    -C C:\talent-data    # 可选
tar -xf 05-reports.zip    -C C:\talent-data    # 可选
```

> 注意：`deploy-to-server.ps1` 默认是从共享目录直接 robocopy 数据；如果改用这些 zip，
> 就按 `transfer\README.txt` 里的步骤手工提取，再跑脚本时加 `-SkipData` 只部署代码
> （脚本不会再动数据目录，认证文件也保持原样）。

---

## 2. 连通性自测（在服务器上执行）

```powershell
ping 192.168.190.58
Test-NetConnection 192.168.190.58 -Port 445

# 建立会话（二选一，见下）
net use \\192.168.190.58\talent-workbench /user:wd\cboy <密码>

# 列出内容确认可读
dir \\192.168.190.58\talent-workbench
dir \\192.168.190.58\talent-workbench\data
```

**凭据方式**

| 方式 | 说明 |
| --- | --- |
| A. 域账号 | 使用 `wd\cboy`（或其它有权限的域账号）+ 密码 |
| B. 专用本地账号 | 由开发机新建（如 `talent-transfer`）+ 独立密码，仅用于本次传输 |
| C. 域服务账号 | 若 IT 有域服务账号，直接使用（NTFS 已允许所有已认证用户读取） |

> 服务器是工作组机器（`WIN-EA9P2962QT4\Administrator`），访问开发机共享**必须显式提供上述凭据**；
> 匿名访问默认被 Windows 禁用。

---

## 3. 复制到服务器（两种方式）

### 方式 1：一键部署脚本（推荐）

脚本会自动：停服/停任务 → 旧代码与旧数据改名备份（`*.bak-<时间戳>`，不删除）→ 拷代码 → 拷全部数据 →
**保留服务器现有认证文件**（`auth-allowlist.txt` / `auth.db`）→ 建目录联接 `C:\apps\talent-workbench\data` → `C:\talent-data`
→ `npm ci` → `npm run build`。

```powershell
# 先看计划（不落盘）
powershell -NoProfile -ExecutionPolicy Bypass -File "\\192.168.190.58\talent-workbench\scripts\deploy-to-server.ps1" -SourceRoot "\\192.168.190.58\talent-workbench" -IncludeArchive -DryRun

# 正式执行
powershell -NoProfile -ExecutionPolicy Bypass -File "\\192.168.190.58\talent-workbench\scripts\deploy-to-server.ps1" -SourceRoot "\\192.168.190.58\talent-workbench" -IncludeArchive

# 启动
Start-ScheduledTask -TaskName TalentWorkbench
```

> 前置：服务器 `C:` 剩余 **≥300 GB**；`C:\talent-data\auth-allowlist.txt` 存在（脚本会前置校验，缺失直接拒绝执行）。
> 不想带原始快照/增量缓存（省 65 GB）可去掉 `-IncludeArchive`。

### 方式 2：手工 robocopy

```powershell
robocopy \\192.168.190.58\talent-workbench\data\search-vectors C:\talent-data\search-vectors /MIR /R:2 /W:2 /NP
robocopy \\192.168.190.58\talent-workbench\data\private        C:\talent-data\private        /MIR /R:2 /W:2 /NP
Copy-Item \\192.168.190.58\talent-workbench\data\recruitment.db* C:\talent-data\ -Force
Copy-Item \\192.168.190.58\talent-workbench\data\search-runtime.json C:\talent-data\ -Force
robocopy \\192.168.190.58\talent-workbench\data\asset-export   C:\talent-data\asset-export   /MIR /R:2 /W:2 /NP   # 可选
robocopy \\192.168.190.58\talent-workbench\data\incremental    C:\talent-data\incremental    /MIR /R:2 /W:2 /NP   # 可选

# 代码（排除 node_modules / data）
robocopy \\192.168.190.58\talent-workbench C:\apps\talent-workbench /MIR /XD node_modules data .git /XF *.log
cd C:\apps\talent-workbench; npm ci; npm run build
# 建立 data 联接（维护脚本按 <代码>\data 解析数据）
if (-not (Test-Path C:\apps\talent-workbench\data)) { cmd /c mklink /J C:\apps\talent-workbench\data C:\talent-data }
```

---

## 4. 校验（复制完成后）

```powershell
# 数据：条目文件数 / 字节数 / 主库 SHA256
node scripts/data-inventory.mjs --verify C:\talent-data\deploy\data-manifest.json

# 代码：与开发机清单逐文件比对（需把 server-manifest.json 拷回开发机比对，或反向比对）
node scripts/deployment-manifest.mjs --out C:\talent-data\deploy\server-manifest.json

# 服务自检（登录后取 Cookie）
node scripts/self-test-api.mjs --cookie "tw_session=<值>"
```

期望：`verified: true`、`identical: true`、自检 **32/32**。

---

## 5. 传输完成后关闭共享（安全要求）

数据是敏感候选人信息，复制完成并校验通过后请立即关闭共享与防火墙放行：

```powershell
# 在开发机上以管理员身份执行
powershell -NoProfile -ExecutionPolicy Bypass -File D:\talent-asset-workbench\scripts\setup-transfer-share.ps1 -Remove
```

该命令会删除共享 `talent-workbench` 与两条防火墙规则（`Talent transfer SMB` / `Talent transfer ICMP`）。

---

## 6. 相关文档

| 文档 | 用途 |
| --- | --- |
| `docs\PROJECT_HANDOVER_IT.md` | **项目整体交接**（架构、运维、账号、风险、故障手册、优化路线图） |
| `docs\SERVER_RELEASE_HANDOVER_IT.md` | 首次上线发布交接单（步骤、验收 9 条、回滚） |
| `data\deploy\data-manifest.json` | 全量数据清单（校验用） |
| `scripts\deploy-to-server.ps1` | 一键部署（原位替换 + 备份 + 认证文件保留 + 目录联接 + 构建） |
