# Real Wan manual-run gate

The manual RTX 4090 route is fail-closed unless local mode, verified batch RPC, immutable Worker transport, a running local session runner, and the explicit Clore mutation switch all pass.

Current blocker: the Supabase CLI returns `LegacyPlatformAuthRequiredError`; no migration was applied and the remote Worker-role probe was not run. Run `npx supabase login`, then `npx supabase link --project-ref <derived-local-ref>` and deploy/verify migrations before setting the verification flag.
