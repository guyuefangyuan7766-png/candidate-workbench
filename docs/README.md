# 项目文档索引

本文档集对应招聘工作台 `0.1.x` 个人版及当前 `Unreleased` 职位管理迭代。代码行为是事实来源；文档与实现不一致时，应先修正文档或通过技术决策记录明确变更。

| 文档 | 主要用途 |
| --- | --- |
| [PRODUCT_SPEC.md](PRODUCT_SPEC.md) | 当前用户、目标、功能范围、非目标和验收口径 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 系统边界、模块职责和运行数据流 |
| [API.md](API.md) | 本地业务 API、导入导出和 Agent 端点 |
| [DATA_MODEL.md](DATA_MODEL.md) | 数据表、候选人字段、血缘和去重规则 |
| [UI_DESIGN.md](UI_DESIGN.md) | 信息架构、视觉变量、组件、交互和响应式规范 |
| [IMPORT_GUIDE.md](IMPORT_GUIDE.md) | 北森及自有表格的准备、映射、预览和导入流程 |
| [FIELD_MAPPING.md](FIELD_MAPPING.md) | 三份北森字段审计、逐物理列处理策略和阶段 B 映射基线 |
| [AGENT_SECURITY.md](AGENT_SECURITY.md) | Agent 工具、数据最小化和安全边界 |
| [PRIVACY.md](PRIVACY.md) | 候选人数据分类、生命周期、模型外发和真实数据启用清单 |
| [OPERATIONS.md](OPERATIONS.md) | 启动、配置、备份、恢复、升级和排障 |
| [TESTING.md](TESTING.md) | 自动化测试、手工验收和发布门槛 |
| [ROADMAP.md](ROADMAP.md) | 从个人 PoC 到可选部门版的阶段规划 |
| [DECISIONS.md](DECISIONS.md) | 已采纳的关键技术和产品决策 |
| [ITERATION_LOG.md](ITERATION_LOG.md) | 每轮目标、完成项、验证结果和遗留问题 |
| [../SECURITY.md](../SECURITY.md) | 安全假设、数据保护要求和漏洞处理 |
| [../CHANGELOG.md](../CHANGELOG.md) | 面向版本的新增、变更、修复和限制 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 开发、测试、数据安全和文档维护规范 |
| [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | 直接依赖版本与开源许可证 |

## 建议阅读顺序

个人使用者：`README -> PRODUCT_SPEC -> OPERATIONS -> IMPORT_GUIDE`。

开发维护者：`ARCHITECTURE -> DATA_MODEL -> API -> UI_DESIGN -> DECISIONS -> TESTING`。

处理真实候选人数据前：必须先阅读 `FIELD_MAPPING`、`PRIVACY` 和根目录 `SECURITY`。

接入模型网关前：必须先阅读 `AGENT_SECURITY`、`PRIVACY` 和根目录 `SECURITY`。

准备升级为部门多人版前：先阅读 `ROADMAP` 中的多人版准入条件。当前代码没有认证、RBAC、HTTPS 或租户隔离，不能直接承担该场景。
