# Stage 4J.1 RTX5090 acceptance result

Date: 2026-07-18

Batch: `stage4j1-final-5090-20260718`

Result: **blocked before GPU runtime readiness**. The batch was prepared through the normal local application APIs with two RTX5090 image jobs and one 10-second long-video project consisting of two 81-frame segments. The historical deployment pause was resolved with an exact batch-bound operator record; provider holds remained enabled.

One and only one real Clore create attempt was made. The selected candidate was RTX5090 server `85138`, On-Demand, at or below `$0.65/hour`, with a `$3.00` hard budget and a 300-minute watchdog. Clore returned a created order, but the remote workspace contract could not authenticate at `root@n1.de.clorecloud.net`; the error was `Permission denied (publickey,password)`. No SSH-ready session, runtime bootstrap, model restore, image inference, video inference, media merge, or output publication occurred. The same order was canceled by the guarded cleanup path.

Post-cleanup checks confirmed Clore active orders `0`, RunPod Pods/volumes `0/0`, provider holds enabled, watchdog disarmed, no create lock, and no active execution process. The prepared tasks and project remain available for a future manual handoff. No second order is authorized by this result.

Evidence (ignored local state): `.secrets/stage4j1-batch.json`, `.secrets/stage4j1-session-failure.json`, `.secrets/stage4j1-session.log`, and the final billing-status output. The failure is also recorded in the session failure file with timestamp `2026-07-18T14:50:00.182Z`.

Manual handoff required: verify the exact returned Clore endpoint's password/key parity and project-scoped SSH credentials for the next fresh authorization. Do not reuse this authorization or create another order automatically.

## Stage 4J.2 forensic diagnosis and final retry readiness

Stage 4J.2 was strictly non-billable. It created no Clore/RunPod resource, opened no real SSH session, restored no model, ran no inference, and changed no prepared prompt or task specification.

Exact classification: `ssh_public_key_rejected_at_workspace_contract_prepare`. The failed command phase was the first workspace-contract SSH execution as `root` against the exact provider-returned endpoint. It returned `Permission denied (publickey,password)`. This is not a TCP, host-key, Runtime, model, or inference failure. The evidence cannot distinguish provider non-injection from a then-unproven local order/transport key mismatch, because Stage 4J.1 did not persist the order-key fingerprint and did not enforce one canonical identity.

Historical RTX4090 success and failed RTX5090 payloads were structurally the same key-only profile: non-empty `ssh_key`, official Clore Jupyter image, SSH-only port, `required_price`, and `autossh_entrypoint=true`; neither contained `ssh_password`, env, or a project startup command. Both used `root` and exact returned endpoints. The material transport difference was global known_hosts on the older successful path versus order-scoped known-hosts on Stage 4J.1. Both lacked `IdentitiesOnly=yes`.

Canonical identity evidence:

- Algorithm: `ssh-ed25519`
- Fingerprint: `SHA256:DxIZMV2kAajL8dJqG8fxId+sYI+54SE2Un1+aIy+MZc`
- Private-key identifier: `clore_ai_video_worker_ed25519`
- Public-key source: `derived_from_private_key`
- Public/private fingerprint match: `true`

Future create validates the literal normalized public key and fingerprint again immediately before `create_order`, while logs expose only the algorithm/fingerprint/boolean summary. Readiness, SCP, workspace, Runtime, and cleanup share the same identity and order-scoped known-hosts, enforce `IdentitiesOnly=yes`, disable the SSH agent, use BatchMode for key probes, use bounded timeouts, and allocate no TTY.

The next order's password fallback is prepared but not authorized or used. Its one-use password is generated only at future create time, stored in ignored order state, included explicitly in that order payload, attempted once only after bounded key-injection retries, used to repair the canonical key if needed, and deleted after cleanup. Runtime may continue only after key-only login succeeds.

Final dry-run flags:

- `final_5090_plan_ready=true`
- `prepared_batch_reused=true`
- `duplicate_jobs_created=0`
- `canonical_ssh_identity_ready=true`
- `order_ssh_key_present=true`
- `public_private_fingerprint_match=true`
- `all_ssh_components_share_identity=true`
- `order_password_fallback_prepared=true`
- `global_known_hosts_used=false`
- `expected_provider_orders=1`
- `paid_execution_authorized=false`
- `provider_mutations=0`

The prepared batch is unchanged: one `1536x1024` image, one derived `2048x2048` image, one 10-second long-video project, two five-second prompts, and no short-video job. One final paid RTX5090 retry is credential-contract ready, but it is not currently authorized; it still requires a fresh user decision and one-use authorization.

Validation passed: Stage 4J.2 credential fixtures, final retry plan, Stage 3R readiness, Clore execution fixtures, Stage 4H.6 SSH/adapter checks, Stage 4H.5 resume preservation, TypeScript, targeted lint, secret scan, and the Next production build. Full-repository lint remains blocked by pre-existing errors in unrelated Stage 3X/4J.1/UI files; no new error was reported in the Stage 4J.2 changed-file lint.
