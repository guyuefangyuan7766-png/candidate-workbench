# 服务器部署记录（192.168.8.12）

记录日期：2026-09-22。本文记录**已经落到真实服务器上的实际状态**，与 [部署手册](DEPLOYMENT_LOCAL_SERVER.md)（面向"怎么部署"）和 [运维交接单](handoffs/2026-09-21-ldap-auth-server-handover.md)（面向 IT 待办）分工不同：**本文是"现在长什么样"的事实清单**，接手时先看这一份。

> **准确性说明**：本文只写已经实测确认的内容。凡未实测的，一律标注"待验证"，不写成已完成。**第 3 节的实际生效值需要执行一次核对命令后填入**（见该节末尾）。

---

## 1. 服务器与网络

| 项 | 实测值 |
| --- | --- |
| 主机名 | `WIN-EA9P2962QT4` |
| 操作系统 | Windows Server 2022 Datacenter（版本 10.0.20348，64 位） |
| 登录账户 | `Administrator`（本地管理员，已确认具备管理员权限） |
| IP 地址 | `192.168.8.12`（单网卡 `Ethernet0`，子网掩码 24 位） |
| 默认网关 | `192.168.8.1` |
| CPU / 内存 | 16 逻辑核 / 32 GB |
| 系统盘 | C: 484 GB 可用（部署时） |
| D: 盘 | 可用 0 GB（不可用，疑似光驱或恢复分区） |
| Node.js | v26.9.0（满足 ≥24 要求） |
| 休眠/睡眠 | 系统固件不支持，不会休眠 |
| 本机是否运行 nginx | **否** |

**架构**：`192.168.8.167` 上的 nginx 终止 TLS，以明文 HTTP 转发到本机 `192.168.8.12:4173`。

```text
浏览器 --HTTPS--> talent.wooduan.com (nginx @ 192.168.8.167)
                --HTTP 明文--> 192.168.8.12:4173 (本应用, 监听 0.0.0.0)
```

---

## 2. 目录与数据

代码与数据**刻意分离**，升级代码不会碰到数据：

| 内容 | 路径 |
| --- | --- |
| 代码 | `C:\apps\talent-workbench` |
| 主库 | `C:\talent-data\recruitment.db`（38.06 GB） |
| 向量索引 | `C:\talent-data\search-vectors\`（12.68 GB） |
| 附件与导入私有目录 | `C:\talent-data\private\` |
| 认证库（自动创建） | `C:\talent-data\auth.db` |
| 账号白名单 | `C:\talent-data\auth-allowlist.txt` |
| 检索运行配置 | `C:\talent-data\search-runtime.json` |
| 复制日志 | `C:\talent-data-copy.log`、`C:\code-copy.log` |

**数据规模**：候选人 140,381 位；简历来源文档 455,744 份；向量 chunks 630,978 个；schema `V13`。

> **2026-09-22 更新**：schema 已由 `V13` 升至 **`V14`**（`agent_session_ownership`：`agent_sessions` 增加 `user_id` 与 `agent_sessions_user_idx`）。迁移前创建的 10 个 AI 会话（含 124 条消息）已按确认结论清空，当前 `sessions/messages/tasks` 均为 0。升级前的完整文件集备份见下一节。

**数据来源**：从开发机迁移的备份 `D:\talent-backups\pre-auth-2026-09-21T05-08-03\`（50.75 GB，主库 SHA-256 `b10d78c9d35d8b90273ced46c2543fe3bc0ace9fbfccd425839457302f8d2105`）。备份时已排除可重建的 `embedding-cache.sqlite`（2.84 GB）。

---

## 3. 环境变量（Machine 与 User 双份）

配置同时写入**系统级**和**用户级**：开机自启任务以 `SYSTEM` 身份运行、只能读系统级；手工以 `Administrator` 启动时必须能读到用户级。

| 变量 | 值 |
| --- | --- |
| `DB_PATH` | `C:\talent-data\recruitment.db` |
| `SEARCH_VECTOR_DIRECTORY` | `C:\talent-data\search-vectors` |
| `SEARCH_REMOTE_ENABLED` | `true` |
| `SEARCH_VECTOR_MAINTENANCE_ENABLED` | `true` |
| `HOST` | `0.0.0.0` |
| `AUTH_ALLOW_NON_LOOPBACK` | `true` |
| `AUTH_BIND_HOSTS` | `127.0.0.1,::1,0.0.0.0` |
| `AUTH_ENABLED` | `true` |
| `LDAP_URL` | `ldap://ldap.wan5d.com:389` |
| `LDAP_USER_DN_TEMPLATE` | `cn=%s,ou=People,dc=wooduan,dc=com` |
| `LDAP_UID_ATTRIBUTE` | `uid` |
| `LDAP_ALLOW_PLAINTEXT` | `true` |
| `LDAP_ATTRIBUTE_LOOKUP` | `off` |
| `AUTH_ALLOWLIST_FILE` | `C:\talent-data\auth-allowlist.txt` |
| `AUTH_DB_PATH` | `C:\talent-data\auth.db` |
| `AUTH_TRUST_PROXY` | `true` |
| `AUTH_COOKIE_SECURE` | `false`（**HTTPS 就绪后必须改为 `true`**） |
| `AUTH_SESSION_TTL_MS` | `43200000`（12 小时空闲） |
| `AUTH_SESSION_ABSOLUTE_TTL_MS` | `2592000000`（30 天绝对） |
| `AUTH_LOGIN_RATE_LIMIT` / `..._WINDOW_MS` | `5` / `300000` |
| `AUTH_LOGIN_IP_RATE_LIMIT` / `..._WINDOW_MS` | `30` / `60000` |
| `AGENT_BASE_URL` | `https://token.wd.com:443/v1` |
| `AGENT_MODEL` | `deepseek/deepseek-flash` |
| `AGENT_API_KEY` | 已设置（长度 51），**值不记录在本文件** |
| `NODE_USE_SYSTEM_CA` | `1`（实测对 Node 26 无效，真正的修复是下面的 `NODE_EXTRA_CA_CERTS`，保留无害） |
| `NODE_EXTRA_CA_CERTS` | `C:\talent-data\certs\wd-root-ca.crt`（Node 启动时加载公司根 CA） |

**核对命令**（执行后把输出与上表比对，不一致以实际值为准并更新本文件）：

```powershell
foreach ($n in @('DB_PATH','SEARCH_VECTOR_DIRECTORY','SEARCH_REMOTE_ENABLED','SEARCH_VECTOR_MAINTENANCE_ENABLED','HOST','AUTH_ALLOW_NON_LOOPBACK','AUTH_BIND_HOSTS','AUTH_ENABLED','LDAP_URL','LDAP_USER_DN_TEMPLATE','LDAP_UID_ATTRIBUTE','LDAP_ALLOW_PLAINTEXT','LDAP_ATTRIBUTE_LOOKUP','AUTH_ALLOWLIST_FILE','AUTH_DB_PATH','AUTH_TRUST_PROXY','AUTH_COOKIE_SECURE','AUTH_SESSION_TTL_MS','AUTH_SESSION_ABSOLUTE_TTL_MS','AUTH_LOGIN_RATE_LIMIT','AUTH_LOGIN_RATE_WINDOW_MS','AUTH_LOGIN_IP_RATE_LIMIT','AUTH_LOGIN_IP_RATE_WINDOW_MS','AGENT_BASE_URL','AGENT_MODEL','NODE_USE_SYSTEM_CA')) {
  $m = [Environment]::GetEnvironmentVariable($n,'Machine')
  $u = [Environment]::GetEnvironmentVariable($n,'User')
  $flag = if ($m -eq $u) { '  ' } else { '<>' }
  Write-Host ("$flag $n : Machine=[$m] User=[$u]")
}
```

`<>` 标记表示两份不一致，需要人工判断以哪一份为准。

---

## 4. 网络与防火墙

**为什么需要防火墙**：应用监听 `0.0.0.0` 后，内网任何人都能访问 `http://192.168.8.12:4173`，**绕过 nginx 且为明文 HTTP**。防火墙把入站限制为只允许 nginx 那台机器。

| 规则 | 方向 | 动作 | 端口 | 来源 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `TalentWorkbench allow nginx` | 入站 | Allow | 4173 | 仅 `192.168.8.167` | Enabled |
| `TalentWorkbench deny others` | 入站 | Block | 4173 | 全部 | Enabled |

防火墙三个配置文件（Domain / Private / Public）**均为 Enabled**，规则实际生效。

核对命令：

```powershell
Get-NetFirewallProfile | Select-Object Name, Enabled | Format-Table -AutoSize
Get-NetFirewallRule -DisplayName 'TalentWorkbench*' | Select-Object DisplayName, Action, Enabled | Format-Table -AutoSize
Get-NetFirewallRule -DisplayName 'TalentWorkbench allow nginx' | Get-NetFirewallAddressFilter | Select-Object RemoteAddress | Format-Table -AutoSize
Get-NetTCPConnection -LocalPort 4173 -State Listen | Select-Object LocalAddress, LocalPort | Format-Table -AutoSize
```

**注意**：从服务器**本机**访问 `http://192.168.8.12:4173` 走回环路径，**不经过入站防火墙**，因此本机返回 200 不能证明来源限制生效。来源限制只能在**第三方机器**上验证。

---

## 5. 开机自启

| 项 | 值 |
| --- | --- |
| 任务名 | `TalentWorkbench` |
| 执行程序 | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\apps\talent-workbench\start.ps1"` |
| 工作目录 | `C:\apps\talent-workbench` |
| 触发 | 启动时，延迟 2 分钟 |
| 运行账户 | `SYSTEM`（服务账户，最高权限，不依赖用户登录） |
| 失败处理 | 每 5 分钟重试，最多 3 次；任务不允许重复实例 |
| 执行时间上限 | 无 |

**实测结果**：手动触发后服务以 `NT AUTHORITY\SYSTEM` 身份启动，`/api/auth/status` 返回 `enabled: true`、白名单生效——证明 `SYSTEM` 账户能正确读取系统级环境变量，不会静默降级为无认证模式。

核对命令：

```powershell
Get-ScheduledTask -TaskName 'TalentWorkbench' | Select-Object TaskName, State | Format-Table -AutoSize
Get-ScheduledTaskInfo -TaskName 'TalentWorkbench' | Select-Object LastRunTime, LastTaskResult, NextRunTime | Format-List
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/index.mjs*' } | ForEach-Object {
  $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner
  Write-Host ("PID " + $_.ProcessId + " owner: " + $owner.Domain + '\' + $owner.User + " start: " + $_.CreationDate)
}
```

---

## 6. 账号白名单

| 项 | 值 |
| --- | --- |
| 文件 | `C:\talent-data\auth-allowlist.txt` |
| 当前内容 | `cboy`（1 个账号） |
| 生效方式 | 服务每 30 秒重读，编辑后**无需重启** |
| 移除账号 | 从文件删除，该账号已建立的会话在**下一次请求**即失效 |

**上线前必须把白名单换成真实的授权人员**——现在只有一个账号。这是访问控制的唯一入口，只加该用的人。

---

## 7. 已确认未完成的事项

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| nginx 转发链路验证 | **待验证** | 需在 `192.168.8.167` 上访问 `http://192.168.8.12:4173/api/health`，预期 200 |
| 其他机器被防火墙拦截 | **待验证** | 需从第三方机器访问同一地址，预期失败。未验证前不能认为来源限制已生效 |
| 真实重启验证 | **待验证** | 第 5 节为手动 `Start-ScheduledTask` 验证，尚未做真机重启 |
| 模型网关证书信任 | **已解决（2026-09-22）** | `token.wd.com` 由公司内部根 CA `wd.com Internal Root CA`（指纹 `902A7BD4…`）签发。已装入本机受信任根存储并复制到 `C:\talent-data\certs\wd-root-ca.crt`，通过 `NODE_EXTRA_CA_CERTS` 让 Node 加载。`NODE_USE_SYSTEM_CA=1` 实测对 Node 26 无效，仅保留 |
| `AUTH_COOKIE_SECURE` 改为 true | **待 HTTPS 就绪** | 必须等 `https://talent.wooduan.com` 确认可用后执行，改完需重启服务 |
| 白名单填入真实账号 | **待办** | 责任人：项目方 |
| 服务器侧数据备份 | **待办** | 目前只有开发机上的源备份，服务器本身尚无备份任务 |

---

## 8. 部署过程中踩到的坑（供后续部署参考）

以下都是本次**实际发生并已解决**的问题，记录下来避免重演：

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 服务以无认证模式启动（`/api/auth/status` 返回 404） | `start.ps1` 的变量同步清单未包含 `AUTH_*` / `LDAP_*`，且清单外变量会被 `elseif` 分支**显式清空** | 将 28 个变量加入清单 |
| `start.ps1` 完全无法运行、语法错误 | 在该脚本内加入中文注释后，PowerShell 5.1 按 ANSI 读取无 BOM 的脚本，引号配对错乱 | 注释改为纯 ASCII |
| 白名单文件内容显示乱码 | 文件为 UTF-8 无 BOM，PowerShell 5.1 按 ANSI 显示。功能不受影响（服务端按 UTF-8 读取） | 用 `-Encoding ASCII` 重写 |
| `tsc` 报 `Cannot find module 'lucide-react'` | 经 RDP 硬盘映射复制 `node_modules` 时**静默丢失**大量小文件（该包只剩 6 个文件，正常 3521 个） | 服务器上执行 `npm ci` 重建 |
| 环境变量检查显示"无缺失"但包实际损坏 | 检查只验证 `package.json` 是否存在，无法发现 `dist/` 缺失 | 改为核对**文件数与体积** |
| 模型网关调用失败，报 `search_embedding_unconfigured` | 服务器不信任 `token.wd.com` 证书；截图式错误码掩盖了真实原因 | 装公司根 CA（`NODE_EXTRA_CA_CERTS` 指向证书文件）。Windows 链校验报 `RevocationStatusUnknown` 属正常：内网访问不到吊销服务器，Node 默认不检查吊销 |
| 会话 Cookie 只活 43 秒、点几下就掉登录 | Express 5 的 `res.cookie()` 要求 `maxAge` 传毫秒，代码传了秒，被内部再除 1000 写成 `Max-Age=43` | 改为直接传 `config.session.ttlMs`；新增 `auth-cookie-maxage.test.mjs` 固定该不变量 |
| V14 迁移报 `no such column: user_id` | 建索引语句留在 `db.exec` 块内，而补列在其后；升级既有库时索引先执行 | 把补列移到 `db.exec` 之前；新增针对 V13→V14 升级路径的测试（新建库测不出这个问题） |
| PowerShell 脚本报 `SyntaxError: Unexpected identifier` | 脚本为 UTF-8 无 BOM 且含中文，PS 5.1 按 ANSI 读取导致语法破坏 | 交给服务器的 `.ps1` 一律写纯 ASCII；或改用 `.mjs` 脚本执行 |
| 进程级 `PORT` 被清空，实例落到默认 4173 | 该变量不在启动器同步清单内 | 将 `PORT` 加入清单 |

**关于复制 `node_modules` 的结论**：不要通过 RDP 硬盘映射复制 `node_modules`。十万个小文件会静默丢失，且 `npm` 因 `package.json` 存在而跳过修复。**在服务器上执行 `npm ci` 是唯一可靠做法。**

---

## 9. 常用命令速查

```powershell
# 健康检查
Invoke-RestMethod http://127.0.0.1:4173/api/health

# 认证状态（公开，不含白名单内容）
Invoke-RestMethod http://127.0.0.1:4173/api/auth/status

# 服务进程与所属账户
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/index.mjs*' } |
  ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; "PID $($_.ProcessId) owner $($o.User)" }

# 停止服务
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/index.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 启动服务（任务计划方式，推荐）
Start-ScheduledTask -TaskName 'TalentWorkbench'

# 编辑白名单后查看生效情况（等 30 秒）
Sort-Object -InputObject (Get-Content C:\talent-data\auth-allowlist.txt)
Invoke-RestMethod http://127.0.0.1:4173/api/auth/status | Select-Object -ExpandProperty allowlist
```
