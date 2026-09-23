# 工作年限宽容导入与原文展示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保留工作年限来源原文，让任意非空工作年限值不再阻断候选人导入，同时保留可安全解析的数值排序/筛选能力。

**Architecture:** 在现有 `years_experience REAL` 上增加 `years_experience_raw TEXT NOT NULL DEFAULT ''`，由统一校验层生成数值投影和展示原文。SQLite 通过 V13 幂等加法迁移兼容旧库；通用导入、北森导入、附件解析、API、前端和导出全部消费同一解析契约。

**Tech Stack:** Node.js 24、SQLite `node:sqlite`、Express、React 19/TypeScript、Node test runner、ExcelJS/现有 BIFF8 `.xls` 解析器。

**Spec:** `docs/superpowers/specs/2026-08-25-years-experience-tolerant-import-design.md`

## Global Constraints

- 非空工作年限永远先保存原文；无法安全数值化时通过，不生成 validation error，不写入 0。
- `years_experience` 继续作为数值投影并允许 `NULL`；`years_experience_raw` 使用空字符串表示无来源值；用户可见展示不得输出字面量 `null`。
- 只有明确的 0 才能产生数值 0；空值、未知文本、范围值和带不确定修饰词的值不按 0 处理。
- 增量导入空单元格不清除已有值；显式 API 清空同时清空原文和数值投影。
- 手机/邮箱冲突及其他既有身份、职位、归档和资源限制保持原行为。
- 原始 `.xls` 只读；样本验证最多提交/预览 100 条，开发阶段不写正式数据库。
- 生产代码先有失败测试；只提交本功能涉及的文件，不回滚工作区其他未提交改动。

### Task 1: 建立失败测试和解析契约

**Files:**
- Create: `tests/backend/years-experience-import.test.mjs`
- Modify: `server/validation.js`（仅在 Task 2 实现）
- Test: `tests/backend/years-experience-import.test.mjs`

**Interfaces:**
- Produces the test contract for `normalizeYearsExperience(value)` returning `{ raw: string, numeric: number | null, provided: boolean }`.
- Produces the contract that `sanitizeCandidateInput()` accepts non-empty unparseable work years without adding a `years_experience` error.

- [ ] **Step 1: Write the failing parser tests**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeYearsExperience, sanitizeCandidateInput } from '../../server/validation.js'

test('preserves source text while projecting safe durations', () => {
  const cases = [
    ['3', 3], ['3.5', 3.5], ['3 年', 3], ['3 yrs', 3],
    ['3年6个月', 3.5], ['42个月', 3.5], ['三年半', 3.5],
    ['应届', null], ['经验不详', null], ['1-3年', null], ['1至3年', null],
    ['约3年', null], ['100年', 100], ['-1年', null], ['', null]
  ]
  for (const [input, numeric] of cases) {
    const result = normalizeYearsExperience(input)
    assert.equal(result.numeric, numeric, input)
    assert.equal(result.raw, input, input)
  }
})

test('unparseable non-empty work years do not invalidate a candidate row', () => {
  const result = sanitizeCandidateInput({ name: '宽容测试', years_experience: '经验不详' })
  assert.deepEqual(result.errors, [])
  assert.equal(result.value.years_experience, null)
  assert.equal(result.value.years_experience_raw, '经验不详')
})
```

- [ ] **Step 2: Run the focused test and verify it fails for the current contract**

Run: `node --test tests/backend/years-experience-import.test.mjs`

Expected: FAIL because `normalizeYearsExperience` is not exported and current sanitization reports `工作年限必须是 0 至 80 之间的数字`.

- [ ] **Step 3: Add boundary tests before implementation**

Add assertions for numeric `0`, whitespace-only input, `Infinity`, a very long digit string, and a candidate row with a phone/email conflict. The last assertion must continue to produce the existing identity conflict after work-year tolerance is enabled.

- [ ] **Step 4: Commit the test-only checkpoint**

```bash
git add tests/backend/years-experience-import.test.mjs
git commit -m "test: define tolerant work years import contract"
```

### Task 2: Implement V13 storage and shared normalization

**Files:**
- Modify: `server/database.js`
- Modify: `server/validation.js`
- Modify: `server/constants.js`
- Test: `tests/backend/years-experience-import.test.mjs`, `tests/backend/database-migration-idempotence-v9.test.mjs`

**Interfaces:**
- Consumes: Task 1 parser tests.
- Produces: `normalizeYearsExperience(value) -> { raw: string, numeric: number | null, provided: boolean }` and `formatYearsExperience({ raw, numeric }) -> string`; `sanitizeCandidateInput()` values include `years_experience` and `years_experience_raw`.

- [ ] **Step 1: Implement normalization without changing callers yet**

In `server/validation.js`, add the exported function below. Keep the raw display string separate from the numeric projection and never throw for a string value.

```js
export function normalizeYearsExperience(value) {
  const raw = value == null ? '' : String(value).trim()
  if (!raw) return { raw: '', numeric: null, provided: false }
  const numeric = parseUnambiguousYears(raw) // finite non-negative number or null
  return { raw: raw.slice(0, 1000), numeric, provided: true }
}
```

`parseUnambiguousYears` must recognize plain numbers, year/month units, `年+个月`, and common Chinese numerals. It must return `null` for ranges, approximate/upper-bound qualifiers, negative values, categories and non-finite numbers. It must not use the old first-number regex as the acceptance rule.

- [ ] **Step 2: Change `sanitizeCandidateInput()` semantics**

When `years_experience` is present, assign `years_experience_raw` from the normalized result and assign the numeric projection. Remove the old invalid-work-years error. When the field is absent in a partial request, leave both fields absent so incremental imports cannot clear existing data. Preserve explicit empty clearing for ordinary API updates.

- [ ] **Step 3: Add the additive V13 migration**

Add `years_experience_raw TEXT NOT NULL DEFAULT ''` to the base `CREATE TABLE candidates`. Add `migrateV13Database(db)` after V12, register `(13, 'candidate_years_experience_raw')`, and make it safe to run repeatedly. Backfill only rows where the raw column is empty and the numeric column is non-null, using a canonical number string; leave null numeric values as empty raw text. Implement `formatYearsExperience({ raw, numeric }) -> string` once in a shared server module and reuse it for serialization/export fallback.

- [ ] **Step 4: Wire field metadata**

Add the raw field to candidate field whitelists/labels where a persisted field list is used. Do not expose it as an independently writable public field. Keep existing numeric sort/filter SQL unchanged and verify that null numeric values are not coerced to zero.

- [ ] **Step 5: Run migration and parser tests**

Run: `node --test tests/backend/years-experience-import.test.mjs tests/backend/database-migration-idempotence-v9.test.mjs`

Expected: PASS, including V13 on a new database, V13 on a V12 database, and a second startup with exactly one V13 migration row and unchanged legacy candidates.

- [ ] **Step 6: Commit the storage checkpoint**

```bash
git add server/database.js server/validation.js server/constants.js tests/backend/years-experience-import.test.mjs tests/backend/database-migration-idempotence-v9.test.mjs
git commit -m "feat: preserve raw work years alongside numeric projection"
```

### Task 3: Persist the pair through CRUD, generic import, Beisen import, and export

**Files:**
- Modify: `server/candidates.js`
- Modify: `server/app.js`
- Modify: `server/beisen-import.js`
- Modify: `server/import-export.js`
- Modify: `server/constants.js`
- Test: `tests/backend/years-experience-import.test.mjs`, `tests/backend/xls-import.test.mjs`, `tests/backend/api.test.mjs`

**Interfaces:**
- Consumes: `sanitizeCandidateInput()` output `{ years_experience, years_experience_raw }`.
- Produces: candidate rows and import previews that contain raw text, numeric projection, and `years_experience_display`.

- [ ] **Step 1: Add failing persistence and import assertions**

Cover all of the following before changing production code:

```js
assert.equal(created.years_experience_raw, '3年6个月')
assert.equal(created.years_experience, 3.5)
assert.equal(unparseable.years_experience_raw, '经验不详')
assert.equal(unparseable.years_experience, null)
assert.equal(preview.rows[0].errors.some((e) => e.field === 'years_experience'), false)
```

Also assert that an empty work-year cell in a later Beisen row does not erase a previously stored raw value, while a phone/email identity conflict still fails.

- [ ] **Step 2: Wire insert/update statements**

Update candidate insert and patch paths to write both columns in the same transaction. If a legacy caller supplies only a numeric value, derive a displayable raw number string; if it supplies only the raw source value, let the validator derive the numeric projection. Never use `Number(value ?? 0)` in a persistence path.

- [ ] **Step 3: Wire generic and Beisen mapping**

Keep the existing `工作年限` alias. `server/beisen-import.js` must pass the source cell through the shared validator and retain it in the candidate object and `raw_payload`. A non-empty unparseable source cell must not be added to the row error list.

- [ ] **Step 4: Wire export and preview projection**

In `server/import-export.js`, export the existing `工作年限` column from `years_experience_raw` first, then a formatted numeric fallback. Do not export `null` or `0` for missing values. Add `years_experience_display` to preview/API serialization without exposing raw payloads.

- [ ] **Step 5: Run focused import/API tests**

Run: `node --test tests/backend/years-experience-import.test.mjs tests/backend/xls-import.test.mjs tests/backend/api.test.mjs`

Expected: PASS for CRUD round-trip, generic `.xlsx`/CSV mapping, BIFF8 `.xls` mapping, export round-trip, empty incremental update semantics, and independent identity conflict behavior.

- [ ] **Step 6: Commit the import checkpoint**

```bash
git add server/candidates.js server/app.js server/beisen-import.js server/import-export.js server/constants.js tests/backend/years-experience-import.test.mjs tests/backend/xls-import.test.mjs tests/backend/api.test.mjs
git commit -m "feat: make candidate imports tolerant of work years text"
```

### Task 4: Update API types and candidate UI

**Files:**
- Modify: `src/types.ts`
- Modify: `src/api.ts`
- Modify: `src/components/CandidateForm.tsx`
- Modify: `src/components/CandidateDrawer.tsx`
- Modify: `src/components/PipelineBoard.tsx`
- Test: `tests/backend/years-experience-import.test.mjs`, `tests/backend/candidate-demographics-ui.test.mjs`

**Interfaces:**
- Consumes: API fields `years_experience: number | null`, `years_experience_raw: string`, `years_experience_display: string`.
- Produces: a text-safe candidate draft and UI that never renders `null` or hides an explicit `0`.

- [ ] **Step 1: Add failing source-contract assertions**

Assert that the source contains a raw/display field, that `normalizeCandidate()` does not default years to 0, that the form control is text-capable, and that drawer/board output uses raw/display before numeric formatting.

- [ ] **Step 2: Update TypeScript contracts**

Change persisted `Candidate.years_experience` to `number | null`; add `years_experience_raw: string` and `years_experience_display: string`. Make the editable draft value a string so `3年6个月` survives a round trip. Allow create/update request payloads to send `string | number | null` for the input field.

- [ ] **Step 3: Update API normalization**

Replace `Number(candidate.years_experience ?? 0)` with null-preserving normalization. Use a shared display helper or server-provided display value, with fallback `raw || formattedNumeric || ''` for old API responses that lack the new fields.

- [ ] **Step 4: Update form and displays**

Use a text input in `CandidateForm`, initialize it from raw text, and submit the source text. In `CandidateDrawer` and `PipelineBoard`, render `years_experience_display` or raw text; use an explicit non-empty check so source `0` remains visible and absent values render as empty content.

- [ ] **Step 5: Run UI/build checks**

Run: `node --test tests/backend/years-experience-import.test.mjs tests/backend/candidate-demographics-ui.test.mjs`

Then run: `npx tsc --noEmit` and `npm run build`.

Expected: focused source-contract tests, TypeScript, and production build all pass with no `null`/0 fallback regression.

- [ ] **Step 6: Commit the UI checkpoint**

```bash
git add src/types.ts src/api.ts src/components/CandidateForm.tsx src/components/CandidateDrawer.tsx src/components/PipelineBoard.tsx tests/backend/years-experience-import.test.mjs tests/backend/candidate-demographics-ui.test.mjs
git commit -m "feat: display original work years text in candidate UI"
```

### Task 5: Align attachment parsing and prefill

**Files:**
- Modify: `server/attachments.js`
- Modify: `src/attachment-candidate-prefill.ts`
- Modify: `server/attachment-model-contract.js` only if its field contract needs a type clarification
- Test: `tests/backend/attachment-semantic-parsing.test.mjs`, `tests/backend/attachment-candidate-prefill.test.mjs`, `tests/backend/years-experience-import.test.mjs`

**Interfaces:**
- Consumes: the same `normalizeYearsExperience()` contract as file imports.
- Produces: attachment suggestions that retain raw work-year evidence and never default missing values to 0.

- [ ] **Step 1: Add failing attachment assertions**

Cover `3年6个月`, `应届`, empty extraction, and an explicit `0`. Assert that the prefill draft uses raw text and that an absent suggestion does not produce numeric zero.

- [ ] **Step 2: Route attachment values through the shared normalizer**

Change the text/visual extraction path so it returns the source text for work years and lets the candidate sanitizer calculate the numeric projection. Remove the `Number(...)` plus `: 0` default in `src/attachment-candidate-prefill.ts`.

- [ ] **Step 3: Run attachment tests**

Run: `node --test tests/backend/attachment-semantic-parsing.test.mjs tests/backend/attachment-candidate-prefill.test.mjs tests/backend/years-experience-import.test.mjs`

Expected: PASS, with existing evidence and confidence validation unchanged.

- [ ] **Step 4: Commit the attachment checkpoint**

```bash
git add server/attachments.js src/attachment-candidate-prefill.ts server/attachment-model-contract.js tests/backend/attachment-semantic-parsing.test.mjs tests/backend/attachment-candidate-prefill.test.mjs tests/backend/years-experience-import.test.mjs
git commit -m "fix: preserve raw work years from attachment suggestions"
```

### Task 6: Update release and operational documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/DATA_MODEL.md`
- Modify: `docs/API.md`
- Modify: `docs/FIELD_MAPPING.md`
- Modify: `docs/IMPORT_GUIDE.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/ITERATION_LOG.md`
- Test: documentation audit commands below

**Interfaces:**
- Consumes: the implemented V13 schema and API behavior.
- Produces: a consistent release note, migration runbook, field mapping, test record, and known-limitation statement.

- [ ] **Step 1: Update data and API contracts**

Document both fields, the `years_experience_display` response field, null-preserving numeric semantics, and the distinction between empty, unknown text, and explicit zero.

- [ ] **Step 2: Update import guidance and field mapping**

Replace the old “extract first number, reject values outside 0-80” wording with the parser table from the spec. State that work-year format alone never fails a row, while phone/email conflicts still do.

- [ ] **Step 3: Update version and operations records**

Add an Unreleased V13 entry, migration order V12→V13, backup/rollback instructions, focused/full test commands, and the fact that production deployment is not complete until the 100-row read-only verification is recorded.

- [ ] **Step 4: Audit documentation consistency**

Run:

```powershell
rg -n "0 至 80|工作年限提取首个数字|years_experience_raw|V13|不显示.*null|不按 0" CHANGELOG.md README.md docs
git diff --check
```

Expected: no active documentation still promises rejection of non-numeric work years; all V13 references use the same field names and semantics.

- [ ] **Step 5: Commit documentation checkpoint**

```bash
git add CHANGELOG.md README.md docs
git commit -m "docs: specify V13 tolerant work years behavior"
```

### Task 7: End-to-end verification with the supplied workbook

**Files:**
- Create: `docs/evidence/v13-years-experience-import-20260825.json` (脱敏汇总 only)
- Modify/Delete: temporary files under `.tmp-years-experience-verify/` only
- Test: all focused tests, full test suite, TypeScript/build, read-only workbook preview

**Interfaces:**
- Consumes: all previous task outputs and the existing import HTTP preview endpoint.
- Produces: reproducible aggregate evidence without names, phone numbers, emails, source payloads or preview tokens.

- [ ] **Step 1: Run the focused backend and attachment suite**

Run:

```powershell
node --test tests/backend/years-experience-import.test.mjs tests/backend/xls-import.test.mjs tests/backend/attachment-semantic-parsing.test.mjs tests/backend/attachment-candidate-prefill.test.mjs tests/backend/candidate-demographics-ui.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 2: Preview at most 100 rows from the supplied `.xls` read-only**

Use the existing import entry with `C:\Users\cboy\Desktop\人才库简历\自定义excel7-20caac42-246c-402c-a583-45e991ec30b3.xls`. Do not edit or overwrite the source. Select no more than 100 rows and record only aggregate counts: total rows, valid rows, work-year-only errors, other errors, raw-value count, numeric-projection count, identity-conflict count, matched/created position counts, talent-pool relation count, and source-history count.

- [ ] **Step 3: Verify the preview contract**

Confirm at least one non-standard value appears in `years_experience_raw`, no row fails solely because of work years, explicit `0` remains 0, unknown text remains non-empty, and phone/email conflicts remain visible as conflicts. Confirm `最后职位类投递的职位id` still controls recruitment-position relations, while talent-pool and source fields continue using their established relation/history paths.

- [ ] **Step 4: Run the complete verification set**

Run: `npm test`, `npx tsc --noEmit`, `npm run build`, and `git diff --check`.

Expected: exit code 0 for each command. If a pre-existing unrelated test fails, report its exact test name and do not weaken the new assertions.

- [ ] **Step 5: Write redacted evidence and clean temporary files**

Save only aggregate metrics, test command results, source file hash, and timestamp to `docs/evidence/v13-years-experience-import-20260825.json`. Remove temporary previews and scripts; leave the original `.xls` untouched.

- [ ] **Step 6: Commit verification evidence**

```bash
git add docs/evidence/v13-years-experience-import-20260825.json
git commit -m "test: verify tolerant work years import"
```

## Completion checklist

- [ ] V13 migration is additive and idempotent.
- [ ] Raw text is retained through API, generic/Beisen import, attachments, UI, and export.
- [ ] No work-year format alone blocks a row; identity conflicts still block.
- [ ] No user-visible work-year `null`; no missing-value fallback to 0.
- [ ] Numeric sort/filter remains available for safe projections.
- [ ] Documentation and redacted evidence are updated.
