# Real Clore Execution Chain

Status: implemented as guarded code and mock-tested only. It is disabled by default with `CLORE_ORDER_EXECUTION_ENABLED=false`.

This checkpoint did not call real Clore `create_order`, did not create or cancel an order, did not spend balance, did not open SSH, did not download Wan2.2, and did not deploy publicly.

## Flow

The intended real chain is:

1. local_lab web confirmation with nonce, exact text, risk checkbox, queued-job check, and loopback guard.
2. Server-side live Clore recheck for the selected RTX 5090, on-demand status, rentability, normalized price, wallet reserve, SSH public key, Docker image, and active-order state.
3. Guarded `create_order` body generation with SSH-only port 22/tcp, project tag, no secrets, no public inference ports, and on-demand type only.
4. Guarded `create_order` call only when `CLORE_ORDER_EXECUTION_ENABLED=true`.
5. Active order state written to `.secrets/clore-active-order.json`.
6. Boot/deploy/model/worker/session steps remain represented by dry-run plans until a future real SSH task.
7. Guarded `cancel_order` call only after no processing job, no upload in progress, final video verified, active project order matched, and `CLORE_ORDER_EXECUTION_ENABLED=true`.

## Safety Defaults

- `clore:create:dry` never accepts `--execute`.
- `clore:create` requires `--execute`, `--server-id`, `--max-price`, and `--confirm-project=ai-video-platform-wan22`.
- `clore:cancel` defaults to dry-run and requires an active project order for real cancel.
- A local create lock at `.secrets/clore-order-create.lock` prevents duplicate create calls.
- The active order file and lock file are ignored by Git and contain no secrets.
- Only SSH port 22/tcp is allowed in the order body.
- The GPU server must never receive `CLORE_API_KEY`, Supabase Secret keys, `.env.local`, R2 write credentials, SSH private keys, signed URLs, or local sessions.

## Commands

Dry-run and tests:

```powershell
npm run clore:create:dry
npm run clore:cancel:dry
npm run clore:execution:test
npm run clore:ssh:test
npm run first-gpu-session:test
npm run check:first-gpu-session
```

Future real create shape, still blocked unless the environment flag is explicitly changed in a future approved task:

```powershell
npm run clore:create -- --execute --server-id=<server_id> --max-price=<price> --queued-jobs=<count> --confirm-project=ai-video-platform-wan22
```

Future real cancel shape:

```powershell
npm run clore:cancel -- --execute --order-id=<order_id> --processing-jobs=0 --uploading=false --final-video-uploaded=true
```

## Verification

Current tests cover:

- execution flag false blocks create before request;
- preflight rejects spot/noncompliant candidates;
- no queued job blocks create;
- order body is on-demand, SSH-only, and secret-free;
- mock create writes active project order state;
- duplicate active order is blocked;
- cancel while processing is blocked;
- mock cancel clears active project order state;
- SSH args keep host key checking and disable password auth;
- deployment upload whitelist excludes `.env.local`, `.secrets/clore.env`, private keys, videos, and Supabase Secret keys.

## 2026-07-12 Additional First-Session Gate

Real create remains blocked unless the model cache seed gate is healthy:

```powershell
npm run model-cache:seed:test
npm run check:first-gpu-session
```

The seed gate proves that the local controller can sign short-lived R2 upload permissions without exposing `.secrets/model-cache-admin.env`, and that the GPU-side readonly credential cannot put, overwrite, or delete. The test only uses tiny `_seed-test` objects and cleans them. It does not call `create_order`, `cancel_order`, SSH, or model download code.

## 2026-07-12 Real Create Compatibility Notes

The first real order attempt exposed Clore API requirements that are now encoded in code:

- `currency` must be the wallet/marketplace key `USD-Blockchain`, not plain `USD`.
- `required_price` must use Clore's raw on-demand USD/day value, while local budget gates continue to use normalized USD/hour.
- `autossh_entrypoint` must be enabled so Clore prepares SSH access.
- Failure cleanup can call real `cancel_order` before a final video exists when the issue is a pre-inference infrastructure failure such as `ssh_unavailable`.

The first real order for server `107713` was created and then canceled because SSH never became available within the 30-minute window. No model was downloaded and no video was generated.

## 2026-07-13 Watchdog Gate

Real create now requires two independent watchdog layers before any `create_order` call:

1. Remote Cloudflare Worker watchdog armed in the private R2 bucket `ai-video-platform-clore-watchdog-state`.
2. Local Windows scheduled task `AiVideoPlatformCloreWatchdog` with a fresh healthy heartbeat.

The remote watchdog must be armed before create with:

```powershell
npm run clore:watchdog:local:install
npm run clore:watchdog:remote:arm -- --server-id=<server_id>
```

The real create path checks both watchdogs and fails closed if either one is missing, stale, unarmed, or armed for a different server.

The only allowed rental currency is now `USD-Blockchain`. Ambiguous `USD` is rejected before order body submission.

The remote watchdog cancels only when it is armed and can uniquely identify the active order for the armed server. It does not cancel when unarmed, when multiple active orders exist, when the server id differs, or when the API is temporarily unavailable.

Current deployment caveat: Worker script upload and encrypted secret setup succeeded, but Cloudflare Cron schedule deployment returned 403. Real create must remain blocked until the Cron trigger is successfully deployed and remote heartbeat is verified.
