# 第十四轮无效 UI 与隐藏节点审计

日期：2026-09-17

审计同时使用 `rg` 代码引用、React JSX 路径检查、匿名浏览器 DOM 快照和 `tests/backend/ui-cleanup-contract.test.mjs`。正式数据库、真实候选人和真实模型网关未参与。

## 删除项

| 项目 | 原显示条件与触发者 | 引用证据 | 处理 |
| --- | --- | --- | --- |
| `AssistantDrawer` modal drawer 返回分支 | 只有 `presentation === "drawer"` 时显示；当前仓库没有调用方 | 唯一调用点始终传 `presentation="page"`；无测试或运行时路径使用 drawer | 删除分支、prop、drawer 专属 `History` icon、`tw-assistant-drawer`、`tw-tool-tabs` |
| `ExportMenu` | 从未渲染；顶层函数无调用点 | `CandidatesView` 已有独立导出菜单；`rg ExportMenu` 仅命中原定义 | 删除函数、`FileDown`/`FileSpreadsheet` import、`.export-menu` 和 `menu-in` |
| `AppShell.overlays` | 只有调用方显式传入时才渲染；当前无调用方 | `overlays` 仅在 `AppShell` 自身声明、解构和插槽中使用 | 删除可选 prop、解构、插槽和 `ReactNode` 的无关使用 |
| `AssistantDrawer.onOpenCandidate` | 只有 `onOpenCandidateId` 缺失且调用方传入该 prop 时显示；当前无调用方 | `App` 只传 `onOpenCandidateId`；测试明确禁止 App 传 fallback | 删除 prop、candidate API fallback 和对应 import；结果始终按 ID 打开 |
| AI 历史窄轨 | 只有历史会话收起时显示；改用页头开关和覆盖层后无职责 | `AssistantDrawer` 不再渲染 `.tw-tool-rail`，测试要求其数量始终为 0 | 删除 JSX 和 CSS，避免双重侧栏与额外宽度占用 |
| 旧 CSS 选择器 | 无匹配 JSX | `assistant-content`、`assistant-composer`、`assistant-mode-tabs`、`assistant-session-item`、`assistant-drawer`、旧 `note-composer`、`tw-avatar-accent`、`tw-session.active` 均无当前类名引用 | 删除选择器和只服务于删除分支的组合规则 |

## 保留项

| 节点或状态 | 保留原因 |
| --- | --- |
| `.tw-content-stack[hidden]` | 工具页、导入页打开时避免两个表面同时可交互；关闭后恢复原页面，保留页面状态和滚动 |
| `.assistant-task-process-content[hidden]` | 用户可展开/收起的执行过程；与 `aria-expanded`、`aria-controls` 和任务状态同步 |
| 响应式 `display:none` 列 | 窄屏列优先级降级，不代表永久无效；数据仍由服务端分页返回 |
| `.tw-session-actions { display:none }` | 行 hover、`focus-within` 或 active 时显示；已为键盘焦点补充 `:focus-within` |
| `.tw-row-actions { opacity:0 }` | 行 hover/focus 显示，触屏媒体查询恢复可见；焦点状态可访问 |
| 透明 pool/file input | 真实交互控件，用视觉层覆盖原生 input，不可删除 |
| `.sr-only` | screen-reader-only 无障碍内容，例如操作列标题和文件 input label |
| 空态、加载、错误、确认弹窗 | 状态性节点；代码按条件挂载或在用户操作后显示 |
| 移动端侧栏、scrim、抽屉 | 由导航状态或用户操作触发，不是永久隐藏副本 |

## 结论

没有发现仍需删除的“永久不可达 React JSX”。除已列删除项外，所有隐藏选择器都有响应式、交互、焦点、无障碍或运行状态职责。浏览器 DOM 快照保存在 `qa-report.json` 的 `hidden_audit` 字段：候选人详情活动页 93 个、AI 空态 23 个、AI 加载态 23 个。标记为可交互的隐藏元素只有移动导航按钮和工具页全局侧栏收起按钮：前者在桌面端不适用，后者在工具页已自动压缩为图标栏，均由响应式规则控制。若未来需要再次删除隐藏节点，必须先证明调用路径不可达并同步更新契约测试。
