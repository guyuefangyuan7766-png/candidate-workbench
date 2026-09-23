# 公司本地服务器部署手册

## 0. 适用范围与结论先行

本手册说明如何把这套人才库从"开发者的笔记本"搬到公司机房里的一台 Windows 服务器上，并给出按真实数据实测的硬件配置。

> **已完成部署（2026-09-22）**：实际服务器为 `192.168.8.12`（Windows Server 2022），代码在 `C:\apps\talent-workbench`、数据在 `C:\talent-data`，监听 `0.0.0.0:4173`，防火墙只放行 nginx（`192.168.8.167`），开机自启任务为 `TalentWorkbench`。**实际状态、环境变量与待验证项见 [服务器部署记录](SERVER_DEPLOYMENT_RECORD.md)**——本文是"怎么做"，那份是"现在长什么样"。

**当前状态（2026-09-21，应用 `0.6.0`）：LDAP 认证已实现并已在真实目录上验证通过**，目标访问地址为 `https://talent.wooduan.com`。落地方式有两种，默认仍是前者：

| 方式 | 使用者 | 触发条件 | 本手册覆盖 |
| --- | --- | --- | --- |
| A. 单用户本机 | 只有 1 个人在同一台机器上使用 | `AUTH_ENABLED` 未开启（默认），服务只允许回环监听 | 第 2–9 节 |
| B. 内网共享（本次目标） | 约 15 名授权招聘人员经 HTTPS 访问 | `AUTH_ENABLED=true` + 反向代理 + 账号白名单 | 第 5 节步骤 0/3.5、第 6 节、第 10.0 节 |

上架前必须接受下面三条事实，它们不是建议，而是当前代码与治理的硬约束：

1. **认证解决"谁能进"，不解决"进来能看什么"。** 账号来自公司 LDAP，白名单限定到具体人；但**没有 RBAC 与字段级权限**——白名单内的每个账号都能看到全部 14 万份候选人档案，包括未打码的手机号、邮箱、薪资、评估与简历正文。
2. **数据库与附件是明文存储。** SQLite 文件、WAL、备份、导出文件都没有静态加密，只能依靠 BitLocker、NTFS 权限与受控机房。
3. **明文 LDAP 是已接受的例外。** 目录使用 `ldap://ldap.wan5d.com:389`（无 LDAPS），因此浏览器到应用这一段**必须**是 HTTPS，且服务器与目录必须同处受控内网。这两个前提缺一不可。

**当前可交付范围**：少量授权人员 + 内网 + HTTPS + 账号白名单 + 信息安全确认。**全部门开放仍不支持**，必须先完成阶段 2 的 RBAC 与字段级权限、阶段 3 的操作人审计，判断依据见 [设计规范](superpowers/specs/2026-09-21-ldap-auth-and-network-binding-design.md) 第 9.3 节。

---

## 1. 实测数据规模（配置计算的依据）

以下数字来自当前正式库在 2026-09-21 的实际测量，是硬件选型的唯一可靠依据：

| 项目 | 实测值 | 说明 |
| --- | ---: | --- |
| 候选人数 | 140,381 | 全部为活跃档案，无归档 |
| 职位数 | 1,308 | |
| 人才库分组 | 43 | |
| 简历来源文档 | 455,744 | 进入 FTS5 索引 |
| 向量 chunks / vectors | 630,978 / 630,978 | `text-embedding-v4` / 1024 维 |
| 向量已索引文档 | 429,630 | |
| 主库 `recruitment.db` | **38.9 GB** | 含 WAL 约 11 MB |
| 向量目录 `data/search-vectors/` | **15.5 GB** | 含 active + previous 两代索引与缓存 |
| 其中 single active 代际 | 6.34 GB | `vectors.usearch` 2.49 GB + `vectors.sqlite` 3.85 GB |
| 其中 Embedding 缓存 | 2.84 GB | `embedding-cache.sqlite`，可重建，不必备份 |
| 附件与导入私有目录 | 3.2 MB | 目前几乎没有本地附件 |
| 数据库运行时进程内存 | 约 250 MB | 单进程常驻工作集 |
| 单轮增量索引维护 | 19–22 秒 | 每个开机周期执行一次 |
| 单次混合检索响应 | 5–20 秒 | 受模型网关延迟影响，非 CPU 瓶颈 |

三条由此推出的关键结论：

- **磁盘是主约束。** 主库 39 GB 加向量目录 15.5 GB，再加备份，容量规划从 200 GB 起。
- **随机 I/O 决定检索速度。** 向量索引和向量库合计 6.3 GB 是 mmap 随机读，机械硬盘和 SATA SSD 会让检索从 8 秒退化到分钟级。
- **内存决定检索稳定性。** 内存不够时热数据被换出，每次检索都要重新从磁盘读索引页。

---

## 2. 硬件配置建议

按"本机单用户"和"服务器形态"两种场景给出。所有档位都假设数据规模在 15 万候选人上下。

### 2.1 推荐档位

| 档位 | 适用场景 | CPU | 内存 | 系统盘 | 数据盘 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 最低可用 | 单人 RDP，偶尔检索 | 4 核 / 8 线程 | 16 GB | 256 GB NVMe | 与系统盘共用，剩余 ≥150 GB | 检索会频繁落盘，体验明显变慢 |
| **推荐** | 单人 RDP，日常高频使用 | **8 核 / 16 线程** | **32 GB** | 256 GB NVMe | **512 GB NVMe** | 当前数据规模下的平衡点 |
| 宽裕 | 2–4 人分时 RDP，或候选人涨到 30 万 | 12–16 核 | 64 GB | 512 GB NVMe | 1 TB NVMe | 为后续全量索引重建留余量 |
| **15 人内网共享** | 接入 LDAP 后由 15 名招聘人员通过 HTTPS 访问 | **16 核** | **64 GB** | 512 GB NVMe | **1 TB NVMe** | 见设计规范 5.5 的容量基线与并发参数 |

> 最后一行对应 2026-09-21 确认的目标规模。15 人场景下硬件不是唯一门槛：单次履历检索需要 5–20 秒并占用一个检索 worker，AI 助手默认只允许 2 个任务并行，因此上线后必须按设计规范 5.5 观测并调整 `AGENT_MAX_CONCURRENT_TASKS`、`AGENT_MAX_QUEUED_TASKS` 与检索并发/队列，否则会表现为"能用但总在排队"。

采购要点：

- **必须 NVMe SSD**，不接受机械硬盘或 SATA SSD。这是本应用唯一不能妥协的硬件项。
- CPU 单核性能比核心数更重要。SQLite 的 FTS5 物化和 Node 的事件循环都是单线程，高频 i7/i9 或至强 W 系列优于低频多核。
- 不需要独立显卡，不需要本地推理算力。模型调用全部走远程网关。
- 台式工作站或单路机架服务器均可。塔式主机加 UPS 是完全合理的方案。

### 2.2 内存如何分配（32 GB 档为例）

| 用途 | 建议占用 |
| --- | --- |
| Windows 系统与杀毒软件 | 6–8 GB |
| SQLite 主库页缓存 | 8–10 GB |
| 向量索引与向量库 mmap 常驻 | 8–10 GB |
| Node 进程与检索 worker | 2–3 GB |
| 余量和峰值 | 4 GB |

若把内存降到 16 GB，主库页缓存和向量索引会互相挤占，检索延迟在连续查询下会明显抖动。若上升到 64 GB，可以把 active 代际完整常驻内存，检索延迟最稳定。

### 2.3 磁盘容量如何规划

以 15 万候选人计算：

| 用途 | 大小 |
| --- | ---: |
| 主库 + WAL | 40 GB |
| 向量目录（active + previous） | 16 GB |
| 附件与导入私有目录 | 按实际增长，当前 3 MB |
| **运行数据小计** | **约 56 GB** |
| 完整文件集备份 ×3 代 | 约 120 GB |
| 升级前快照与回滚余量 | 约 40 GB |
| Windows 系统与 Node | 约 40 GB |
| **数据盘合计** | **建议 ≥512 GB NVMe** |

磁盘剩余空间不得低于主库大小的 2 倍。SQLite 做 VACUUM、索引重建或大批量导入时会临时占用与主库相当的空间。

### 2.4 网络、供电与物理

- **出站 HTTPS**：访问模型网关需要出站 443。仅使用候选人增删改查和筛选可以完全离线，AI 助手和混合检索的模型规划/向量化会不可用。
- **入站**：方式 A 不需要任何入站端口，全部走本机 RDP。方式 B 才需要内网入站，且必须先完成第 10 节的改造。
- **UPS 必须配。** SQLite 使用 WAL 模式，39 GB 的库在写入过程中断电，恢复代价很高。请给主机和磁盘阵列配在线式或后备式 UPS，并配置自动关机。
- **杀毒软件排除目录**：把 `data\` 和向量目录加入实时扫描排除，否则每次索引维护都会被全量扫描，维护时间成倍增加，且可能拖慢检索。排除前请确认该目录已受 NTFS 权限和全盘加密保护。
- **全盘加密**：BitLocker 或同等方案必须开启，并妥善保管恢复密钥。这是当前唯一的"静态加密"手段。

---

## 3. 软件前置条件

| 项目 | 要求 | 检查命令 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 或 Windows Server 2019/2022 | `winver` |
| PowerShell | 5.1 可启动，建议 7.x | `$PSVersionTable.PSVersion` |
| Node.js | **24 或更高**，必须 | `node --version` |
| npm | 随 Node 安装 | `npm --version` |
| 可用端口 | 默认 4173 | `Get-NetTCPConnection -LocalPort 4173` |

Node 24 是硬性要求，因为后端使用 Node 内置的 `node:sqlite`，低版本会在启动时直接失败。

首次部署需要能访问 npm 源；之后日常运行完全离线可用。

---

## 4. 需要从开发机带过去的东西

| 内容 | 路径 | 是否必需 | 说明 |
| --- | --- | --- | --- |
| 源代码 | 项目根目录，排除 `node_modules`、`dist`、`.tmp-*` | 必需 | |
| 主库文件集 | `data\recruitment.db`、`-wal`、`-shm` | 必需 | 三件必须同一次复制，否则可能丢事务 |
| 向量目录 | `data\search-vectors\` | 必需 | 不复制则必须重新生成，需数小时和网关费用 |
| 附件与导入 | `data\private\` | 必需 | |
| 检索运行配置 | `data\search-runtime.json` | 必需 | 保存检索开关与模型名，不含密钥 |
| 账号白名单 | `data\auth-allowlist.txt` | 接入 LDAP 后必需 | 一行一个登录名；**必须在开启认证之前创建** |
| 认证库 | `data\auth.db`（可含 `-wal`/`-shm`） | 接入 LDAP 后必需 | 账号与会话；与主库相互独立，不参与主库迁移 |
| `.env` 或系统环境变量 | 见第 6 节 | 必需 | 密钥不写进代码，也不进版本库 |
| `node_modules` | | 不需要 | 服务器上由 `start.ps1` 自动安装 |
| `backups\`、`outputs\`、`output\` | | 不需要 | 历史交付物，留在原处 |

复制数据库时**必须先停止源机器上的服务**，确认 `-wal` 已经合并。迁移完成后核对 `recruitment.db` 大小与源文件一致，再启动目标机服务。

---

## 5. 部署步骤

### 步骤 0：确定对外暴露方式（接入 LDAP 后必做）

2026-09-21 确认：访问地址为 **`https://talent.wooduan.com`**，HTTPS 由公司运维侧的反向代理提供。因此**应用本身保持回环绑定**，不直接监听内网地址：

```text
浏览器 --HTTPS--> talent.wooduan.com 反向代理（*.wooduan.com 证书）
                 --HTTP/回环--> 127.0.0.1:4173（Express）
```

对应的配置要求：

| 配置 | 值 | 原因 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 应用不直接暴露，仅接受代理转发 |
| `AUTH_ALLOW_NON_LOOPBACK` | `false` | 本次部署不启用受控网络模式 |
| `AUTH_COOKIE_SECURE` | `true` | 浏览器侧是 HTTPS，会话 Cookie 必须带 `Secure` |
| `AUTH_TRUST_PROXY` | `true` | 否则服务端把所有请求看成来自 `127.0.0.1`，登录限流会把 15 个人算成同一个人 |

`talent.wooduan.com` 必须在**内网 DNS** 解析到反向代理，且**公网 DNS 不得存在该子域名的 A/AAAA 记录**（`wooduan.com` 公网可解析，子域名可被枚举）。使用者需走公司内网 DNS，否则该域名解析不到。

反向代理需转发 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto`，并对导出（最大 64 MB）与附件下载关闭响应缓冲、放宽超时，否则长检索与大文件会被代理提前断开。

### 步骤 1：服务器基础准备

1. 以管理员身份创建专用本地账户，例如 `svc-talent`，并把 `data\` 目录的 NTFS 权限限定给该账户和管理员组。不要用共享账户或域管理员账户跑这个服务。
2. 开启 BitLocker 并保存恢复密钥。
3. 安装 Node.js 24 LTS，确认 `node --version` 输出 ≥ 24。
4. 将杀毒软件实时扫描排除 `data\` 与向量目录。

### 步骤 2：放置代码与数据

推荐布局（盘符按实际情况调整）：

```text
D:\apps\talent-workbench\        <- 代码
D:\apps\talent-workbench\data\   <- 数据库、向量、附件
```

把主库文件集、`search-vectors\`、`private\`、`search-runtime.json` 放到 `data\` 下，保持与开发机一致的相对结构。

### 步骤 3：配置模型网关（可选）

不配置模型网关时，候选人管理、筛选、导入导出、附件解析全部可用，只有 AI 助手和混合检索的模型规划不可用。

配置请使用**系统级或用户级环境变量**，不要写进仓库文件。`start.ps1` 的读取顺序是"用户级变量优先，其次进程级变量"，因此用 `setx` 设置用户级变量是最稳妥的方式：

```powershell
setx AGENT_BASE_URL "https://your-gateway.example/v1"
setx AGENT_API_KEY "your-key"
setx AGENT_MODEL "your-model"
```

设置后必须重新打开终端并重启服务才会生效。密钥只存在于服务端环境变量，不会下发到浏览器。

若网关是公司内网地址，还需要把它加入受信任私网主机列表：

```powershell
setx SEARCH_MODEL_TRUSTED_PRIVATE_HOSTS "gateway.corp.example"
```

该配置只接受精确 DNS 主机名，不接受 IP 字面量或通配符，且要求 HTTPS。

### 步骤 3.5：配置 LDAP 认证（内网共享必做）

**顺序不能颠倒**：先建白名单，再开认证。白名单文件不存在时，认证按"未启用白名单"处理——所有能通过 LDAP 的账号都可登录；而**文件存在但为空则拒绝所有登录**。所以正确动作是先写好要授权的人，再打开开关。

第 1 步，创建 `data\auth-allowlist.txt`：

```text
# 招聘团队（一行一个登录名，大小写不敏感）
cboy
```

第 2 步，设置环境变量（`setx` 设置用户级变量，重开终端后生效）：

```powershell
setx AUTH_ENABLED "true"
setx LDAP_URL "ldap://ldap.wan5d.com:389"
setx LDAP_USER_DN_TEMPLATE "cn=%s,ou=People,dc=wooduan,dc=com"
setx LDAP_UID_ATTRIBUTE "uid"
setx LDAP_ALLOW_PLAINTEXT "true"
setx LDAP_ATTRIBUTE_LOOKUP "off"
setx AUTH_ALLOWLIST_FILE "D:\talent-data\auth-allowlist.txt"   # 数据不在代码目录时
setx AUTH_TRUST_PROXY "true"
# 下面这条必须等 HTTPS 真正可用后再设，否则浏览器会丢弃会话 Cookie
setx AUTH_COOKIE_SECURE "true"
```

第 3 步，重启服务，确认启动日志出现认证摘要：

```text
[auth] 认证已启用（直接绑定模式）；LDAP=ldap://ldap.wan5d.com；明文连接；
       属性读取=off；会话空闲 12h / 绝对 30d；白名单=...\auth-allowlist.txt；非回环监听=禁止
```

第 4 步，用真实账号验证：`https://talent.wooduan.com` 打开登录页 → 用自己的 LDAP 密码登录 → 侧栏底部显示登录名与"退出登录"。

排障要点：

- 提示"账号或密码不正确"：凭据或 DN 模板问题。可用于确认模板的最小检查是 `nslookup ldap.wan5d.com` 与目录中该账号的 DN 是否形如 `cn=<登录名>,ou=People,dc=wooduan,dc=com`。
- 提示"账号未获授权使用该系统"：该账号不在白名单文件里，或文件尚未被重读（最迟 30 秒）。
- 提示"账号服务暂时不可用"：服务器到目录的 389 不通、DNS 解析失败或超时。
- **所有人被限流**：代理没有转发 `X-Forwarded-For`，或漏设 `AUTH_TRUST_PROXY=true`。

### 步骤 4：指定数据库位置

如果数据不放在代码目录下，用环境变量显式指定（二者只设其一，`DB_PATH` 优先）：

```powershell
setx DB_PATH "D:\talent-data\recruitment.db"
```

### 步骤 5：首次启动

在项目根目录执行：

```powershell
.\start.ps1
```

启动脚本会依次校验 Node 版本、按需安装依赖、执行前端构建、再启动服务。首次启动会应用 V1–V13 幂等迁移；若目标库的 V8 全业务搜索尚未回填，这一步可能耗时很久（历史上 16 GB 库回填约 12 分钟），期间不要中断进程。

看到下面这行说明服务已就绪：

```text
Recruitment API listening on http://127.0.0.1:4173
```

### 步骤 6：验证

```powershell
Invoke-RestMethod http://127.0.0.1:4173/api/health
Invoke-RestMethod http://127.0.0.1:4173/api/auth/status          # 认证模式与白名单状态（公开，不含名单内容）
```

验收标准：

- `health` 返回 `status: ok`。
- `auth/status` 返回 `enabled: true`、`mode: ldap-direct-bind`、`allowlist.enforced: true` 且 `allowlist.size` 与刚写入的人数一致。
- 未登录直接访问 `/api/candidates` 返回 `401`。
- 浏览器经 `https://talent.wooduan.com` 用自己的 LDAP 账号登录，进入工作台后确认侧栏底部显示登录名与"退出登录"。
- 登录后抽查：列表翻页、打开一位候选人详情、按 `dashboard.total` 对照迁移前的候选人数。

> 未启用认证（方式 A）时改为验证 `http://127.0.0.1:4173/api/dashboard`、`/api/resume-search/status`（`state: ready`、`index_ready: true`、`current: true`）与页面本身的检索、详情、导出。

### 步骤 7：设置开机自启

应用本身不是 Windows 服务，需要借助任务计划程序：

1. 打开"任务计划程序"，创建任务（不是基本任务）。
2. 常规：勾选"不管用户是否登录都要运行"，勾选"使用最高权限运行"，运行账户选第 1 步创建的专用账户。
3. 触发器：启动时，延迟 2 分钟。
4. 操作：程序填 `pwsh.exe`（或 `powershell.exe`），参数填 `-NoProfile -ExecutionPolicy Bypass -File "D:\apps\talent-workbench\start.ps1"`，起始位置填代码目录。
5. 设置：勾选"如果任务失败，按以下频率重新启动"，间隔 5 分钟，最多重试 3 次；取消勾选"如果任务运行时间超过以下时间则停止任务"。
6. 把标准输出重定向到日志文件，例如 `-Command "... | Out-File -Append D:\logs\talent-$(Get-Date -f yyyyMMdd).log"`，否则日志无人可见。

**同一份数据目录同时只能有一个实例。** 应用用 `.candidate-workbench-maintenance-*.lock` 文件做互斥，重复启动会失败而不是损坏数据，但仍应避免配置多个触发器。

> **已实测确认（2026-09-21）**：走 `start.cmd` / `start.ps1` 这条官方路径启动时，认证配置确实会被传递到服务进程。验证方式是在备用端口起一个独立实例，`/api/auth/status` 返回 `enabled: true`、白名单生效，未登录访问 `/api/candidates` 返回 `401`。启动日志中应出现认证摘要行。
>
> **两个实测踩到的坑，部署时注意**：
>
> 1. **`start.ps1` 只接受 ASCII 注释。** PowerShell 5.1 在没有 BOM 的情况下按 ANSI 读取脚本，脚本内出现中文注释会把引号配对搞乱，直接导致启动器语法错误、**完全无法启动**。修改该脚本时请只用英文注释。
> 2. **启动器会清空不在其变量清单内的进程级环境变量。** 认证、LDAP 与 `PORT` 都已加入清单；如果以后新增配置项，必须同时加入 `start.ps1` 顶部的清单，否则会被静默清掉，服务以默认值启动（对认证类变量而言，这意味着**可能以无认证状态运行**）。

---

## 6. 关键配置项

完整清单见 [OPERATIONS.md](OPERATIONS.md) 第 5 节。部署时最少需要明确下面这些：

| 变量 | 建议值 | 作用 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 本次由反向代理转发，应用保持回环绑定 |
| `PORT` | `4173` | 本机端口 |
| `DB_PATH` | 绝对路径 | 显式指定主库位置 |
| `AUTH_ENABLED` | `true` | 打开 LDAP 认证；**必须先建好白名单文件** |
| `LDAP_URL` | `ldap://ldap.wan5d.com:389` | 目录地址（明文，已确认为既定例外） |
| `LDAP_USER_DN_TEMPLATE` | `cn=%s,ou=People,dc=wooduan,dc=com` | `%s` 为登录账号 |
| `LDAP_ATTRIBUTE_LOOKUP` | `off` | 显示名使用登录账号；开启 `anonymous` 可读取中文名，见下方说明 |
| `AUTH_ALLOWLIST_FILE` | `data\auth-allowlist.txt` | 白名单文件，每 30 秒重读 |
| `AUTH_COOKIE_SECURE` | `true` | **必须等 HTTPS 可用后设置** |
| `AUTH_TRUST_PROXY` | `true` | 反向代理部署必设，否则限流与来源记录失真 |
| `AUTH_SESSION_TTL_MS` | `43200000` | 会话空闲 12 小时，命中时滑动续期 |
| `AUTH_SESSION_ABSOLUTE_TTL_MS` | `2592000000` | 会话绝对上限 30 天 |
| `AUTH_LOGIN_RATE_LIMIT` | `5` | 单账号 5 次失败 / 5 分钟 |
| `AUTH_LOGIN_IP_RATE_LIMIT` | `30` | 单来源地址 30 次失败 / 1 分钟 |
| `AGENT_BASE_URL` / `AGENT_API_KEY` / `AGENT_MODEL` | 按网关填写 | AI 助手与附件建议，不填则关闭 |
| `SEARCH_REMOTE_ENABLED` | `true` | 启用混合检索 |
| `SEARCH_VECTOR_DIRECTORY` | 向量目录绝对路径 | 与迁移过来的目录一致 |
| `SEARCH_VECTOR_MAINTENANCE_ENABLED` | `true` | 每个开机周期做一次增量维护 |
| `NODE_USE_SYSTEM_CA` | `1` | 内网 HTTPS 网关需要读取 Windows 证书存储 |

修改任何配置后都要完整停止并重启服务，热更新不生效。

> **关于显示名**：默认 `LDAP_ATTRIBUTE_LOOKUP=off` 时界面显示登录名（如 `cboy`）。实测公司目录允许匿名搜索，把该值改为 `anonymous` 并把 `LDAP_NAME_ATTRIBUTE` 设为 `sn,cn` 即可显示中文姓名（该目录的 `cn` 存的是登录名、`sn` 才是中文名）。属性读取失败会自动降级为登录名，**不影响登录**。修改后需重启服务。

> **关于紧急撤销**：临时设置 `AUTH_SESSION_REVOKE_ALL=true` 并重启，会撤销全部会话强制所有人重新登录；用完请立即移除该变量。日常撤销某个人只需把他的登录名从白名单文件删除，最迟 30 秒生效，不需要重启。

---

## 7. 备份与恢复

### 7.1 备份范围

| 内容 | 是否备份 | 说明 |
| --- | --- | --- |
| `data\recruitment.db` + `-wal` + `-shm` | 必须 | 三件同时复制 |
| `data\search-vectors\` | 建议 | 不备份则恢复后需重新生成索引，耗时数小时 |
| `data\private\` | 必须 | 附件原件与导入中间文件 |
| `data\search-runtime.json` | 建议 | 体积很小 |
| `data\auth.db`（含 `-wal`/`-shm`） | 接入 LDAP 后必须 | 账号与会话；丢失只影响登录状态，大家重新登录一次即可 |
| `data\auth-allowlist.txt` | 接入 LDAP 后必须 | 白名单；丢失会导致访问控制状态不明，必须与主库同级保管 |
| `.env` 或系统环境变量 | 单独保管 | 含网关密钥 |
| `embedding-cache.sqlite` | 可不备份 | 可重建，只影响重建速度 |

### 7.2 备份操作

**必须在服务停止后备份。** 在运行中复制 `recruitment.db` 而不带 `-wal`，会得到一份缺少最近事务的库。

```powershell
# 1. 在运行窗口按 Ctrl+C，等进程完全退出
# 2. 复制文件集
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dest  = "E:\backup\talent\$stamp"
New-Item -ItemType Directory -Path $dest -Force | Out-Null
robocopy "D:\apps\talent-workbench\data" $dest /MIR /R:2 /W:2 /NP /LOG:"$dest\backup.log"

# 3. 校验哈希
Get-FileHash "$dest\recruitment.db" -Algorithm SHA256
Get-FileHash "D:\apps\talent-workbench\data\recruitment.db" -Algorithm SHA256
# 4. 重新启动服务
```

建议保留 3 代完整备份，并把其中一代放到另一台设备或异地存储。备份目录同样是明文敏感数据，要按与主库相同的级别保护。

`auth.db` 是可重建状态（最坏情况是所有人重新登录），但**它包含会话令牌的哈希与来源地址记录**，仍属敏感数据；`auth-allowlist.txt` 是安全控制的一部分，必须与主库同级别保护，不要放在个人目录或共享网盘。

### 7.3 恢复步骤

```powershell
# 1. 停止服务，确认 4173 无监听
Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue

# 2. 把当前数据目录改名保留（不要直接删除）
Rename-Item "D:\apps\talent-workbench\data" "data-broken-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"

# 3. 复制备份回来
Copy-Item "E:\backup\talent\20260921-120000" "D:\apps\talent-workbench\data" -Recurse

# 4. 启动并验证
.\start.ps1
```

恢复后至少验证 `health`、`auth/status`（确认白名单已生效、人数正确）、`dashboard.total`、`resume-search/status`，并抽查一位已知候选人的详情。

> **回滚到无认证模式**：把 `AUTH_ENABLED` 改为 `false` 并恢复回环 `HOST`，然后重启。`data\auth.db` 与白名单文件保留即可，不需要降级脚本——主库 schema 不受认证影响，仍是 `V13`。

### 7.4 恢复演练

上真实数据之前，请先在一台非生产机器上完整演练一次"停止—备份—破坏—恢复"。没有演练过的备份不算备份。

---

## 8. 日常运维

### 8.1 巡检清单（建议每周）

| 检查项 | 方法 | 正常表现 |
| --- | --- | --- |
| 进程存活 | 任务管理器或 `Get-Process node` | 存在且 CPU 平稳 |
| 健康检查 | `Invoke-RestMethod http://127.0.0.1:4173/api/health` | `status: ok` |
| 检索索引 | `/api/resume-search/status` | `state: ready`、`current: true` |
| 维护状态 | 同上 `vector_maintenance` | `ran_this_boot: true`、`state: ready` |
| 认证状态 | `/api/auth/status` | `enabled: true`、`allowlist.enforced: true`、`last_error: null` |
| 白名单人数 | 同上 `allowlist.size` | 与当前应授权人数一致；**人员离职后必须核对是否已移除** |
| 磁盘剩余 | `Get-PSDrive D` | 剩余 ≥ 主库大小的 2 倍 |
| 备份完成 | 检查备份目录时间戳 | 有最近一次完整备份 |

### 8.2 性能基线

用于判断"变慢"是否是异常：

| 指标 | 正常范围 |
| --- | ---: |
| 服务启动到健康检查通过 | 30 秒 – 2 分钟 |
| 增量索引维护（每开机周期一次） | 20–30 秒 |
| 单次混合检索（含模型网关） | 5–20 秒 |
| 候选人列表翻页 | < 1 秒 |
| 详情打开（含敏感字段） | < 2 秒 |

### 8.3 常见故障

| 现象 | 处理 |
| --- | --- |
| 双击启动后窗口一闪而过 | 在 PowerShell 里运行 `.\start.ps1`，看完整报错 |
| 端口被占用 | `Get-NetTCPConnection -LocalPort 4173 -State Listen` 找到残留进程 |
| 启动报"数据库维护中" | 存在未释放的 `.candidate-workbench-maintenance-*.lock`，确认对应 PID 已退出后处理 |
| 提示 Node 版本过低 | 安装 Node 24+，重开终端 |
| 检索返回 `search_index_not_ready` | 检查 dirty/coverage，不要手工改索引状态，先在副本复现 |
| 检索 504 超时 | 多为模型网关延迟，检查网关连通性和耗时，不要盲目加大预算 |
| 内存吃紧、检索抖动 | 关闭无关程序，或按第 2 节扩容内存 |
| 迁移失败 | 停止服务，保留错误信息，在副本上复现，不要反复修改正式库 |
| 登录提示"账号或密码不正确" | 凭据错误、DN 模板不匹配，或目录中不存在该 DN。先确认该账号 DN 形如 `cn=<登录名>,ou=People,dc=wooduan,dc=com` |
| 登录提示"账号未获授权使用该系统" | 该账号不在 `auth-allowlist.txt`；改动后最多等 30 秒 |
| 登录提示"账号服务暂时不可用" | 服务器到 `ldap.wan5d.com:389` 不通、DNS 失败或超时；确认服务器与目录同处受控内网 |
| 所有人都被限流（429） | 代理未转发 `X-Forwarded-For`，或漏设 `AUTH_TRUST_PROXY=true` |
| 登录成功后立刻弹回登录页 | `AUTH_COOKIE_SECURE` 与访问协议不匹配（HTTPS 访问必须为 `true`，纯 HTTP 必须为 `false`） |
| 浏览器证书告警 | 证书 SAN 与 `talent.wooduan.com` 不一致，或使用了自签名证书 |
| `/api/auth/status` 显示 `allowlist.size: 0` | 白名单文件为空或只有注释，此时**所有登录都会被拒绝**，这是刻意的失败关闭行为 |
| `allowlist.last_error` 非 null | 白名单文件读取失败；服务保留了上一次的名单，请检查文件权限与路径 |

### 8.4 日志

应用日志只输出到启动终端，没有轮转和告警。用第 5 步 7 的重定向把输出写入文件，并按周归档；归档前注意去除候选人内容和网关密钥。

---

## 9. 安全与合规清单（上线前必须逐项确认）

- [ ] 主机已开启全盘加密，恢复密钥由非使用者单独保管。
- [ ] 只有 1 个受控账户可以登录该主机，并已配置自动锁屏。
- [ ] `data\` 目录的 NTFS 权限限定到服务账户和管理员组。
- [ ] 主机位于受控机房或锁闭区域，USB 端口按公司策略管理。
- [ ] 出站网关的地域、日志留存、训练使用和删除政策已经过公司确认。
- [ ] 已明确候选人数据的处理目的、授权范围、留存期限和删除流程（见 [PRIVACY.md](PRIVACY.md)）。
- [ ] 已确认原始北森导出文件和交付工作簿的保管位置，未混入版本库。
- [ ] 已保存迁移前的完整文件集备份，并核对过 SHA-256。
- [ ] 已完成一次恢复演练。
- [ ] 已建立备份保留策略（建议 3 代 + 异地 1 份）。
- [ ] `data\auth-allowlist.txt` 已创建且只包含应授权的人；`data\auth.db` 已纳入备份范围与权限保护。
- [ ] `talent.wooduan.com` 已在内网 DNS 解析到反向代理，且**已确认公网 DNS 无该子域名的任何记录**。
- [ ] 证书为 `*.wooduan.com` 通配证书或针对该域名的受信任证书，**不是自签名**。
- [ ] 反向代理已转发 `Host` / `X-Forwarded-For` / `X-Forwarded-Proto`，80 端口 301 跳到 443。
- [ ] 已设置 `AUTH_COOKIE_SECURE=true` 与 `AUTH_TRUST_PROXY=true`，并确认 HTTPS 已真正可用。
- [ ] 已确认服务器与 `ldap.wan5d.com` 同处受控内网，且服务器不会被迁往 DMZ 或云主机。
- [ ] 已从另一台内网机器验证服务器 IP 的 `4173` 端口不可直连。
- [ ] 已与信息安全确认：当前无 RBAC 与字段级权限，白名单内账号可查看全部候选人字段；系统地址按内部信息管理。

---

## 10. 多人共享访问：已完成部分与剩余门槛

### 10.1 已完成：认证与受控访问（应用 0.6.0，2026-09-21 已实施并在真实目录验证）

阶段 1 已交付：LDAP 直接绑定、服务端持久会话、账号白名单、受控网络监听、全 `/api` 鉴权与登录页。本次部署的实际形态：

| 项目 | 本次配置 | 说明 |
| --- | --- | --- |
| 应用监听 | `127.0.0.1:4173` | 由反向代理转发，`AUTH_ALLOW_NON_LOOPBACK` 保持 `false` |
| `AUTH_ENABLED` | `true` | 开启后除 health 与认证端点外的全部 `/api` 需要会话 |
| `AUTH_COOKIE_SECURE` | `true` | 浏览器侧是 HTTPS，会话 Cookie 必须带 `Secure` |
| `AUTH_TRUST_PROXY` | `true` | 否则来源地址全部记为 `127.0.0.1`，登录限流会把所有人算成同一人 |
| `AUTH_ALLOWLIST_FILE` | `data/auth-allowlist.txt` | 由项目方维护，每 30 秒重读，编辑后无需重启 |
| 来源网段 | 不限制 | 内网机器防火墙普遍开放，网络层不构成访问控制 |
| 目标并发 | 15 人 | 硬件按 16 核 / 64 GB / 1 TB NVMe；参数建议见设计规范 5.5 |

**已完成的代码约束解除**（原"必须先解除"清单）：

| 位置 | 原限制 | 现状 |
| --- | --- | --- |
| `server/index.mjs` | 硬编码只允许回环 | 已改为两模式守卫：非回环需 `AUTH_ENABLED` + `AUTH_ALLOW_NON_LOOPBACK` + 完整 LDAP 配置 + `AUTH_BIND_HOSTS` 四项同时满足。本次由代理转发，实际未启用 |
| `server/app.js` 的 `setCors` | 只放行回环来源 | 已增加同源判定；跨站写请求仍被拒绝 |
| 全部业务 API | 无身份概念 | 已由 `/api` 前缀守卫统一要求会话，公开路径仅 health、login、status |
| `server/app.js` 错误处理 | — | 认证失败按稳定错误码返回，不作为 500 记录日志 |

**上线前必须完成的验证**：真实 LDAP 人工登录一次；从另一台内网机器确认服务器 IP 的 `4173` 端口不可直连；确认 80 端口 301 跳转到 443；确认 `talent.wooduan.com` 在公网 DNS 无解析记录。

### 10.2 仍未完成：全部门开放的硬门槛

以下是阶段 2/3 的范围，**在此之前不得向全部门开放**，少量授权人员使用也需信息安全与法务确认：

1. **RBAC 与字段级权限**：区分管理员、招聘负责人、只读访客；手机号、邮箱、薪资、评估、备注、附件正文逐字段授权，而不是登录即可见。**这是当前最大的缺口**——白名单内的每个账号都能看到全部字段。
2. **操作人审计**：`deletion_audits` 只保存候选人 ID 的哈希，`agent_query_audits` 不含操作者身份，因此无法回答"是谁在什么时候导出了什么"。多人使用必须记录不可伪造的操作者身份。
3. **应用层 TLS 与会话安全**：本次由反向代理终止 TLS，应用自身没有 HSTS、没有基于认证会话的完整 CSRF 策略；多人版应补齐响应头与速率限制。
4. **附件鉴权与病毒扫描**：本地附件目录目前仍是单用户回环假设。
5. **备份、监控与灾备**：多人使用后停机窗口与数据丢失的代价显著上升；当前没有日志轮转、指标与告警。
6. **AI 助手的按用户限流与费用控制**：多人共用同一模型网关密钥，并发成本需要配额约束。
7. **账号生命周期**：当前靠白名单文件手工维护，没有与目录的自动同步，也没有"停用但仍可绑定"的识别能力。

> 详细边界与准入判断见 [设计规范](superpowers/specs/2026-09-21-ldap-auth-and-network-binding-design.md) 第 9.3 节与 [ROADMAP.md](ROADMAP.md) 的 1.0 节。

### 10.3 并发容量

检索的单位成本：一次混合检索会占用一个只读 worker，并等待模型网关 5–20 秒。AI 助手默认只允许 2 个任务并行。按当前实现估算：

| 并发检索人数 | 需要的资源 |
| --- | --- |
| 1–2 | 8 核 / 32 GB |
| 4–6 | 12–16 核 / 64 GB，并按设计规范 5.5 调高 `AGENT_MAX_CONCURRENT_TASKS` 与检索并发/队列 |
| 10–15（本次目标） | 16 核 / 64 GB / 1 TB NVMe；先按默认上线观测一周再调参 |
| 15 以上 | 需要重新设计检索缓存与排队策略，而不是继续加内存 |

---

## 11. 升级与回滚

1. 停止服务，备份完整文件集并核对哈希。
2. 复制新版本代码，但**不要覆盖 `data\`**。
3. 启动服务，让 V1–V13 幂等迁移自动执行。
4. 验证 `health`、`auth/status`、`resume-search/status` 和一次真实登录+检索。
5. 若需回滚：停止服务，恢复旧代码**和**升级前的数据库文件集。当前没有自动 down migration，只回退代码会留下不匹配的 schema。

数据库迁移只做加法，不会清空既有候选人，但"不会清空"不等于"可以不做备份"。

**认证相关的升级注意**：`data\auth.db` 不参与主库的 `schema_migrations` 版本链，代码回退不需要对它做降级；它由服务启动时幂等建表维护。白名单文件是纯文本，随代码回退不受影响。若升级后出现登录异常，先在临时端口用同一份配置起一个实例复现，不要在正式服务上反复试密码——连续失败会触发限流，把整个团队锁在门外 5 分钟。

---

## 12. 验收清单

部署完成的判定标准：

- [ ] `node --version` ≥ 24。
- [ ] `start.ps1` 能完整跑完依赖安装、构建、启动三个阶段。
- [ ] `http://127.0.0.1:4173/api/health` 返回 `ok`。
- [ ] `/api/auth/status` 返回 `enabled: true`、`allowlist.enforced: true`、人数正确（未启用认证时跳过本项）。
- [ ] 未登录访问 `/api/candidates` 返回 `401`（未启用认证时跳过本项）。
- [ ] 经 `https://talent.wooduan.com` 用真实 LDAP 账号登录成功，侧栏显示登录名与"退出登录"（未启用认证时改为直接打开 `http://127.0.0.1:4173`）。
- [ ] `dashboard.total` 与迁移前的候选人数量一致。
- [ ] `/api/resume-search/status` 为 `ready` 且 `current: true`。
- [ ] 完成一次检索、一次详情、一次导出。
- [ ] AI 助手在配置网关后能返回一次只读回答。
- [ ] 任务计划程序自启配置完成，重启主机后服务能自动恢复。
- [ ] 第一份完整备份已生成并核对哈希。
- [ ] 第 9 节安全清单全部勾选。
