# 拾才工作台 · IT/运维交接单（LDAP 认证版）

日期：2026-09-21（2026-09-22 更新实际部署信息）。适用代码版本：应用 `0.6.0`（LDAP 认证阶段 1）。

本文是给公司 IT/运维侧的执行清单。应用侧的部署步骤、备份与排障见 [本地服务器部署手册](../DEPLOYMENT_LOCAL_SERVER.md) 与 [运维手册](../OPERATIONS.md)；本文只列需要你们配置或确认的部分。

---

## 0. 实际部署现状（2026-09-22）

应用**已部署并运行**，细节见 [服务器部署记录](../SERVER_DEPLOYMENT_RECORD.md)。与本文相关的要点：

| 项 | 实际值 |
| --- | --- |
| 应用服务器 | `192.168.8.12`（Windows Server 2022，主机名 `WIN-EA9P2962QT4`） |
| 应用监听 | `0.0.0.0:4173`（**不是回环**，因为 nginx 在另一台机器上） |
| 已配防火墙入站规则 | 端口 4173 **只允许 `192.168.8.167`** 访问，其余来源阻断 |
| 反向代理服务器 | `192.168.8.167`（由你们维护） |
| `AUTH_TRUST_PROXY` | 已设为 `true`，等待 nginx 传入真实客户端 IP |
| `AUTH_COOKIE_SECURE` | **当前为 `false`**，等 HTTPS 确认可用后由项目方改为 `true` |

**因此第 3 节的架构描述按实际情况更新为**：

```text
浏览器 --HTTPS--> talent.wooduan.com (nginx @ 192.168.8.167)
                --HTTP 明文--> 192.168.8.12:4173 (监听 0.0.0.0，仅放行 .167)
```

---

## 1. 需要运维提供的四件事

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 内网域名 + HTTPS 证书 | **`talent.wooduan.com`**（已确定），待配置 DNS 与证书 | 见第 2 节 |
| 反向代理（nginx 等） | **待配置**：`192.168.8.167` 上转发到 `192.168.8.12:4173` | 见第 3 节 |
| 模型网关证书信任 | **待处理**：服务器不信任 `token.wd.com` 证书 | 见第 4 节新增项 |
| LDAP 网络可达性 | **已确认可达**（`Test-NetConnection ldap.wan5d.com -Port 389` 返回 True） | 见第 4 节 |

---

## 2. 域名与证书

**域名：`talent.wooduan.com`**（项目方已定）。需要你们完成：

1. **DNS**：在公司内网 DNS（或内网视图）中把 `talent.wooduan.com` 指向反向代理的内网地址。
   **不要在公网 DNS 创建 A/AAAA 记录**，包括指向测试地址的历史记录。`wooduan.com` 公网可解析（线上为 `47.111.98.111`），子域名可被枚举；一旦公网有记录，等同于对外公告"这里存放着候选人档案、支持 LDAP 登录"。
2. **证书**：复用 `*.wooduan.com` 通配证书，或为 `talent.wooduan.com` 单独签发。
   **不要用自签名证书**——浏览器告警会让使用者养成忽略证书错误的习惯。
3. **客户端 DNS**：使用者必须走公司内网 DNS；对使用外网 DNS 的终端，该域名应解析不到任何地址。
4. 域名确定后保持稳定：会话 Cookie 是站点作用域，更换域名会导致所有使用者被登出。

---

## 3. 反向代理配置

应用监听 `0.0.0.0:4173`，由代理终止 TLS 后转发。**应用服务器上的防火墙已限制为只允许 `192.168.8.167` 入站**，请在该地址上配置代理。

必须做到：

1. **转发请求头**：`Host`、`X-Forwarded-For`、`X-Forwarded-Proto`。
   - `Host` 缺失会让应用的同源校验失效；
   - `X-Forwarded-For` 缺失会使所有使用者被识别为同一来源，登录限流会因一人连续输错而锁住全组。
2. **80 端口 301 跳转到 443，或直接不监听 80。** 本次接受明文 LDAP（`389`），如果浏览器到应用这段也是明文，同一个密码会在两条链路上各暴露一次。
3. **对导出与附件下载关闭响应缓冲、放宽超时**：候选人导出文件最大 64 MB，履历检索单次最长约 20 秒，默认代理超时可能提前断开。
4. 建议做 WebSocket/SSE 之外的常规长响应测试，确认大面积列表与导出不会触发 `502`。
5. `proxy_pass` 指向 **`http://192.168.8.12:4173`**（注意是应用服务器的内网地址，不是回环地址）。

nginx 参考片段（域名与证书路径请替换为实际值）：

```nginx
# 证书可用 *.wooduan.com 通配证书，或为 talent.wooduan.com 单签
server {
    listen 80;
    server_name talent.wooduan.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name talent.wooduan.com;

    ssl_certificate     /etc/nginx/ssl/talent.crt;
    ssl_certificate_key /etc/nginx/ssl/talent.key;

    client_max_body_size 70m;   # 候选人导入上限 64 MB，留出余量
    proxy_read_timeout 300s;    # 长检索与导出
    proxy_send_timeout 300s;
    proxy_buffering off;        # 导出与附件下载不缓冲

    location / {
        proxy_pass http://192.168.8.12:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

应用侧对应设置：`AUTH_COOKIE_SECURE=true`、`AUTH_TRUST_PROXY=true`。

---

## 4. LDAP 连通性

| 项目 | 值 |
| --- | --- |
| 地址 | `ldap://ldap.wan5d.com:389` |
| 加密 | 当前无 LDAPS/STARTTLS（已确认为既定例外） |
| 用途 | 仅做一次用户密码绑定，应用不保存密码 |

需要确认：

1. 服务器所在网段到 `ldap.wan5d.com` 为受控内网链路，不经过公网或不可信网段。
2. **服务器不得迁往 DMZ、云主机或任何需要经公网访问目录的位置**——389 为明文，一旦链路离开受控内网即等同于凭据泄露。
3. 应用服务器需要能解析 `ldap.wan5d.com`，端口 389 出站放行。
4. 具备 LDAPS 或 STARTTLS 能力后及时通知，应用侧改动仅为配置项（无需改代码）。

---

## 5. 服务器规格

**实际配置（2026-09-22 实测）**：16 逻辑核 / **32 GB 内存** / C 盘 484 GB 可用 / Windows Server 2022 Datacenter / Node.js v26.9.0。

**与建议值的差异**：原建议 64 GB 内存，实际 32 GB，约为建议值的一半。影响是**并发检索能力下降**——向量索引 6.3 GB 依赖页缓存，内存不足时检索会落到磁盘。**建议按 8–10 人并发使用，而不是 15 人**；同期 15 人同时检索时会明显变慢。这是容量问题，不影响功能。

仍需确认或补齐的项：

| 项目 | 状态 |
| --- | --- |
| 供电 | **待确认**：是否配 UPS（不需要休眠，但断电仍需保护） |
| 加密 | **待确认**：是否开启 BitLocker（数据库与备份目前为明文存储，是当前最大的静态风险） |
| 杀毒 | **待确认**：`C:\talent-data` 是否已排除实时扫描（该目录依赖 NTFS 权限与全盘加密保护） |

磁盘剩余空间不得低于主库大小的 2 倍：索引重建与大表导入会临时占用与主库相当的空间。

---

## 6. 网络与防火墙

本次**不限制来源网段**（内网机器防火墙普遍开放，网络层不构成访问控制）。因此：

1. 访问控制完全落在应用层：LDAP 账号 + 账号白名单。
2. 请把系统地址按**内部信息**管理，不写入对外文档、不投放到公共门户，避免扩大非目标人群的接触面。
3. 服务器 IP 的 `4173` 端口**不得**对内网放行，只允许本机访问。
4. 需要验证：从另一台内网机器直接访问 `http(s)://<服务器IP>:4173` 应当失败，只能通过代理域名访问。

---

## 7. 账号白名单（由项目方维护，运维仅需知晓）

| 项目 | 说明 |
| --- | --- |
| 文件 | `data/auth-allowlist.txt` |
| 格式 | 一行一个登录名，`#` 开头为注释 |
| 生效方式 | 服务每 30 秒重读，**编辑后无需重启** |
| 移除账号 | 从文件删除即可，该账号已建立的会话在**下一次请求**即失效 |
| 文件权限 | 与主库同级保护：仅服务账户与管理员可读写 |
| 备份 | 纳入备份范围，与 `data/auth.db` 一同复制 |

示例：

```text
# 招聘团队
zhangsan
lisi
```

---

## 8. 上线前共同确认清单

- [ ] 内网域名已确定，且在公网 DNS 无任何记录
- [ ] `talent.wooduan.com` 已在内网 DNS 解析到反向代理，公网无记录
- [ ] 证书 SAN 与域名一致，由内部 PKI 或受信任 CA 签发
- [ ] 反向代理（`192.168.8.167`）`proxy_pass` 指向 `http://192.168.8.12:4173`
- [ ] 反向代理转发 `Host` / `X-Forwarded-For` / `X-Forwarded-Proto`（**`X-Forwarded-For` 缺失会导致 15 人被识别为同一来源，一人输错密码即锁全组**）
- [ ] 80 端口 301 跳转 443，无明文入口
- [ ] 应用侧 `AUTH_TRUST_PROXY=true`（已配）；`AUTH_COOKIE_SECURE` 当前为 `false`，**HTTPS 确认可用后必须通知项目方改为 `true` 并重启**
- [ ] 服务器到 LDAP 为受控内网链路，服务器不会被迁往 DMZ
- [ ] 服务器已开 BitLocker 并配 UPS（**当前待确认**）
- [ ] 从**另一台机器**验证 `192.168.8.12:4173` 不可直连（应用服务器本机测试不经过入站防火墙，不能替代此项）
- [ ] 将公司根 CA 装入应用服务器受信任根存储，使模型网关可访问（可选，影响 AI 助手与语义检索）
- [ ] `data/auth.db` 与 `data/auth-allowlist.txt` 已纳入备份与权限保护
- [ ] 系统地址按内部信息管理，未出现在对外文档或公共门户
- [ ] 业务方已知晓：当前无 RBAC 与字段级权限，白名单内账号可查看全部候选人字段

---

## 8.1 应用侧待办（HTTPS 就绪后执行，非 IT 职责）

**HTTPS 一旦确认可用，项目方需执行以下动作**，否则会话 Cookie 会在明文 HTTP 上传输：

```powershell
[Environment]::SetEnvironmentVariable('AUTH_COOKIE_SECURE', 'true', 'Machine')
[Environment]::SetEnvironmentVariable('AUTH_COOKIE_SECURE', 'true', 'User')
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/index.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 5
Start-ScheduledTask -TaskName 'TalentWorkbench'
```

**注意**：改为 `true` 后，仍通过 `http://192.168.8.12:4173` 直连的用户会登录失败（Cookie 被浏览器丢弃）。这是预期行为，也正是需要防火墙确保只有 `192.168.8.167` 能访问的原因。

---

## 9. 常见问题

| 现象 | 可能原因 |
| --- | --- |
| 登录页能打开，提交后提示"账号服务暂时不可用" | 服务器到 LDAP 389 不通、DNS 解析失败或超时 |
| 所有人从同一来源被限流 | 代理未传 `X-Forwarded-For`，或应用未设 `AUTH_TRUST_PROXY=true` |
| 登录成功但立刻回到登录页 | Cookie 的 `Secure` 与访问协议不匹配（HTTPS 访问需 `AUTH_COOKIE_SECURE=true`；HTTP 访问需为 `false`） |
| 浏览器提示证书错误 | 证书 SAN 与访问域名不一致，或使用了自签名证书 |
| 导出或大文件下载中途中断 | 代理超时过短或启用了响应缓冲 |
| 提示"账号未获授权使用该系统" | 该账号不在 `data/auth-allowlist.txt` 中 |
