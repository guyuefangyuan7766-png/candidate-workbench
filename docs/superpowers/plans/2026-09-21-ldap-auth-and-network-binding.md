# LDAP 统一认证与受控网络监听：实施计划

> 状态：**未开工**。本文件与 [设计规范](../specs/2026-09-21-ldap-auth-and-network-binding-design.md) 同批交付，实施时逐项勾选并补验证证据。

**目标：** 让应用在接入公司 LDAP（`ldap.wan5d.com`）后具备真实登录能力，并在多个显式开关同时满足的前提下允许监听内网地址，同时保证默认路径行为与改造前完全一致。

**架构：** 保留 React 19 + TypeScript + Vite + Express + SQLite 与全部现有 API 形态。新增 `server/auth/` 认证层（LDAP 客户端 + 独立认证库 + 中间件），改造 `server/index.mjs` 的监听校验和 `server/app.js` 的中间件链，前端新增登录表面。

**技术栈：** Express 5、SQLite（`node:sqlite`）、`ldapts`（唯一新增依赖）、React 19、TypeScript 5、Vite 7。

**规范：** `docs/superpowers/specs/2026-09-21-ldap-auth-and-network-binding-design.md`（开工前全文阅读，冲突时以规范为准）。

**目标版本：** 应用 `0.6.0`；主库保持 schema `V13`，无新增迁移；新增独立认证库 `data/auth.db`。

**部署形态（2026-09-21 确认）：** 目标并发 15 人；HTTPS 由运维侧反向代理提供，应用保持 `127.0.0.1:4173` 回环绑定，`AUTH_ALLOW_NON_LOOPBACK` 不启用；**允许所有内网 IP，不设来源网段白名单**，访问控制完全落在账号层；`ldap.wan5d.com` 与服务器同处受控内网；第一版显示名使用登录标识。依据见规范 5.4–5.6 与 13.2。

## 全局约束

- **默认行为不变**：`AUTH_ENABLED` 未开启时，监听限制、鉴权行为、API 契约与本轮之前完全一致；既有 741 项测试不得因本改造需要修改。
- 不修改主库 schema，不新增 `schema_migrations` 版本，不改动 `tests/backend/database-migration-idempotence-v9.test.mjs` 断言的 `[1..13]`。
- 不把任何密码、密码哈希或 LDAP 凭据写入数据库、日志或前端。
- 不在仓库内提交真实 LDAP 地址以外的任何凭据；`.env` 保持被忽略。
- 认证测试只使用本地 mock LDAP 服务与匿名临时数据库，不得连接 `ldap.wan5d.com` 做自动化测试，不得使用真实候选人数据。
- 实施过程中如与既有未提交改动冲突，保留他人改动并在其基础上调整。

---

## 阶段 0：基线与前置确认

**读取：** `docs/ARCHITECTURE.md`、`docs/DATA_MODEL.md`、`docs/OPERATIONS.md`、`docs/API.md`、`src/api.ts`、`server/index.mjs`、`server/app.js`、本规范。

- [ ] 记录起点：`git status --short`、`git rev-parse HEAD`，确认不改动既有未提交内容。
- [ ] 跑基线门禁：`npm test`、`npx tsc --noEmit`、`npm run build`，记录通过/失败数与既有 7 项失败集合。
- [x] 确认规范第 13.1 节的四项环境结论（2026-09-21 已完成）：C1 DN 为 `cn=<登录名>,ou=People,dc=wooduan,dc=com` 并采用直接绑定；C2 显示名允许回退登录标识；C3 服务账号后续再说；C4 无 LDAPS，本轮使用 `389` 明文。
- [x] 确认加密能力：LDAPS 与 STARTTLS 当前均不可用，`LDAP_ALLOW_PLAINTEXT=true` 为既定例外，补偿控制见规范 3.2。
- [x] 确认规范第 13.2 节剩余四项（2026-09-21 已完成）：C5 并发 15 人；C6 不考虑来源网段；C7 HTTPS 由运维提供（反向代理形态）；C8 `ldap.wan5d.com` 位于受控内网；C9 接受以登录标识作为显示名。
- [ ] 建立本地 mock LDAP 服务（`tests/backend/ldap-mock-server.mjs`），支持 bind 成功、bind 失败、匿名 search 返回属性、匿名 search 被拒绝、超时、连接拒绝六类场景。

**交付：** 基线记录（写入本节下方"验证证据"），含 commit、测试结果、mock 服务能力说明。

---

## 阶段 1：认证服务端基础模块

**文件（新增）：** `server/auth/store.js`、`server/auth/ldap.js`、`server/auth/middleware.js`、`server/auth/config.js`。

- [ ] `server/auth/config.js`：从环境变量解析认证与 LDAP 配置，返回校验结果与启动摘要；`AUTH_ENABLED=true` 但配置不完整时返回明确错误。
- [ ] `server/auth/store.js`：基于 `node:sqlite` 的 `ServerAuthStore`，幂等建 `auth_users` / `auth_sessions` / `auth_meta` 三张表及索引（规范 6.2）。
  - [ ] `upsertUser`、`findUserByUsername`、`touchLogin`
  - [ ] `createSession`（返回明文 token，库内只存 SHA-256）、`resolveSession`、`revokeSession`、`revokeAllForUser`、`cleanupExpired`
  - [ ] 空闲期限滑动续期与绝对期限判断
  - [ ] `close()` 释放连接
- [ ] `server/auth/ldap.js`：`createLdapAuthenticator(config)` 与 `authenticate({ username, password })`。
  - [ ] 规范化登录标识：去空白、去 `DOMAIN\` 前缀、限长、拒绝空值
  - [ ] RFC 4514 DN 转义后再替换 `%s`
  - [ ] 直接绑定：规范化标识替换 `LDAP_USER_DN_TEMPLATE` 后执行一次 `bind`，不做前置搜索
  - [ ] 可选属性读取：`LDAP_ATTRIBUTE_LOOKUP=anonymous` 时尝试匿名 search 取 `cn`/`mail`，失败一律降级为显示名 = 登录标识
  - [ ] 错误分类：凭据错误（含账号不存在与被禁用，统一返回 `invalid_credentials`）、后端不可达、超时
  - [ ] 服务账号搜索模式保留接口但不实现，配置 `LDAP_ATTRIBUTE_LOOKUP=service` 时启动失败并给出明确原因
  - [ ] 单次操作超时与连接释放（`try/finally`，不泄漏连接）
  - [ ] 明文连接时的告警输出
- [ ] `server/auth/middleware.js`：`createAuthMiddleware({ store, publicPaths, rateLimit })`。
  - [ ] 从 Cookie 或 `Authorization: Bearer` 读取会话
  - [ ] 公开路径白名单放行，其余 `/api` 一律要求有效会话
  - [ ] 写请求校验 `Origin` / `Referer` 与请求 Host 同源
  - [ ] 登录限流：账号 5 次 / 5 分钟为主防线，来源地址 30 次 / 1 分钟为次级防线（规范 4.4）；成功登录只清空该账号计数
  - [ ] 来源地址取自 `X-Forwarded-For` 最左可信地址；未启用 `AUTH_TRUST_PROXY` 时按回环地址处理并记录该退化行为
  - [ ] `AUTH_TRUST_PROXY` 为 `true` 时启用 Express `trust proxy`，仅信任回环/代理来源的转发头；为 `false` 时忽略 `X-Forwarded-*`
  - [ ] 账号白名单（规范 4.3.1）：从 `data/auth-allowlist.txt` 读取，**每 30 秒重读**（名单变更不重启、最迟 30 秒生效，作为对运维的承诺写入文档）；环境变量 `AUTH_ALLOWED_USERS` 仅作名单文件缺失时的启动引导值
  - [ ] 白名单边界行为：文件存在但为空 → 拒绝所有登录并告警；文件读取失败 → 沿用上次成功名单并告警，不放开为允许所有人
  - [ ] 白名单与 `is_active` 在**每次请求**的会话解析阶段重新判定，保证移除后已建立会话即时失效
  - [ ] 401 错误码按规范第 8 节返回
- [ ] 新增依赖 `ldapts` 并写入 `package.json`；确认 `npm audit` 无新增高危。

**验收：** `node --test tests/backend/auth-store.test.mjs tests/backend/auth-ldap.test.mjs` 通过（阶段 5 编写）。

---

## 阶段 2：监听边界与 Express 集成

**文件：** `server/index.mjs`、`server/app.js`、`server/maintenance.js`（如涉及运行时锁）。

- [ ] `server/index.mjs`：把回环硬编码替换为规范 5.2 的四步校验；默认路径（`AUTH_ENABLED` 关闭）只允许回环，错误信息保持可读。
- [ ] 非回环 + `AUTH_COOKIE_SECURE=false` 时打印显著告警；启动摘要打印认证模式、绑定地址、会话期限，不含敏感值。
- [ ] `server/app.js`：
  - [ ] `createApp` 接受 `options.auth`（`{ enabled, store, ldap, publicPaths, rateLimit }`），未提供时完全跳过认证层
  - [ ] 会话中间件挂在 `express.json()` 之后、业务路由之前
  - [ ] 新增四个认证端点（规范第 8 节）
  - [ ] `setCors` 增加同源判定：`Origin` 与请求 Host 一致时允许
  - [ ] 登出与 401 响应统一 `Cache-Control: private, no-store`
  - [ ] `app.closeDatabase` 一并联闭认证库
  - [ ] `app.locals.authStore` 暴露给测试
- [ ] 确认 `/api/health` 保持公开且不泄露任何用户或配置信息。

**验收：** 匿名请求受保护接口返回 401；公开端点正常；`AUTH_ENABLED=false` 时行为与改造前一致。

---

## 阶段 3：前端登录表面

**文件（新增）：** `src/auth.ts`、`src/components/LoginPage.tsx`。
**文件（修改）：** `src/App.tsx`、`src/api.ts`、`src/styles.css` 或 `src/workspace.css`、`src/types.ts`。

- [ ] `src/auth.ts`：会话状态与 `getSession` / `login` / `logout` API 封装，包含 `AuthUser` 类型。
- [ ] `src/api.ts`：请求层在收到 401 时广播统一事件，供登录态切换使用；不改动其他错误处理语义。
- [ ] `src/App.tsx`：启动先探测会话；未登录渲染登录表面；登录后跳回原始路径；侧栏显示当前用户与登出。
- [ ] `src/components/LoginPage.tsx`：账号/密码、Enter 提交、加载态、三类错误文案、沿用现有视觉 token。
- [ ] 登出后清空候选人、职位、人才库、会话与检索等前端缓存，避免残留上一位用户的数据。
- [ ] 移动端与桌面端均验证登录页无横向溢出、文字不重叠。

**验收：** 未登录无法进入工作台；登录成功回到原路径；刷新保持登录；登出后回到登录页。

---

## 阶段 4：文档同步（与代码同批提交）

**必须逐项完成，不允许"代码先合、文档后补"。**

- [ ] `SECURITY.md`：改写第 1 节与第 22 行附近的"没有认证、不能局域网部署"表述为双模式说明（默认回环无认证 / 受控网络 + LDAP 认证）。
- [ ] `docs/ARCHITECTURE.md`：新增认证与监听边界小节、请求鉴权数据流、模块职责；修订第 49 行引用块与第 9 节安全缺口清单。
- [ ] `docs/OPERATIONS.md`：新增认证与 LDAP 配置项表格、登录排障、认证库备份与撤销、启动摘要说明；修订第 71 行引用块与第 16 节前置条件。
- [ ] `docs/API.md`：新增四个认证端点、鉴权要求、错误码；说明除 `/api/health` 外全部 `/api` 需要会话。
- [ ] `docs/DATA_MODEL.md`：新增认证库章节（表结构、生命周期、与主库分离的理由）；修订"没有用户、RBAC 实体"的表述。
- [ ] `docs/PRIVACY.md`：更新第 2 节安全边界与第 11 节多人版要求，明确阶段 1 之后仍存在的缺口。
- [ ] `docs/AGENT_SECURITY.md`：说明 Agent 端点同样需要会话，且 Agent 的授权模型不等于 RBAC。
- [ ] `docs/UI_DESIGN.md`：新增登录页设计规范与"不改动既有信息架构"的说明。
- [ ] `docs/TESTING.md`：新增认证测试矩阵、mock LDAP 说明、验收门禁与"不得连真实 LDAP 做自动化"的约束。
- [ ] `docs/ROADMAP.md`：把 1.0 部门版门槛细化为阶段 1/2/3，标注阶段 1 完成后仍未满足的项。
- [ ] `docs/DECISIONS.md`：追加 ADR（LDAP 认证与本地会话）、ADR（受控网络监听替代回环硬限制）、ADR（认证数据独立于主库）。
- [ ] `docs/PRODUCT_SPEC.md`：更新部署形态、用户与权限范围、非目标。
- [ ] `docs/ITERATION_LOG.md`：新增本轮条目（目标、完成项、验证结果、遗留风险）。
- [ ] `docs/DEPLOYMENT_LOCAL_SERVER.md`：把第 10 节的"需要的改造"改为"阶段 1 已完成 / 阶段 2 待完成"，补 LDAP 配置与 HTTPS 要求。
- [ ] `CHANGELOG.md`：新增 `[Unreleased]` 条目，说明新增认证、监听边界变化与兼容性。
- [ ] `README.md`：更新部署形态说明与文档索引。
- [ ] `docs/README.md`：登记本规范与实施计划，更新"建议阅读顺序"中的认证前置阅读。
- [ ] `.env.example`：新增全部认证与 LDAP 变量及注释，不含真实密码。

---

## 阶段 5：测试与验收

**文件（新增）：** `tests/backend/auth-store.test.mjs`、`tests/backend/auth-ldap.test.mjs`、`tests/backend/auth-api.test.mjs`、`tests/backend/auth-binding-guard.test.mjs`、`tests/backend/ldap-mock-server.mjs`。

- [ ] 认证库：会话创建/解析/滑动续期/绝对过期/撤销/清理；token 只存哈希；并发创建不冲突。
- [ ] LDAP 适配器：直接绑定成功与失败；匿名属性读取成功、被拒绝、超时三种降级路径均不影响登录结果；DN 特殊字符转义；连接拒绝与超时映射为 `auth_backend_unavailable`；绑定失败统一返回 `invalid_credentials` 且不泄露账号是否存在。
- [ ] HTTP 层：未登录访问 `/api/candidates`、`/api/export`、`/api/attachments/:id/download`、`/api/agent/*` 均返回 401；登录后可访问；登出后失效；`/api/health` 始终公开。
- [ ] 限流：连续失败达到阈值返回 429 与 `Retry-After`；窗口过后恢复。
- [ ] 限流分层：单账号 5 次被锁定时，同一来源地址下的其他账号仍可正常登录；来源地址 30 次阈值独立生效。
- [ ] 账号白名单：名单文件不存在时所有通过认证的账号可登录；名单存在时名单外账号得到 `403 account_not_authorized`；名单内账号正常登录。
- [ ] 白名单边界：空名单文件拒绝所有登录；文件不可读时沿用上次名单；文件内容变更后 30 秒内生效且服务无需重启。
- [ ] 白名单判定顺序：错误密码 + 不在名单 → 返回 `401 invalid_credentials` 而非 403，不泄露账号是否存在。
- [ ] 白名单即时失效：账号 A 登录成功后从 `data/auth-allowlist.txt` 移除，等待 30 秒重读后 A 的下一次请求返回 401，无需等待会话自然过期。
- [ ] `is_active = 0` 的账号即使列入白名单也返回 `403 account_disabled`。
- [ ] 监听边界：`AUTH_ENABLED=false` 时非回环 HOST 启动失败；仅设置 `AUTH_ALLOW_NON_LOOPBACK` 仍失败；四个条件齐备时启动成功。
- [ ] 兼容性：`AUTH_ENABLED=false` 下 `npm test` 结果与本轮基线逐项一致，无新增失败。
- [ ] 前端：登录页渲染、Enter 提交、错误态、登录后跳回原路径、登出清理缓存；使用匿名临时库与 mock LDAP。
- [ ] 浏览器验收：375/768/1440 三视口登录页布局；登录 → 工作台 → 登出 全流程无 console error。

**验收门禁：**

| 门禁 | 标准 |
| --- | --- |
| `npm test` | 无新增失败；认证相关用例全部通过 |
| `npx tsc --noEmit` | 通过 |
| `npm run build` | 通过 |
| 匿名请求 | `/api/*`（除 health）全部 401 |
| 默认路径 | `AUTH_ENABLED=false` 时行为与改造前一致 |
| 监听守卫 | 单个开关不足以放开非回环监听 |

---

## 阶段 6：交付与上线前确认

- [ ] 输出认证配置模板（LDAP 地址、DN 模板、属性链、会话期限、绑定地址白名单）。
- [ ] 输出面向 15 人的运行参数模板：`AGENT_MAX_CONCURRENT_TASKS`、`AGENT_MAX_QUEUED_TASKS`、检索并发与队列，含调参观测指标（规范 5.5）。
- [ ] 输出反向代理配置要求：转发 `Host`/`X-Forwarded-For`/`X-Forwarded-Proto`，对导出与附件下载关闭缓冲并放宽超时（规范 5.4）。
- [ ] 在非生产环境用真实 LDAP 完成一次人工登录验证（不做自动化）。
- [x] HTTPS 由运维提供（C7 已确认）；落地时必须设置 `AUTH_COOKIE_SECURE=true` 与 `AUTH_TRUST_PROXY=true`。
- [ ] 向网络运维确认：服务器所在网段到 `ldap.wan5d.com` 为受控内网链路，且服务器不会被迁往 DMZ 或云主机（明文 LDAP 的前提，规范 3.2）。
- [ ] 按 15 人基线确认服务器规格（16 核 / 64 GB / 1 TB NVMe），并记录是否按规范 5.5 调整 Agent 与检索并发参数。
- [ ] 从另一台内网机器验证服务器 IP 的 `4173` 端口不可直连，只能经代理地址访问（规范 5.6 验收补充）。
- [ ] 确认系统地址作为内部信息管理，未出现在对外文档或公共门户。
- [ ] 输出账号白名单运维流程：维护责任人（已确定为项目方）、文件路径与格式、人员入转调离时的更新步骤、紧急移除步骤，并明确"编辑文件即可，最迟 30 秒生效、无需重启、移除后无需等待会话过期"。
- [ ] 把 `data/auth-allowlist.txt` 纳入备份与权限保护范围（与主库同级），并写入部署手册的备份清单。
- [ ] 确认内网访问域名：由公司统一分配，**确认该域名在公网 DNS 不可解析**（规范 5.7）；域名同时用于证书 SAN 与 `CORS_ORIGIN` 兜底配置。
- [ ] 确认反向代理的 80 → 443 跳转，确保不存在明文 HTTP 入口。
- [ ] 与应用使用者确认：统一通过域名访问，不存在 IP 直连入口。
- [ ] 确认运维侧人员离职流程包含"应用会话撤销"步骤（LDAP 不可用时已建立会话仍然有效）。
- [ ] 确认阶段 1 之后仍存在的缺口已由信息安全与法务知晓（规范 9.2、9.3）。
- [ ] 记录证据：`docs/evidence/ldap-auth-<date>/`（脱敏，不含真实账号、DN、密码）。
- [ ] 更新部署手册的验收清单与备份范围（含 `auth.db`）。

---

## 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| DN 模板与真实 DN 不符 | 全部登录失败 | C1 已确认模板形态；上线前用真实账号人工验证一次；失败日志区分"绑定被拒"与"连接/超时" |
| 明文 389 端口 | 凭据可被同网段嗅探 | 已确认为既定例外；执行规范 3.2 的四条补偿控制，其中浏览器到应用的 HTTPS 为硬要求 |
| 无法识别被停用账号 | 目录侧"仍可绑定但禁止登录其他系统"的账号可能登录成功 | 规范 3.1 已接受该限制；离职必须执行会话撤销；阶段 2 随组映射解决 |
| LDAP 不可用时旧会话仍有效 | 撤销权限存在延迟 | 提供 `revokeAllForUser` 与运维撤销步骤，写入 `OPERATIONS.md` |
| 认证被误解为授权 | 全公司 LDAP 账号可读全部敏感数据 | 规范 9.2/9.3 写入产品与部署文档；阶段 2 前限制使用范围 |
| 认证库与会话状态 | 撤销全部需完整撤销路径 | 提供 `revokeAllForUser` 与运维撤销步骤 |
| 多实例部署 | 会话与限流在进程内，跨实例不一致 | 当前只支持单实例；多实例需改用共享存储，写入部署文档限制 |
| 与既有测试冲突 | 741 项基线被破坏 | 认证默认关闭；新增特性以 `options.auth` 注入，测试单独立文件 |

## 验证证据

实施时在本节追加：基线与改造后的测试计数、定向用例结果、浏览器验收报告路径、真实 LDAP 人工验证记录（脱敏）。
