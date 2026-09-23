# Attachment Dual-Channel Parsing Progress

## Status

Implementation, documentation, anonymous verification, and the isolated browser acceptance are complete. The configured production endpoint was non-loopback plaintext HTTP and the visual capability was not declared, so no real outbound request was sent; an anonymous loopback substitute was used to exercise the request protocol and visual UI states.

## Completed

- Bounded, opt-in PDF image parsing is implemented beside deterministic text parsing.
- Visual output remains evidence-checked, cannot establish phone/email identity, and conflicts require explicit human selection.
- Rendered PNG pages, data URLs, page text arrays, and raw visual responses remain transient and are cleared after success, failure, cancellation, or timeout.
- Endpoint validation rejects unsafe schemes, private and metadata targets, mapped or tunnel IPv6 forms, and unsafe DNS answers before image upload; the low-level request pins the connection to the verified DNS address, with deployment egress policy retained as independent defense in depth.
- The worker applies a shared 30-second whole-document sequential page-render budget, with an 8-second per-page cap.
- Fresh 2026-08-20 counts and browser evidence are recorded in `docs/TESTING.md`: attachment专项 `179/179`, full suite `485` (`484` pass, `0` fail, `1` skip). The current pass still uses only synthetic files, isolated SQLite, temporary directories, and a local substitute gateway.
- Isolated browser acceptance completed upload, asynchronous preview, candidate-create prefill review, 390px layout, batch cancellation, and database/temporary-file cleanup checks without confirming a formal candidate or retaining sample content.

## Remaining Follow-up

- No feature follow-up remains. A future production visual-enabled acceptance requires an approved HTTPS or explicit loopback endpoint and a declared `image_input` capability; the real endpoint remains intentionally uncalled.
