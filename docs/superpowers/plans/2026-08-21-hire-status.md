# 候选人入职信息与北森数据清理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在候选人主档中落地 `hire_status`/`hire_date`，支持北森与通用导入导出，并交付 7 份只保留有效入职状态行的 `.xlsx` 文件。

**Architecture:** 候选人主表增加两个可空、向后兼容的列，通过 V11 幂等迁移修复旧库；字段在服务端白名单和校验层统一规范化，再由现有 API、导入器和 React 档案组件复用。Excel 清理使用现有 BIFF8 解析器读取源数据，用 loader 提供的 `@oai/artifact-tool` 新建并导出每个清理后的工作簿，原文件只读保留。

**Tech Stack:** Node.js 24, SQLite (`node:sqlite`), Express, React 19 + TypeScript, Node test runner, `@oai/artifact-tool` 2.8.6。

**Spec:** `docs/superpowers/specs/2026-08-21-hire-status-design.md`

## Global Constraints

- 字段名固定为 `hire_status` 与 `hire_date`；不得复用 `candidate_preferences.employment_status` 或旧 `stage`。
- `hire_status` 保留非空原文，最大 200 字符；清理时空白、空单元格和精确文本 `空` 都视为空。
- `hire_date` 规范化为 `YYYY-MM-DD`，允许未来日期和状态有值但日期为空。
- V11 迁移必须幂等，不能重建、清空或覆盖既有候选人数据。
- UI 继续使用现有分区式表单、可见标签和响应式网格，不新增筛选器或流程功能。
- 原始 7 个 `.xls` 不得修改；输出目录为 `outputs/2026-08-21-hire-status-cleaned/`，每个源文件只生成一个 `_已整理.xlsx` 副本。
- 文档必须同步版本记录、迭代日志、数据模型、API、字段映射、导入指南、测试说明和 README。

---

### Task 1: 服务端字段契约与 V11 迁移

**Files:**
- Modify: `server/database.js`
- Modify: `server/constants.js`
- Modify: `server/validation.js`
- Create: `tests/backend/hire-status-v11.test.mjs`

**Interfaces:**
- Produces `normalizeHireDate(value): string | null` and `sanitizeCandidateInput` values containing `hire_status`/`hire_date`.
- Produces V11 schema columns and indexes visible through `PRAGMA table_info(candidates)` and `schema_migrations`.

- [x] **Step 1: Write the failing tests**

```js
test('V11 adds hire columns to a legacy database without rebuilding candidates', () => {
  // Create the pre-V11 candidates table, openDatabase(), then assert columns,
  // indexes, version 11, and preservation of a seeded candidate.
});

test('hire fields accept future dates and reject impossible dates', async () => {
  // POST with hire_status='待入职', hire_date='2026-09-17' succeeds and
  // POST/PATCH with hire_date='2026-02-30' returns 422.
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node --test tests/backend/hire-status-v11.test.mjs`

Expected: FAIL because V11 columns and `hire_date` validation do not exist.

- [x] **Step 3: Implement the minimal contract**

Add `hire_status` and `hire_date` to the base table, `ensureColumn` list, V11 migration, `CANDIDATE_FIELDS`, `EXPORT_FIELDS`, and `FIELD_LABELS`. Add aliases and a date normalizer that validates ISO/slash/Chinese dates without rejecting future dates; add the 200-character status limit.

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test tests/backend/hire-status-v11.test.mjs`

Expected: PASS with preserved legacy data and a single idempotent migration row.

- [x] **Step 5: Checkpoint the scoped diff**

Run: `git diff -- server/database.js server/constants.js server/validation.js tests/backend/hire-status-v11.test.mjs`

### Task 2: Candidate CRUD, imports, and exports

**Files:**
- Modify: `server/candidates.js`
- Modify: `server/beisen-import.js`
- Modify: `server/validation.js`
- Modify: `tests/backend/hire-status-v11.test.mjs`
- Modify: `tests/backend/xls-import.test.mjs`

**Interfaces:**
- `insertCandidate` and `patchCandidate` persist the two fields through the existing `CANDIDATE_FIELDS` contract.
- `candidateFromValues` maps exact Beisen headers and preserves non-empty update semantics.

- [x] **Step 1: Add failing CRUD/import/export assertions**

```js
test('candidate CRUD and exports round-trip hire fields', async () => {
  // POST, PATCH, GET, CSV/XLSX export; assert labels and canonical date.
});

test('Beisen import maps 入职状态 and 入职日期', async () => {
  // Preview/commit a row with an existing source ID and assert the candidate.
});
```

- [x] **Step 2: Run the focused tests and confirm the expected failures**

Run: `node --test tests/backend/hire-status-v11.test.mjs tests/backend/xls-import.test.mjs`

- [x] **Step 3: Implement the smallest mapping changes**

Extend `FIELD_ALIASES`, `candidateFromValues`, explicit candidate INSERT columns/arguments, and the existing export field list. Do not add global status filtering to unrelated imports; the supplied cleaned files provide that input boundary.

- [x] **Step 4: Re-run focused tests**

Run: `node --test tests/backend/hire-status-v11.test.mjs tests/backend/xls-import.test.mjs`

Expected: PASS, including empty-date rows and future dates.

- [x] **Step 5: Checkpoint the scoped diff**

Run: `git diff -- server/candidates.js server/beisen-import.js server/validation.js tests/backend`

### Task 3: Candidate form and detail display

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api.ts`
- Modify: `src/components/CandidateForm.tsx`
- Modify: `src/components/CandidateDrawer.tsx`
- Modify: `tests/backend/candidate-demographics-ui.test.mjs`

**Interfaces:**
- `Candidate`/`CandidateDraft` expose `hire_status: string` and `hire_date: string | null`.
- `normalizeCandidate` maps absent API values to `""`/`null` so old responses remain safe.

- [x] **Step 1: Write failing UI contract assertions**

```js
test('candidate form and drawer expose hire fields', () => {
  // Read the existing React sources and assert visible labels, draft
  // initialization, update handlers, and detail rendering.
});
```

- [x] **Step 2: Run the UI test to verify it fails**

Run: `node --test tests/backend/candidate-demographics-ui.test.mjs`

- [x] **Step 3: Implement the form and detail changes**

Add the fields to types/defaults/API normalization and place labeled controls in a new “入职信息” section. Render status and formatted date in the profile tab and add timeline field labels. Keep native `date` input, semantic labels, existing spacing, and no new icon-only controls.

- [x] **Step 4: Run the UI test and TypeScript build**

Run: `node --test tests/backend/candidate-demographics-ui.test.mjs`; `npm run build`

- [x] **Step 5: Checkpoint the scoped diff**

Run: `git diff -- src tests/backend/candidate-demographics-ui.test.mjs`

### Task 4: Documentation chain

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/ITERATION_LOG.md`
- Modify: `docs/DATA_MODEL.md`
- Modify: `docs/API.md`
- Modify: `docs/FIELD_MAPPING.md`
- Modify: `docs/IMPORT_GUIDE.md`
- Modify: `docs/TESTING.md`

**Interfaces:**
- Documentation names match the code contract exactly: `hire_status`, `hire_date`, V11, `YYYY-MM-DD`, and the “空” cleanup rule.

- [x] **Step 1: Add documentation assertions to the focused test**

```js
test('public documentation describes the hire fields and migration', () => {
  // Read the eight maintained documents and assert the exact field names,
  // V11, import rule, and verification command are present.
});
```

- [x] **Step 2: Run the documentation test and confirm it fails**

Run: `node --test tests/backend/hire-status-v11.test.mjs`

- [x] **Step 3: Update each document in its native section**

Record the user-facing feature in README/CHANGELOG/ITERATION_LOG; add columns and migration to DATA_MODEL; add response/import/export fields and examples to API; add F1/F3 handling and process-field boundary to FIELD_MAPPING; add cleaned-file preparation and empty marker semantics to IMPORT_GUIDE; add focused commands and real-file validation to TESTING.

- [x] **Step 4: Re-run documentation assertions and inspect diffs**

Run: `node --test tests/backend/hire-status-v11.test.mjs`; `git diff -- README.md CHANGELOG.md docs`

### Task 5: Clean and export the seven workbooks

**Files:**
- Create: `scripts/clean-hire-status-workbooks.mjs`
- Create: `scripts/hire-status-workbook-config.mjs`
- Create: `tests/backend/hire-status-workbooks.test.mjs`
- Generate: `outputs/2026-08-21-hire-status-cleaned/*.xlsx`

**Interfaces:**
- Script reads each listed `.xls` with `readCandidateImportFile`, filters `trim(status) !== '' && trim(status) !== '空'`, and writes one workbook via `@oai/artifact-tool`.
- Script prints a JSON summary with source row count, retained row count, and missing-date count per file.

- [x] **Step 1: Write the failing workbook validation test**

```js
test('cleaned workbooks contain only non-empty hire statuses', async () => {
  // Assert seven outputs, exact sheet/header order, row counts, status rule,
  // ID/date alignment, and typed yyyy-mm-dd dates.
});
```

- [x] **Step 2: Run the test to verify outputs are absent**

Run: `node --test tests/backend/hire-status-workbooks.test.mjs`

Expected: FAIL because the output directory/files do not exist.

- [x] **Step 3: Build the artifact-tool script**

Call `load_workspace_dependencies` paths, create a conversation-specific temp directory with a junction to the loader `node_modules`, import `FileBlob`/`SpreadsheetFile`/`Workbook` from `@oai/artifact-tool`, write header/data blocks, set `yyyy-mm-dd`, freeze the header row, render each sheet, inspect values/formulas, scan formula errors, and export exactly seven `.xlsx` files. Keep all source files untouched.

- [x] **Step 4: Run the script and the validation test**

Run: `node scripts/clean-hire-status-workbooks.mjs`; `node --test tests/backend/hire-status-workbooks.test.mjs`

Expected: seven outputs and zero blank/“空” status rows; visual previews are legible.

- [x] **Step 5: Checkpoint generated-file statistics**

Run: `Get-ChildItem outputs/2026-08-21-hire-status-cleaned -File | Select-Object Name,Length`; retain the script summary in the final report.

Completion evidence: the forced real-fixture workbook suite passed 4/4 with no skips, including the hard-link alias regression. The seven exports contain 1,390 retained rows from 62,861 source rows, remove 61,471 rows, preserve 4 rows whose hire date is empty, and leave every source `.xls` SHA-256 unchanged. The output directory contains exactly the seven expected `.xlsx` files plus `cleanup-summary.json`.

### Task 6: Full verification and handoff

**Files:**
- Modify only files required by prior tasks.

- [ ] **Step 1: Run the focused backend and UI tests**

Run: `node --test tests/backend/hire-status-v11.test.mjs tests/backend/hire-status-workbooks.test.mjs tests/backend/candidate-demographics-ui.test.mjs tests/backend/xls-import.test.mjs`

- [ ] **Step 2: Run the full test suite and production build**

Run: `npm test`; `npm run build`

- [ ] **Step 3: Review the final diff and worktree**

Run: `git diff --check`; `git status --short`; verify unrelated pre-existing changes remain untouched and output files are not staged accidentally.

- [ ] **Step 4: Report exact output paths, retained counts, tests, and documentation updates**

Use absolute file citations for every generated workbook and state any residual limitation, especially that original `.xls` files were preserved.
