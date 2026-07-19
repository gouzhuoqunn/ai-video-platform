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
# Stage 4J.3 paid RTX5090 acceptance result

Date: 2026-07-19 local / 2026-07-18 UTC

Result: **partial acceptance; daily-use closure not complete**.

- Billing mojibake was fixed to literal UTF-8 `资费情况` in the visible button, panel heading, and accessibility labels. The three launcher filenames are genuine Chinese names.
- The prepared batch was reused with duplicate jobs `0`: two RTX5090 images, one two-segment 10-second long-video project, two five-second prompts, and no short-video task.
- Exactly one Clore order was created: `1962381`, server `85138`, On-Demand RTX5090, exact endpoint `root@n1.de.clorecloud.net:1439`, base `$0.31125/hour`. Wallet moved `$11.24 -> $10.72`; delta `$0.52`.
- Canonical key-only SSH succeeded on its first attempt. The one-use password was not used. Order-scoped known-hosts and one-use password state were removed during cleanup.
- Blackwell passed with capability `12.0`, about 32GB VRAM, Torch `2.7.1+cu128`, CUDA `12.8`, Triton `3.3.1`, `sm_120`, real CUDA/Triton operations, required UltraReal/Wan nodes, ComfyUI/controller, ffmpeg/ffprobe, RAM, and disk.
- UltraReal restored once. The native 1536x1024 medium image SHA is `c79c99476486fdcd83dbdc0cb7e90e2961ebdda85fe556a1c1a10be2558e6078`. The high image used a 1536x1536 base plus deterministic Lanczos finalization to 2048x2048; final SHA is `d3b12a75c5b30086f2dec902d4d9e7e38f8418a8436c64cbca97d765623b32ac`.
- Image models were unloaded and CUDA cache cleared before Wan. Wan restored once.
- Segment 0 ran exactly once. Its rescued source WebM SHA is `ae8b6431b80145ddb6738e8a7ed2608a1c3d1d24889ea58f5518edc129dd6867`. The preserved MP4 is 1280x720, 81 frames, 16fps, 5.0625 seconds, SHA `4d72d09d12f2bf7a40e6ab49f29cc963e002bcab3d3ec2046126aef2307758d9`; last-frame SHA is `6260f7149b352bb4f337d8ce9a63f16f169e28c61e11052590e653e342cfb77a`.
- The completed remote runner left its long SSH channel open. After the remote output was SHA-verified and rescued, the stuck local SSH process was ended; the coordinator received empty JSON, classified `video_remote_runner_failed:invalid_runner_json`, and did not submit segment 1. Segment 1 attempts remain `0`.
- The only order was canceled at `2026-07-18T18:38:33.633Z`. No second order was created. The runner now uses detached single submission plus atomic short-poll result retrieval, covered by an offline focused test.
- There is no segment-1 result, tail-frame chain, 10-second 720P master, 1080P final, or final-video browser result. Browser checks instead truthfully validated both images and rescued segment 0: Range `206`, seeking, refresh persistence, right sidebar, no hydration errors, and no provider mutation.
- `启动平台.cmd` Restart was exercised once with zero active authorizations before and after.
- Two final provider reads confirmed Clore orders `0`, RunPod Pods/volumes `0/0`, both holds `true`, no watchdog/watcher/create lock, no active authorization, and no order-scoped credential state. Focused tests, secret scan, TypeScript, and the Next build passed; broad lint, historical CI, RTX4090/short-video/RunPod tests, R2 publication, and commercial-release tests were skipped by scope.
- Final flags: `rtx4090_profile_preserved=true`, `rtx5090_profile_implemented=true`, `rtx5090_gpu_verified=true`, `rtx5090_image_medium_verified=true`, `rtx5090_image_high_final_verified=true`, `windows_launcher_verified=true`, `rtx5090_long_video_720p_verified=false`, `rtx5090_long_video_1080p_final_verified=false`, `long_video_tail_frame_chain_verified=false`, `daily_use_ready=false`, `project_closed_for_personal_use=false`, `production_ready=false`.
- `MANUAL_HANDOFF_REQUIRED`: no Blackwell repair handoff is required. Completion handoff is required because the current paid authorization is consumed; only a future explicit authorization may resume segment 1 with the fixed detached return path. It must not regenerate segment 0 or create an order automatically.

## Stage 4J.4 zero-cost correction and exact resume boundary

Date: 2026-07-19

Result: **non-billable layout/runner correction complete; one paid segment remains**.

- No provider mutation, paid authorization, real SSH, model restore, inference, image regeneration, segment-0 regeneration, or accepted-media change occurred.
- Read-only wallet verification remained `$10.72` before and after Stage 4J.4; Stage 4J.4 wallet delta was `$0.00`.
- The permanent sidebar failure was caused by the billing and long-video branches replacing the entire two-column workspace. A single shared shell now keeps a 320px independently scrolling sidebar mounted in every mode and billing/detail state.
- The preview changed from an unconstrained 16:9 block to one 42vh, maximum-480px `object-contain` frame. The gallery changed from about three desktop columns to 8 columns at 1366px and wider, 6 at 1100px, 4 at 800px, then 2/1.
- Short- and long-video creation editors remain distinct, but both task families now share one video history and preview. Selecting a long project exposes its accepted segment strip.
- The exact Stage 4J.3 cause was descriptor inheritance by a remote descendant of the original blocking SSH command. Inference completed, but the SSH output pipe never reached EOF; local timeout termination produced an empty JSON classification.
- The fixed contract separates launch, status sentinel, result fetch, stop, and cleanup. It records the real PID/job UUID, atomically publishes JSON/exit/terminal files, redirects all descriptors, preserves nonzero exit codes, distinguishes timeout from empty status, and resumes a completed deterministic attempt after local result-read interruption without resubmission.
- Accepted image hashes remain `c79c99476486fdcd83dbdc0cb7e90e2961ebdda85fe556a1c1a10be2558e6078` and `d3b12a75c5b30086f2dec902d4d9e7e38f8418a8436c64cbca97d765623b32ac`.
- Accepted segment-0 MP4 SHA remains `4d72d09d12f2bf7a40e6ab49f29cc963e002bcab3d3ec2046126aef2307758d9`; last-frame SHA remains `6260f7149b352bb4f337d8ce9a63f16f169e28c61e11052590e653e342cfb77a`. Segment 1 attempts remain `0`.
- `FINAL_VIDEO_RESUME_PLAN.md` is plan-only: zero image jobs, no UltraReal, one Wan restore, one segment-1 inference, immediate cancel, local 720P merge and 1080P derivation. It proposes 120 minutes, draining at 105, expected `$0.35–$0.80`, hard wallet-delta cap `$1.25`, and `paid_execution_authorized=false`.
- Browser acceptance passed at 1366x768 and 1920x1080 with sidebar width 320px, preview heights about 323px/454px, eight columns, no horizontal overflow, `资费情况`, segment strip, no hydration error, and no automatic provider action.
- Daily-use closure remains incomplete only because segment 1, the tail-frame chain, 720P master, and 1080P final do not yet exist. `production_ready=false`.

## Stage 4J.6 failure classification and Stage 4J.7 non-billable recovery

Date: 2026-07-19

Stage 4J.6 created one successful RTX 5090 order after resilient create handling, passed SSH, Blackwell, and Runtime readiness, and started one Wan restore. It submitted no inference. The restore moved 4,336,910,336 of 35,572,266,487 bytes in 770 seconds at an observed 5,632,351 bytes/second. There was no restore error before bounded cancellation. The exact classification is `restore_throughput_incompatible_with_previous_session_deadline`, not a Wan, Blackwell, R2-integrity, SSH, or Runtime failure.

Stage 4J.7 was strictly non-billable: no authorization, provider create/cancel, hold release, real SSH, model download, or inference occurred. It added an actual-model-source Range probe, throughput-aware candidate ranking, per-large-object parallel ranged restore with resumable chunks and full integrity publication, and a dynamic completion/spend gate.

The accepted image hashes remain `c79c99476486fdcd83dbdc0cb7e90e2961ebdda85fe556a1c1a10be2558e6078` and `d3b12a75c5b30086f2dec902d4d9e7e38f8418a8436c64cbca97d765623b32ac`. Accepted segment-0 MP4 remains `4d72d09d12f2bf7a40e6ab49f29cc963e002bcab3d3ec2046126aef2307758d9`; its last frame remains `6260f7149b352bb4f337d8ce9a63f16f169e28c61e11052590e653e342cfb77a`. Segment 0 has one attempt and segment 1 has zero attempts.

The future proposal is RTX 5090 On-Demand, `$0.65/hour` maximum, one active order, one production order, at most two pre-restore qualification orders, at most two sequential orders, combined wallet delta at most `$1.25`, 240-minute wall cap, and draining at 220 minutes. A second candidate is permitted only if the first actual-source probe fails before restore; no replacement is allowed after restore or inference. `paid_execution_authorized=false`, `provider_mutations=0`, `daily_use_ready=false`, and `production_ready=false`.
