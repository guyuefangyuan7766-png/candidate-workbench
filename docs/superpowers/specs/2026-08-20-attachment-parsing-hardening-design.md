# Resume Attachment Parsing Hardening Design

## Scope

This change hardens the existing attachment dual-channel pipeline. It does not add a new provider, dependency, system binary, database migration, automatic candidate merge rule, or automatic model write path. Real resumes remain local manual-acceptance inputs and must not enter source control, test fixtures, logs, screenshots, HAR files, or documentation.

## Verified Failure Boundaries

1. PDF text extraction follows PDF content-stream order. Anonymous two-column PDFs prove that this order can differ from visual reading order, so deterministic section parsing can mix columns and timeline labels.
2. PDF image rendering only runs when the visual capability is explicitly enabled. With the current capability disabled, scanned PDFs have no OCR source and can reach a ready preview with empty deterministic content.
3. The worker's visual deadline is checked only when rendering begins. `getPage`, `getTextContent`, canvas loading, and PNG encoding can consume time outside the advertised visual budget. A zero-page PDF is also misclassified as text because `every()` is true for an empty array.
4. Text suggestions hard-code strict structured output, do shallow local validation, read an unbounded JSON response, and do not propagate the attachment-stage abort signal. `attachments.js` catches this entire channel and discards its error state.
5. The visual adapter sends actual in-memory PNG data URLs and validates its output, but also hard-codes strict mode. There is no explicit, observable compatibility mode for gateways that lack strict structured outputs.
6. The UI displays the visual channel but not an independent text-model channel. It trusts `default_selected` even for unverified evidence, and its single-file error-code copy is behind the server contract.
7. `self_summary` can appear as both a scalar suggestion and a preview section even though persistence already treats it as scalar-only.

## Architecture

### Deterministic PDF channel

PDF.js remains inside the existing worker boundary. Per-page text items are converted to normalized spans, grouped into visual lines by Y tolerance, and ordered by detected column bands before being joined. The original bounded spans remain available for evidence lookup. Geometry ordering is deterministic and conservative: when column separation is not stable, it falls back to line order rather than inventing semantic relationships.

PDF routing is explicit:

- `text`: every non-empty page has a usable text layer.
- `scanned`: pages exist and none has usable text.
- `mixed`: text and textless pages coexist.
- zero pages: terminal `pdf_empty` failure, never `text`.

The worker enforces the existing page, pixel, PNG-byte, aggregate-memory, per-page timeout, total visual timeout, worker timeout, and extracted-text limits. Deadline checks surround page acquisition, text extraction, renderer loading, rendering, and PNG encoding. Once the text budget is exhausted, later page text is not retained; page classification and bounded visual processing continue without creating another full-size string.

### Model gateway contract

Text and visual channels share the same policy shape:

- Default mode is `strict`; the outbound JSON Schema has `strict: true`.
- Compatibility mode is enabled only by an explicit attachment-specific environment value. It sends the same schema with `strict: false`, never sends tools, and reports `schema_mode: compat`, never `strict`.
- There is no automatic retry from strict to compat and no capability guessing.
- Both modes locally parse a bounded response and enforce an exact field allowlist, record/field uniqueness, value limits, section types, evidence, page ranges, confidence values, and current-role evidence rules.
- The caller's abort signal is combined with a bounded request timeout.
- Network, timeout, HTTP, response-size, outer/inner JSON, and schema failures return stable codes plus `retryable` without exposing endpoint, credential, request content, or raw response.

Image input remains the existing OpenAI-compatible `image_url` data-URL request containing Worker-produced PNG bytes. An unsafe, unknown, disabled, or incompatible image endpoint fails before sending with an explicit visual error code. No response may claim visual success without a completed image request and locally valid result.

### Pipeline state and merge

Every preview exposes three independent channels:

- deterministic text extraction (`text`), including `content_type` and parser status;
- text-model suggestions (`text_model`), including `status`, `schema_mode`, `error_code`, and `retryable`;
- page-image suggestions (`visual`), including the same model status fields and whether fallback was used.

The overall preview distinguishes a usable structured result from a degraded or review-required result. A scanned PDF with no successful visual/OCR output is explicitly degraded and cannot be described as successfully structured. A text-model failure does not erase deterministic output; a visual failure does not claim model success.

Phone and email remain deterministic. Multiple phones, multiple emails, cross-candidate identity conflicts, or ambiguous matches block automatic matching. Names, employers, schools, and job titles never identify or merge candidates. Model output is suggestion-only and enters storage only through the existing confirmation endpoint.

Canonical sections keep channel source, page, evidence, confidence, evidence status, and conflict metadata. Unverified, low-confidence, conflicting, or overwriting suggestions default to unchecked. Historical roles cannot populate current company/title without explicit current-role evidence. `self_summary` exists only as a scalar suggestion.

### UI

Single and batch workflows show deterministic, text-model, and visual channel states separately. They display stable error code, retryability, schema mode, degraded/review-required status, source, page, evidence, confidence, and conflicts. The client independently refuses to preselect unverified evidence even if a malformed or older server response sets `default_selected: true`.

## Verification

All automated fixtures use fictitious data. Coverage includes single column, two column, table/timeline/icon labels, scanned and mixed PDFs, OCR spacing and glued labels, canonical section ownership, current/history roles, identity conflicts, strict and explicit compat schemas, exact image request shape, timeout/unavailable/invalid JSON/invalid schema, deterministic fallback, cancellation/expiry/replay/idempotency/cleanup, UI states, and DOCX/XLSX/CSV/TXT regressions.

Local acceptance uses an isolated SQLite file, loopback port, and temporary quarantine directory. Real samples may be uploaded and inspected locally without confirmation; all temporary database and attachment/image artifacts are deleted afterward. The visual request is only considered exercised when a compliant HTTPS or loopback image gateway is available.

