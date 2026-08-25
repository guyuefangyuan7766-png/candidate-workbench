# 候选人入职信息扩展 V12 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `hire_position`，为有日期无状态的候选人补状态 `不确定`，条件显示入职信息区块，并用 100 条真实北森记录验证入职字段、人才库、来源和职位关系。

**Architecture:** 在现有候选人字段白名单/校验层增加 V12 字段与兜底规范化；SQLite 采用幂等加法迁移。北森解析沿用稳定 `应聘者ID` upsert、人才库/来源快照和明确职位关系解析，前端复用 CandidateForm/CandidateDrawer 的现有分区模式，导出沿用 `EXPORT_FIELDS`。

**Tech Stack:** Node.js 24、SQLite `node:sqlite`、Express、React 19/TypeScript、Node test runner、ExcelJS 导入导出、loader 提供的 `@oai/artifact-tool` 仅用于临时样本工作簿检查。

**Spec:** `docs/superpowers/specs/2026-08-21-hire-information-v12-design.md`

## Global Constraints

- `hire_position` trim 后最多 300 字符；`hire_status` trim 后最多 200 字符；日期统一 `YYYY-MM-DD`，允许未来日期。
- 当有效 `hire_date` 非空且有效 `hire_status` 为空时，规范化状态必须是精确文本 `不确定`。
- 增量导入空值不清除已有入职字段；不把 `入职雇佣关系` 当作 `hire_status`。
- 三项入职字段全空只隐藏档案区块，不删除或过滤候选人。
- 关联职位由明确申请/职位字段建立；北森“最后职位类投递的职位id”就是关联职位键，值为空时不创建关系；不把 `入职职位` 作为招聘职位键。整份工作簿没有该专用表头时，普通 `职位编号` 才允许兼容回退。
- 原始 `.xls` 只读；验证样本最多提交 100 条通过校验的真实行。
- 任何生产代码变更先有失败测试；所有对外文档同步 V12、字段映射、验证证据和已知限制。

### Task 1: V12 schema and validation contract

**Files:**
- Modify: `server/database.js`, `server/constants.js`, `server/validation.js`
- Test: `tests/backend/hire-status-v11.test.mjs`

- [x] Add failing tests for V12 migration/idempotence, `hire_position` length, and date-without-status fallback.
- [x] Run `node --test tests/backend/hire-status-v11.test.mjs` and confirm the new assertions fail for the missing column/rule.
- [x] Add `hire_position` to the base table, legacy ensure-column path, V12 migration/index, field whitelist, export field list, and labels; add aliases and fallback normalization.
- [x] Re-run the focused test and confirm V11 and V12 migration rows, preserved legacy candidate, canonical values, and validation failures.

### Task 2: CRUD, Beisen import, generic import, and export

**Files:**
- Modify: `server/candidates.js`, `server/beisen-import.js`, `server/import-export.js`, `server/validation.js`
- Tests: `tests/backend/hire-status-v11.test.mjs`, `tests/backend/xls-import.test.mjs`

- [x] Add failing assertions that CRUD/export round-trip all three fields, Beisen maps `入职职位`, and a date-only row receives `不确定`.
- [x] Run the focused backend tests and confirm failures.
- [x] Implement field mapping/persistence and preserve existing non-empty update semantics; ensure source raw payload still contains unprojected source columns.
- [x] Add explicit import tests with talent-pool/source columns and `最后职位类投递的职位id`, including conflicting ordinary `职位编号`, proving the dedicated field controls `candidate_positions` while `入职职位` remains separate.
- [x] Re-run focused tests and inspect CSV headers/values for all three fields.

### Task 3: Candidate form and conditional drawer section

**Files:**
- Modify: `src/types.ts`, `src/api.ts`, `src/components/CandidateForm.tsx`, `src/components/CandidateDrawer.tsx`
- Tests: `tests/backend/candidate-demographics-ui.test.mjs`, `tests/backend/hire-status-v11.test.mjs`

- [x] Add failing source-contract tests for `hire_position` draft initialization/control, conditional section predicate, detail labels, and absent-field compatibility.
- [x] Run the UI tests and confirm the new assertions fail.
- [x] Add the type/default/API normalization and three-field form controls; render the section only when at least one field is non-empty.
- [x] Re-run UI tests and `npm run build`.

### Task 4: Documentation and evidence contract

**Files:**
- Create: `docs/superpowers/specs/2026-08-21-hire-information-v12-design.md`, `docs/superpowers/plans/2026-08-21-hire-information-v12.md`
- Modify: `README.md`, `CHANGELOG.md`, `docs/README.md`, `docs/PRODUCT_SPEC.md`, `docs/UI_DESIGN.md`, `docs/DATA_MODEL.md`, `docs/API.md`, `docs/FIELD_MAPPING.md`, `docs/IMPORT_GUIDE.md`, `docs/TESTING.md`, `docs/OPERATIONS.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md`, `docs/ITERATION_LOG.md`

- [x] Add failing documentation assertions for V12, `hire_position`, `不确定`, conditional display, talent-pool/source/position verification, and the source file's missing status column.
- [x] Run the focused documentation test and confirm it fails before edits.
- [x] Update native sections, version references, operational rollback notes, and validation commands without exposing candidate payloads or tokens.
- [x] Run the targeted documentation audit and scoped `git diff --check` for the release documents.

### Task 5: Real 100-row import verification

**Files:**
- Modify only temporary verification scripts under `.tmp-import-verify` or delete them after use.
- Create: `docs/evidence/v12-hire-information-import-20260821.json` (脱敏统计 only)

- [x] Parse the supplied `.xls` read-only and record headers/row counts; exclude source rows failing existing validation and select exactly 100 dated rows.
- [x] Preview through the existing async HTTP import task endpoint; confirm `profile=beisen_talent`, `total_rows=100`, `valid_rows=100`, hire fields in the 20 returned preview rows, talent-pool/source presence, and the `最后职位类投递的职位id` relationship aggregate.
- [x] Use the verified production backup and fixed workbook SHA-256, commit the idempotent preview once with `on_duplicate=update`, and record aggregate counters (`imported=0`, `updated=100`, `failed=0`, `skipped=0`).
- [x] Record the user's explicit waiver of the retry-copy and production 22 GB full-database digest/full-row postcheck; do not claim production row-by-row, integrity, foreign-key, or recovery-rehearsal completion from the HTTP aggregate result.
- [x] Save only aggregate counts and hashed task references in `docs/evidence/v12-hire-information-formal-import-20260824.json`; never save raw names, phones, emails, preview tokens, or candidate identifiers.

### Task 6: Full verification and cleanup

- [x] Under the user's direct-deployment instruction, do not rerun the focused/full/build or whole-database checks; retain the earlier focused/review evidence and run the required normal-service health check.
- [x] Preserve the dirty user attachment work and limit final edits to V12 release documentation/evidence plus temporary-artifact cleanup.
- [x] Remove the V12 recovery copies, spreadsheet previews, and temporary import scripts without touching the source `.xls`, the approved 100-row XLSX, or the production backup.
- [x] Update the plan checklist and report the exact HTTP import result plus the source limitation (no native `入职状态` column in the original file) and the explicitly waived checks.
