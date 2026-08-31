# Codex 交接单：工作年限宽容导入与原文展示（续做）

> 交接时间：2026-08-25。交接人：Claude Code。接手人：Codex。
> 任务在实施中途暂停交接。本单只授权继续实施该功能，不授权修改正式数据库、用户原始 Excel，或回滚/整理工作区中与本功能无关的改动。

## 必读权威文档（契约以它们为准，不得偏离）

1. `docs/superpowers/specs/2026-08-25-years-experience-tolerant-import-design.md`
2. `docs/superpowers/plans/2026-08-25-years-experience-tolerant-import.md`（Task 1-7 即执行骨架）
3. `docs/handoffs/2026-08-25-years-experience-tolerant-import-claude-code.md`
4. `C:\Users\cboy\.claude\plans\c-users-cboy-documents-shiny-music.md`（Claude Code 的完整实施计划，含探索结论与四个实现要点）

## 分支与提交状态

- 工作分支：`test11`（基于 `master` 的 `36af10b`）。
- 已提交：`185882e test: define tolerant work years import contract`（Task 1 测试先行检查点，当时为红测试）。
- 未提交的工作区改动（即 Task 2 代码，**已写完但尚未跑绿**）：
  - `server/validation.js`：删除旧 `normalizeYears`；新增导出 `normalizeYearsExperience` / `formatYearsExperience` 及内部 `parseUnambiguousYears`、中文数字辅助；`sanitizeCandidateInput` 的 years 块改写为成对产出、不再报错。
  - `server/database.js`：导入 `formatYearsExperience`；新增 `migrateV13Database`（ensureColumn + 仅回填 raw='' 且数值非 NULL 行 + 台账 `(13, 'candidate_years_experience_raw')`）；`migrateTalentDatabase` 已挂调用；基础 `CREATE TABLE candidates` 已加 `years_experience_raw TEXT NOT NULL DEFAULT ''`；`serializeCandidate` 已输出 `years_experience_raw`（`?? ''`）与 `years_experience_display`。
  - `server/constants.js`：`CANDIDATE_FIELDS` 加 `years_experience_raw`；`EXPORT_FIELDS` 已排除 raw 列；`FIELD_LABELS` 加 `years_experience_raw: '工作年限（原文）'`。
  - `server/candidates.js`：INSERT 预编译语句加列加参；`insertCandidate` 默认记录 raw 兜底 `''`（NOT NULL 列，必须兜底）。
  - `tests/backend/years-experience-import.test.mjs`：在 Task 1 提交版基础上追加了 V13 迁移测试（旧库/新库/重开幂等/回填规则/serializeCandidate.display）。
  - `tests/backend/database-migration-idempotence-v9.test.mjs`：版本数组已加 13。
- 根目录存在临时脚本 `.tmp-fix-validation.py`（**未执行**，见下方中断点）。

## ⚠️ 中断点：继续前必须先做这两件事

### 1. 修复 `server/validation.js` 中的字面控制字节正则

`normalizeYearsExperience` 里的 `.replace(/[ --]/g, '')`（约 292 行）被误写为**字面 C0/C1 控制字节**（实际字节 `\0-\037\177-\302\237`，等价于 `[\u0000-\u001f\u007f-\u009f]`）。功能上可能正确，但源码含控制字符，`grep` 已把该文件识别为 Binary，必须改成转义形式。

仓库根目录已备好修复脚本，直接执行后删除：

```bash
python .tmp-fix-validation.py && rm .tmp-fix-validation.py
```

脚本会把该行重写为 `.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')` 并扫描全文件残留控制字节（预期输出 `replaced ok; residual control chars: 0`）。
**同样检查** `tests/backend/years-experience-import.test.mjs` 是否有残留控制字节（控制字符用例应使用 `String.fromCharCode(3)` 构造，如有字面字节同样改为显式转义）。

### 2. 跑 Task 2 聚焦测试并提交

```bash
node --test tests/backend/years-experience-import.test.mjs tests/backend/database-migration-idempotence-v9.test.mjs
```

预期全绿（解析矩阵、sanitize 成对产出、V13 新库/旧库/幂等/回填/不补 0）。绿后提交：

```bash
git add server/database.js server/validation.js server/constants.js server/candidates.js tests/backend/years-experience-import.test.mjs tests/backend/database-migration-idempotence-v9.test.mjs
git commit -m "feat: preserve raw work years alongside numeric projection"
```

若测试失败，优先怀疑：(a) 控制字节正则未修复；(b) `parseUnambiguousYears` 的语法分支顺序；(c) V13 回填 UPDATE 触发器副作用。不要放宽测试断言。

## 已确定的解析契约（已实现，勿重新设计）

- 数值投影只对**全文匹配**白名单语法生成；任何多余修饰/范围/类别文字都使 numeric 为 null、raw 保留原文。覆盖：`3`、`3.5`、`3年`、`3 年`、`3 years`、`3 yrs`、`3年6个月`、`42个月`、`三年`、`三年半`、`半年`(0.5)、`3年半`、`十年`/`十五年`/`二十年` 等中文组合、`0`、`100年`、`150`。
- 护栏：整数部分 ≤4 位、小数 ≤4 位（40 位长数字串 → null）；月份必须为整数；`半` 与 `个月` 同现 → null；结果四舍五入到 2 位小数。
- raw：去 C0/C1 控制字符、trim、截断 1000 字符；空值返回 `{ raw:'', numeric:null, provided:false }`。
- `sanitizeCandidateInput`：full 模式始终产出 `years_experience` + `years_experience_raw`（未提供时 `null`+`''`）；partial 模式仅当输入含 `years_experience` 键才产出（显式 `''` = 清空两者；缺键 = 不动）；**永远不再产生 years_experience 错误**。
- `formatYearsExperience`：raw 非空优先；数值次之（整数去 `.0`，小数 toFixed(4) 去尾零）；全无返回 `''`。

## 剩余步骤（Task 3-7，按序执行）

### Task 3 — CRUD/通用导入/北森导入/导出贯通（`beisen-import.js` 与 `import-export.js` 尚未改动）

先往 `tests/backend/years-experience-import.test.mjs`（或 `api.test.mjs`/`xls-import.test.mjs` 风格的新段）补失败断言：创建回环 `raw='3年6个月', numeric=3.5`；无法解析 `raw='经验不详', numeric=null`；预览行不再有 `years_experience` 错误；北森后续**空单元格不清除**既有 raw+numeric；北森后续**非空无法解析值成对覆盖**（raw 更新且 numeric 变 null）；手机/邮箱冲突仍失败。

生产代码改动点（行号基于暂停时状态）：

1. `server/beisen-import.js:575`：`fieldValue(values, 'years_experience', 80)` 的 80 字符截断改为 1000（对齐 raw 上限）。
2. `server/beisen-import.js` `mergeCandidateValues`（191-202）：`years_experience` 与 `years_experience_raw` 必须**成对覆盖**——incoming 的 `years_experience_raw` 非空时，把 `years_experience`（即使为 null）一并写 target；单独跳过 `years_experience` 键避免旧值残留。
3. `server/beisen-import.js` `patchFromCandidate`（1034-1038）：同理，`years_experience_raw` 非空时保留 `years_experience` 即使为 null（通用过滤 `value != null && value !== ''` 会把无法解析的 numeric=null 丢掉，导致旧数值与新原文矛盾）。
4. `server/import-export.js` `importUpdatePatch`（610-619）：同样的成对处理。
5. `server/import-export.js` `exportCandidates`（约 938-953）：现有“工作年限”列的值改用 `years_experience_display`（serializeCandidate 已产出），不新增原文列，CSV 公式中和保持不变。
6. `server/app.js`：预期无改动（响应经 `serializeCandidate`）。

聚焦验证：`node --test tests/backend/years-experience-import.test.mjs tests/backend/xls-import.test.mjs tests/backend/api.test.mjs`，绿后提交 `feat: make candidate imports tolerant of work years text`。

### Task 4 — API 类型与候选人 UI

- `src/types.ts:170`：`years_experience: number | null`；`Candidate` 加 `years_experience_raw: string`、`years_experience_display: string`；`CandidateDraft`（725-755 Pick 含该字段）的 years 改为 `string`；`emptyDraft:886` 的 `0` 改 `''`。
- `src/api.ts:975`：`Number(candidate.years_experience ?? 0)` 改为镜像 971 行 age 的空值保护；`normalizeCandidate` 为 raw/display 补兼容默认（旧响应 raw=`''`、display=格式化数字或 `''`）。
- `src/components/CandidateForm.tsx:69`：`type="number"` 控件（`Math.max(0, Number(...))`，清空会变 0）改为文本输入；`:38` `draftFrom` 用 display/raw 回填；提交原样字符串。
- `src/components/CandidateDrawer.tsx:237` 与 `PipelineBoard.tsx:80`：truthy 判断会把显式 0 隐藏——改为优先 `years_experience_display`，空值空白、显式 0 显示 0、无字面量 null。
- UI 断言用 `candidate-demographics-ui.test.mjs` 的 readFileSync+正则风格，先写失败断言。
- `npx tsc --noEmit`、`npm run build` 绿后提交 `feat: display original work years text in candidate UI`。

### Task 5 — 附件解析与预填充

- `server/attachments.js`：`normalizeExtractedField`（1241-1243）years 分支整串窄正则改为保留有界原文；`textCandidateValues` 自由文本兜底（1392-1397）`Number(years[1])` 改为保留原文（捕获“数值+单位”段）；`ALLOWED_UPDATE_FIELDS`（143-153）加 `years_experience_raw` 使确认更新成对落库。证据/置信度逻辑不动。
- `src/attachment-candidate-prefill.ts:129,148`：去 `Number(...)` 和 `: 0` 兜底，建议值按原文透传到草稿（缺失不出现在草稿中）。
- 更新 `tests/backend/attachment-semantic-parsing.test.mjs`、`attachment-candidate-prefill.test.mjs` 既有 years 期望（当前断言数字建议值与 `: 0` 兜底）。
- 聚焦附件三件套绿后提交 `fix: preserve raw work years from attachment suggestions`。

### Task 6 — 文档同步

`CHANGELOG.md`（Unreleased 加 V13 条目）、`README.md`、`docs/README.md`、`docs/DATA_MODEL.md`（97 行一带）、`docs/API.md`（83/185 行）、`docs/FIELD_MAPPING.md`（96 行 F3#24）、`docs/IMPORT_GUIDE.md`（255 行改解析表）、`docs/TESTING.md`、`docs/OPERATIONS.md`（V12→V13 迁移与回滚 runbook）、`docs/DECISIONS.md`、`docs/ITERATION_LOG.md`（2026-08-25 条目）、`docs/UI_DESIGN.md`（如需）。
口径审计：`rg -n "0 至 80|工作年限提取首个数字|V13" CHANGELOG.md README.md docs`，确认无存活的旧承诺。提交 `docs: specify V13 tolerant work years behavior`。

### Task 7 — 端到端验证 + 100 条样本只读核验

- 全量：`npm test`、`npx tsc --noEmit`、`npm run build`、`git diff --check`。
- 对 `C:\Users\cboy\Desktop\人才库简历\自定义excel7-20caac42-246c-402c-a583-45e991ec30b3.xls`（36.7 MiB，低于 64 MiB 导入上限）只读预览：脚本仅放 `.tmp-years-experience-verify/`（用后删除），用 `createImportPreview` + `ImportPreviewStore` 取全量 prepared rows 的前 100 条，临时库用临时文件路径，**不写正式库、不改原文件**。聚合：总行数/有效行数/仅工作年限失败数（应为 0）/其他错误数/raw 计数/数值投影计数/身份冲突数/职位匹配与新建数/人才库关系数/来源历史数；证明文件 SHA-256 前后一致。
- 脱敏聚合（无姓名/手机/邮箱/ID/payload/token）写 `docs/evidence/v13-years-experience-import-20260825.json`，提交 `test: verify tolerant work years import`。
- 遇与本功能无关的既有失败：原样列测试名，不放宽新断言。

## 四个已确认的实现要点（勿返工）

1. **成对写入**：凡 `value != null && value !== ''` 的通用过滤（`patchFromCandidate`、`importUpdatePatch`、`mergeCandidateValues`）都要对工作年限成对放行——非空 raw 必须携带 numeric（可为 null），空 raw 两者都不写。
2. **EXPORT_FIELDS 陷阱**：`CANDIDATE_FIELDS` 新增 raw 会自动带入导出列，已排除（导出仍单列“工作年限”，值为 display）。
3. **NOT NULL 默认**：`insertCandidate` 的 CANDIDATE_FIELDS null 默认记录已单独兜底 raw 为 `''`。
4. **无需改动**：数值筛选 `business-search.js:2960-2967` / `resume-search.js:380-387`（`>= ?`/`<= ?` 天然排除 NULL）；`sort=years_experience`（`candidates.js:53-65`）走 REAL 列。`resume-search.js:334-336`、`agent.js:425-426` 的筛选入参 0-80 上限与存储解耦，本次不改，文档记为已知限制。

## 硬约束

- 任何路径禁止 `Number(value ?? 0)` 处理缺失工作年限；只有明确 0 才数值 0。
- 手机/邮箱冲突等既有错误仍必须失败（独立路径：`beisen-import.js:524,950-953,1255-1263`、`import-export.js:525`）。
- 空值在增量导入中不覆盖已有值；显式 API 清空同时清 raw 与 numeric。
- 不得安装新依赖；不得重写职位关系/人才库关系/来源历史/入职字段逻辑；不得写正式数据库或改用户原始 `.xls`；不得公开输出候选人敏感信息。
- 每个 Task 绿后独立提交（提交信息已在上文给出），便于逐个 revert。

## 交付回报

完成后回报：修改文件清单、V13 迁移名称、解析矩阵实际结果（尤其 0/未知文本/范围值）、聚焦+全量测试/TypeScript/构建/`git diff --check` 结果、100 条样本脱敏聚合与证据路径、未完成项与回滚方式。
