# Real Wan GPU Worker transport

The safe transport boundary is: persisted batch intent -> local runner -> Clore order adapter -> SSH/bootstrap -> restricted immutable Worker -> batch-scoped result RPCs. Browser code never receives provider or Worker credentials and does not call a mutation adapter.

This checkpoint does not claim a completed paid transport: remote Supabase RPC deployment/verification, reusable Stage3O transport extraction, and live SSH/runtime/result acceptance are still required before a paid run.
