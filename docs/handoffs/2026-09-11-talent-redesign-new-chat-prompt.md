# 新对话交接提示词

复制下方正文到**当前本地项目的新对话**。不要只从默认分支创建空白工作区；本项目存在尚未提交的重要功能和被Git忽略的设计图。

---

请接手 `C:/Users/cboy/Documents/北森` 的人才库全套前端改版，按已经确认的设计和方案直接完成实现、回归与本地预览。

## 已经确认，无需重新问我

1. 我认可整套22张设计图：白灰蓝、克制边框、高密度人才列表、桌面优先、右侧候选人详情。
2. 改造现有全部8个入口和详情/编辑/导入/批量状态，保持现有业务；不增加面试排期、Offer、审批等完整ATS模块。
3. 唯一设计文案修订：候选人“当前职位/公司”统一改为“最近职位/公司”，“当前经历/教育摘要”改为“最近经历/教育摘要”。单字段用“最近职位”“最近公司”，详情标题用“最近经历与教育摘要”，分区“当前经历”用“最近经历”。覆盖表格、表单、空值、辅助文本、导入映射、附件建议和搜索证据等显示。
4. 不重命名 `current_title`、`current_company` 或数据库/API键，不自动推算或覆写履历。“从当前职位解除关联”指当前招聘职位，不能机械改成“最近职位”。原始导入表头和历史原文保留兼容。
5. 设计已经批准，这一对话开始执行开发，不再生成三套方向或反复询问是否可以改代码。普通可逆实现、检查和修复直接推进。

## 开工前按顺序阅读

- `docs/superpowers/specs/2026-09-11-talent-workspace-approved-design.md`
- `docs/superpowers/plans/2026-09-11-talent-workspace-redesign.md`
- `docs/handoffs/2026-09-11-talent-redesign-baseline.json`
- `output/design-atlas/manifest.json` 和 `output/design-atlas/DESIGN.md`
- 打开 manifest 中的22张真实图片，不只读提示词或文件名。09/11/13使用manifest指定的v2修订图。
- 当前 `README.md`、`docs/ARCHITECTURE.md`、`docs/UI_DESIGN.md`、`docs/API.md`、`docs/TESTING.md`、`docs/handoffs/2026-09-10-search-hybrid-delivery.md`。

规范中的新术语、真实业务约束和五个固定详情页签优先于图里的旧文字、假数字、错误必填项及页签变体。五页签为：档案、履历、历史评估、备注与动态、高级信息。

## 工程现状

- React19 + TypeScript + Vite7 + Lucide，Express/SQLite，Node≥24。
- 工作区已有大量未提交和未跟踪修改，涵盖混合检索、附件、导入、AI。HEAD是 `8470f1cdb3664948c5ca5f6650b2fe92b99c5c64`，但HEAD不包含全部现有成果。先记录git状态与文件差异，不能reset/clean或按HEAD覆盖。
- `src/main.tsx` 实际导入 `styles.css` 和 `preview-theme.css`；后者不能因为叫preview就删除。`search.css` 和搜索代码同样需要保留。
- 前一对话最终交付是设计图册与开发文档，不是已验收完成的前端。不要把已有build或图册访问成功当作本轮实现完成。
- `output/` 被Git忽略，设计资产只在本地；若使用隔离worktree，先带入当前工作区必要代码与设计资产。优先在当前项目接续，不丢未提交工作。
- 图册离线入口为 `output/design-atlas/index.html`，打包为 `output/talent-design-atlas.zip`。此前图册服务用5188端口，不保证仍运行；需要时用 `python -m http.server 5188 --bind 127.0.0.1 --directory output/design-atlas`。

## 执行要求

按方案阶段推进：起点记录和匿名预览→术语与全局主题→列表/工作台→分组→五页签详情/编辑→职位→导入/附件→AI与检索→全站回归。

沿用真实组件和API，完成可交互前端，不能把效果图作为网页背景或交付另一个mock网站。搜索、筛选、分页、按职位视图、关系维护、归档恢复、受控永久删除、导入预览确认、附件差异勾选、AI只读会话和检索降级/证据/取消重试全部保留。

用独立虚构数据库和附件做可写验收，不操作真实候选人、正式数据目录或远程网关。可参考 `tests/browser/anonymous-hybrid-server.mjs` 与 `tests/fixtures/anonymous-search.mjs`。Vite默认API代理到4173，要确保预览实际连接匿名服务，不误连正式库。

不要用全局字符串替换损坏“当前招聘职位”的语境。不要为这次文案调整改数据库迁移、导入解析兼容键或搜索算法。不要把CSS修改变成大量无作用域的!important覆盖。

完成后运行相关测试、`npm run build`、`npm test`，并通过允许的浏览器工具逐页验证。旧browser QA有固定App哈希，不能直接复用为新设计验收或仅更新哈希跳过断言。检查1536×1024与1440×900桌面，补查1280、768、390下的导航、长文本、表格与抽屉。

最终交付：可打开的本地运行入口、源码改动摘要、22项设计覆盖及关键功能验收记录、截图和未解决限制。只有图册/截图/HTTP200不算实现完成。默认不发布、不切换正式服务、不提交真实业务数据。请从阅读上述文件和检查工作区开始，持续完成任务。

---

## 给接手者的状态说明

本提示词不含密钥，不依赖原对话工具句柄或临时进程。图片已经生成，不需要重新调用付费生图接口。若资产缺失，先检查原项目 `output/design-atlas/` 和ZIP；不要悄悄按文字重新设计。
