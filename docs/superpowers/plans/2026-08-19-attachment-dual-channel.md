# Attachment Dual-Channel Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-bounded PDF page-vision channel beside the existing deterministic text parser while preserving exact identity matching and human confirmation.

**Architecture:** PDF.js continues extracting searchable text in an isolated worker and additionally renders bounded PNG page buffers. A fixed OpenAI-compatible visual adapter receives those page images without tools, validates strict structured output, and returns candidates only. The attachment service verifies evidence, derives coordinates only from PDF text spans, merges without silently replacing deterministic values, exposes conflicts and fallback state, and clears image buffers after each attempt.

**Tech Stack:** Node.js 24, PDF.js, the existing optional `@napi-rs/canvas`, Express, SQLite, React, TypeScript, Node test runner.

**Spec:** The user-approved requirements in this task are authoritative. No production deployment, database migration, new external service, or real-resume fixture is permitted.

## Global Constraints

- Resume content is untrusted data and never changes prompts, tools, URLs, or execution.
- The read-only recruiting Agent receives no terminal, arbitrary file, installation, or write capability.
- Phone and email identity matching remains deterministic and exact; visual output never merges identity.
- Model output is allowlisted, schema-checked, evidence-checked, conflict-checked, and only written after confirmation.
- Page images, Base64, OCR corpus, and raw model responses are memory-only and absent from normal logs and persistence.
- Existing DOCX, spreadsheet, CSV, TXT, confirmation, idempotency, cancellation, expiry, and cleanup behavior remains compatible.

---

### Task 1: Synthetic regression coverage

**Files:**
- Create: `tests/backend/attachment-visual-parsing.test.mjs`
- Modify: `tests/backend/attachments-v6.test.mjs`
- Modify: `tests/backend/attachment-semantic-parsing.test.mjs`

- [x] Add anonymous single-column, two-column, table/timeline, scanned, and mixed PDF builders.
- [x] Add failing assertions for rendered PNG request parts, page classification, image limits, strict schema/no tools, invalid output, timeout, and safe fallback.
- [x] Add failing assertions for provenance, pages, verified evidence, conflicts, ambiguous contacts, current-role guards, canonical section ownership, replay/cancel/expiry cleanup, create/update paths, and prompt injection.
- [x] Run the focused tests and record the expected failures before implementation.

### Task 2: Bounded PDF rendering

**Files:**
- Modify: `server/attachment-parser.js`
- Modify: `server/attachment-parser-worker.js`

- [x] Add fixed limits for visual pages, dimensions, page/total pixels, encoded bytes, and render timeout under the existing worker memory and abort boundary.
- [x] Classify each PDF as text, scanned, or mixed from per-page text coverage.
- [x] Render pages sequentially to PNG buffers and return them as non-enumerable ephemeral data with page text spans.
- [x] Return an empty deterministic PDF record for a textless scan so visual failure can degrade to a confirmable attachment-only preview.
- [x] Clear rendered buffers after use and keep encrypted, damaged, and hard PDF limits terminal.

### Task 3: Fixed visual model adapter

**Files:**
- Create: `server/attachment-visual-parser.js`
- Modify: `server/app.js`
- Modify: `server/agent.js`

- [x] Read visual configuration from explicit attachment variables with approved Agent gateway fallbacks; require an opt-in capability declaration.
- [x] Send bounded `image_url` page parts and untrusted JSON context to `/chat/completions` with strict JSON Schema and no tools.
- [x] Validate the response again locally, return stable unavailable/timeout/http/invalid-schema codes, and never retain the raw response.
- [x] Expose non-sensitive capability and version status without exposing URL, credentials, images, or response bodies.

### Task 4: Verified merge and confirmation safety

**Files:**
- Modify: `server/attachments.js`
- Modify: `tests/backend/attachment-visual-parsing.test.mjs`

- [x] Add source, evidence references, page numbers, confidence, parser/prompt versions, and explicit conflict objects.
- [x] Keep deterministic values on disagreement, disable default selection, and never let visual phone/email drive identity.
- [x] Verify text-page evidence against page text; mark scan evidence visual-only; derive bounding boxes only from matched PDF text spans.
- [x] Reject unsupported fields/types, hallucinated evidence, historical-current role inference, malformed schema, duplicate IDs, and model-supplied coordinates.
- [x] Prefer canonical visual section boundaries only through visible conflict/default-selection rules; keep `self_summary` scalar-only.
- [x] Persist only confirmed fields/sections and existing attachment text; do not persist page images, OCR corpus, or raw response.

### Task 5: Preview UI

**Files:**
- Modify: `src/types.ts`
- Modify: `src/attachment-suggestion-display.ts`
- Modify: `src/components/AttachmentWorkflow.tsx`
- Modify: `src/components/AttachmentBatchWorkflow.tsx`
- Modify: `src/styles.css`
- Modify: `tests/backend/attachment-workflow-ui.test.mjs`
- Modify: `tests/backend/attachment-candidate-prefill.test.mjs`

- [x] Show parser version, text/scanned/mixed route, visual status, and non-blocking fallback warnings.
- [x] Show source, confidence, page, evidence, and conflicts consistently for fields and canonical sections.
- [x] Keep low-confidence, conflicting, and overwrite suggestions unchecked by default.
- [x] Verify controls remain visible and operable at desktop and 390px width without horizontal overflow.

### Task 6: Documentation and verification

**Files:**
- Modify: `docs/API.md`
- Modify: `docs/AGENT_SECURITY.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/ITERATION_LOG.md`

- [x] Document schemas, states, errors, merging, limits, privacy, capability configuration, fallback, monitoring, rollback, and support matrix.
- [x] Run focused tests, `npm test`, `npm run build`, and `npm audit`.
- [x] Start an isolated local service and upload the real sample without recording its contents or creating a real candidate; complete asynchronous preview, candidate-create prefill review, 390px inspection, batch cancellation, and database/temporary-file cleanup. Visual outbound requests were blocked by the non-loopback plaintext endpoint policy and returned `visual_endpoint_insecure`; deterministic text results were retained for confirmation.
- [x] Inspect desktop and narrow-screen preview, conflict and confirmation controls, cancel the preview, verify cleanup, and remove all temporary QA files with anonymous synthetic fixtures.
