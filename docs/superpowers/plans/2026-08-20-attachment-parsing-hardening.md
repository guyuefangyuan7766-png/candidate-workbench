# Resume Attachment Parsing Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PDF, DOCX, XLSX, CSV, and TXT attachment previews produce bounded, auditable structured results with truthful per-channel status and safe human confirmation.

**Architecture:** Keep deterministic parsing authoritative for identity, add geometry-aware PDF text ordering, make text and image model adapters share explicit strict/compat local validation, and expose each channel independently through the API and UI. Image OCR remains an opt-in suggestion channel using transient Worker-rendered PNG pages.

**Tech Stack:** Node.js 24, PDF.js, optional existing `@napi-rs/canvas`, Express, SQLite, React 19, TypeScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-20-attachment-parsing-hardening-design.md`

## Global Constraints

- Do not add dependencies, services, system binaries, database migrations, commits, pushes, or deployments.
- Do not read or print secrets, gateway URLs, real resume text, page images, screenshots, HAR data, or raw model responses.
- Preserve deterministic phone/email identity and the existing confirmation boundary.
- Compatibility mode is explicit only, sends no tools, receives local strict validation, and is never labeled strict.
- Images and transient text are cleared on success, failure, cancellation, timeout, and expiry.
- Every production behavior change starts with a failing anonymous test.

---

### Task 1: Geometry-aware and bounded PDF parsing

**Files:**
- Modify: `server/attachment-parser-worker.js`
- Modify: `server/attachment-parser.js`
- Modify: `tests/backend/attachment-visual-parsing.test.mjs`
- Modify: `tests/backend/attachment-visual-hardening.test.mjs`

**Interfaces:**
- Produces: `metadata.pdf_content_type`, ordered `text`, bounded `visual_pages`, and stable `pdf_empty` / `pdf_visual_*` failures.
- Consumes: existing `DEFAULT_ATTACHMENT_LIMITS` and worker abort boundary.

- [ ] Add literal anonymous tests whose PDF content-stream order disagrees with visual two-column order and whose table/timeline/icon labels require geometry grouping.
- [ ] Run the focused tests and verify the new assertions fail because extraction is content-stream ordered.
- [ ] Add tests for zero-page PDFs, visual deadline checkpoints, text-budget exhaustion, scanned PDFs, and mixed PDFs; verify each new behavior is red for the intended reason.
- [ ] Implement normalized span line/column ordering, explicit zero-page failure, remaining-text budgeting, and deadline checks around every expensive PDF stage.
- [ ] Run `node --test --test-concurrency=1 tests/backend/attachment-visual-parsing.test.mjs tests/backend/attachment-visual-hardening.test.mjs` and keep the existing PNG limits and cleanup tests green.

### Task 2: Strict and explicit compatibility gateway contract

**Files:**
- Modify: `server/agent.js`
- Modify: `server/attachment-visual-parser.js`
- Create: `server/attachment-model-contract.js`
- Modify: `tests/backend/agent-attachment-suggestions-v6.test.mjs`
- Modify: `tests/backend/attachment-visual-parsing.test.mjs`
- Modify: `tests/backend/attachment-visual-hardening.test.mjs`

**Interfaces:**
- Produces: locally validated suggestion records and `{ status, schema_mode, error_code, retryable }` failures.
- Consumes: explicit `ATTACHMENT_TEXT_SCHEMA_MODE` / `ATTACHMENT_VISUAL_SCHEMA_MODE`, caller `AbortSignal`, and bounded provider responses.

- [ ] Add tests proving strict is the default, compat must be explicitly configured, compat sends `strict:false`, neither mode sends tools, and status never labels compat as strict.
- [ ] Add tests for exact PNG `image_url` request parts and for unsafe/unknown image capability failing before fetch.
- [ ] Add tests for caller abort, timeout, HTTP failure, oversized response, invalid outer JSON, invalid inner JSON, unknown fields, duplicate records/fields, invalid values/evidence/pages, and current-role evidence.
- [ ] Run the focused gateway tests and verify the failures identify missing compat, abort, byte-limit, or validator behavior rather than fixture errors.
- [ ] Implement one shared strict local schema/allowlist validator and bounded response reader; wire it into both adapters with stable error normalization.
- [ ] Run `node --test --test-concurrency=1 tests/backend/agent-attachment-suggestions-v6.test.mjs tests/backend/attachment-visual-parsing.test.mjs tests/backend/attachment-visual-hardening.test.mjs`.

### Task 3: Truthful pipeline state and safe merge

**Files:**
- Modify: `server/attachments.js`
- Modify: `src/types.ts`
- Modify: `tests/backend/attachment-semantic-parsing.test.mjs`
- Modify: `tests/backend/attachment-visual-lifecycle.test.mjs`
- Modify: `tests/backend/attachments-v6.test.mjs`

**Interfaces:**
- Produces: preview `pipeline.text`, `pipeline.text_model`, `pipeline.visual`, overall quality state, scalar-only `self_summary`, and stable retryability.
- Consumes: normalized text/visual adapter outcomes and ephemeral visual pages.

- [ ] Add tests showing text-model timeout/HTTP/JSON/schema errors survive in `pipeline.text_model` while deterministic output remains available.
- [ ] Add tests showing scanned-without-visual is degraded/review-required, mixed routing is explicit, and visual success is impossible without a completed image result.
- [ ] Add tests for deterministic contact precedence, multiple-contact/cross-identity blocking, historical/current-role separation, canonical education/work/internship/project/publication/skill/campus ownership, unverified/conflicting default selection, and scalar-only `self_summary`.
- [ ] Add lifecycle tests for abort, expiry, duplicate request, confirmation idempotency, and transient page/quarantine cleanup.
- [ ] Run the focused tests and verify the expected channel/merge assertions fail.
- [ ] Implement independent channel outcomes, overall quality derivation, stable error propagation, merge guards, and removal of preview `self_summary` sections.
- [ ] Run `node --test --test-concurrency=1 tests/backend/attachment-semantic-parsing.test.mjs tests/backend/attachment-visual-lifecycle.test.mjs tests/backend/attachments-v6.test.mjs`.

### Task 4: Single and batch UI state

**Files:**
- Modify: `src/components/AttachmentWorkflow.tsx`
- Modify: `src/components/AttachmentBatchWorkflow.tsx`
- Modify: `src/attachment-suggestion-display.ts`
- Modify: `src/styles.css`
- Modify: `tests/backend/attachment-workflow-ui.test.mjs`

**Interfaces:**
- Consumes: the expanded `AttachmentParserPipeline` contract.
- Produces: separate deterministic/text-model/visual status and safe selection behavior at desktop and narrow widths.

- [ ] Add UI contract tests for text-model status/error/retryability/schema mode, scanned degradation, visual fallback, source/page/evidence/conflict rendering, and stable single-file error codes.
- [ ] Add tests proving `evidence_status: unverified` is never preselected in either workflow even when `default_selected` is true.
- [ ] Run the UI tests and verify the new assertions fail against the old channel display and selection filters.
- [ ] Implement shared display helpers, independent channel badges, failure/degradation copy, and the client-side unverified-evidence selection guard.
- [ ] Run `node --test --test-concurrency=1 tests/backend/attachment-workflow-ui.test.mjs` and `npm run build`.

### Task 5: Regression, documentation, and isolated acceptance

**Files:**
- Modify: `.env.example`
- Modify: `docs/API.md`
- Modify: `docs/AGENT_SECURITY.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/ITERATION_LOG.md`

**Interfaces:**
- Documents: exact environment modes, channel states, errors, resource limits, privacy, cleanup, rollback, and acceptance evidence.

- [ ] Add or retain anonymous DOCX, XLSX, CSV, and TXT parsing/confirmation regression assertions; run them before documentation claims.
- [ ] Document strict versus explicit compat semantics, image endpoint requirements, local validation, channel state/error contracts, OCR limitation, and operator recovery.
- [ ] Run the complete focused attachment matrix, `npm test`, `npm run build`, `node --check` for every changed server JavaScript file, and `git diff --check`.
- [ ] Start an isolated service with a temporary SQLite database, loopback port, and temporary attachment root; exercise synthetic upload/poll/confirm-idempotency/cancel/expiry/cleanup.
- [ ] Inspect desktop and 390px layouts in the browser. Use a real local PDF only for upload and preview without confirmation or retained artifacts.
- [ ] Stop the service, delete the exact isolated database/quarantine/output paths, verify the port is released, and record whether text and visual model requests actually ran.

