# Real Wan manual-run gate

The manual RTX 4090 route is fail-closed unless local mode, verified batch RPC, immutable Worker transport, a running local session runner, and the explicit Clore mutation switch all pass.

Database evidence: Supabase CLI project link and migrations `0001` through `0013` were deployed on 2026-07-21. A synthetic batch verified claim isolation, progress, idempotent completion and authenticated-user denial; all fixture rows were cleaned up. The remaining gate is real Wan host/bootstrap/result transport acceptance, not database linkage.
