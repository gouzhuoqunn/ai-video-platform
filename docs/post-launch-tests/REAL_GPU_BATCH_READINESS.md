# Manual real GPU batch readiness

Date: 2026-07-21

Implemented safely:

- Immutable, oldest-first silent Wan / RTX 4090 membership frozen before lookup.
- Hard limits: `$0.70` effective hourly, `$4.50` session, `$1` reserve, 380-minute hard stop, 350-minute drain.
- Exact RTX 4090 read-only candidate route and cheapest compliant client selection.
- Existing one-time nonce, risk, exact confirmation text, queued-count, live provider revalidation, and active-order safeguards remain in the server path.
- Fake runtime test proves one model load, ordered per-task processing, failed-task continuation, and one unload.

Evidence:

- `npm run gpu:manual-batch:test` passed.
- `npm run typecheck` passed.
- `npm run build` passed (with pre-existing Turbopack dynamic-filesystem warnings).
- `npm run local-lab:test` is blocked by an unrelated stale urgent-generation source-text assertion.

Not performed: provider order creation/cancellation, SSH, model download/restore, GPU inference, output upload, remote cleanup, or synthetic paid prompt. The real worker transport still needs an explicitly authorized first-session proof before this can be marked paid-production ready.
