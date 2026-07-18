# 当前基线

- 分支：`codex/stage4g1-long-video-prompts`；Stage 4I 开始时 HEAD：`34262c7a963c3f9831c0ccfed2080b614a9f513a`。
- 历史长视频项目：`8fff4d9f-39f6-4aee-a02a-d0a6376e4f8b`，状态 failed/retryable，`nextSegmentIndex=1`。
- segment 0 已接受并保留；PNG 尾帧 SHA-256：`d5d2bccdfa9839e6f420920d6f0ec64482dd1021004c60ad97610e76f3100f77`。segment 1/2 没有尝试，禁止重新生成 segment 0。
- 已验证 RTX 4090：UltraReal image 1024×1024；Wan Remix video 832×480、33 帧、16fps。运行时 Torch 2.6.0+cu124、Triton 3.2.0、CUDA 12.4。
- 当前模型 revision：`civitai-1413133-file-1320644`、`civitai-2770795-2771407-v3`。
- 零状态预期：Clore active orders=0；RunPod Pods/Volumes=0/0；provider holds=true；无 watcher/watchdog/create lock；无活动授权。
# Stage 4J.1 checkpoint (2026-07-18)

- The final RTX5090 batch was prepared but did not complete paid acceptance. It contains two image jobs (`1536x1024` and derived `2048x2048`) and one 10-second project with two `81`-frame segments at `1280x720` generation and `1920x1080` finalization metadata.
- Exactly one real Clore create attempt was made on RTX5090 server `85138` under the `$3.00`/300-minute guard. Workspace SSH authentication failed (`Permission denied (publickey,password)`), so the guarded path canceled the same order before runtime/bootstrap/model restore. No media was generated.
- Final resource state is Clore orders `0`, RunPod Pods/volumes `0/0`, provider holds enabled, watchdog disarmed, and no create lock. The prepared batch remains for manual handoff; `production_ready=false`, `long_video_pipeline_gpu_verified=false`, and `normal_ui_pipeline_gpu_verified=false` remain unchanged.

# Stage 4J.2 checkpoint (2026-07-18)

- Exact failed phase: `ssh_public_key_rejected_at_workspace_contract_prepare`; underlying provider injection versus then-unproven local key-path mismatch remains evidence-insufficient.
- Canonical identity: `ssh-ed25519`, fingerprint `SHA256:DxIZMV2kAajL8dJqG8fxId+sYI+54SE2Un1+aIy+MZc`, private-key identifier `clore_ai_video_worker_ed25519`, public source `derived_from_private_key`.
- Future order creation sends only that derived normalized key, validates fingerprint equality immediately before create, and never reads the sidecar `.pub` as the order credential source.
- Clore key transport is deterministic across readiness, workspace, SCP, Runtime, and cleanup: exact endpoint, order-scoped known-hosts, `root`, `IdentitiesOnly=yes`, disabled agent, key-only BatchMode, bounded timeout, and no SSH TTY.
- Future password fallback is order-bound, explicit in `ssh_password`, key-first, one-attempt, authorized_keys-repair-only, and deleted during cleanup.
- Prepared batch remains two RTX5090 image jobs plus one two-segment 10-second project; duplicates `0`, short-video jobs `0`.
- `stage4j2:plan` passes with provider mutations `0` and paid execution unauthorized. Read-only provider status remains Clore `0`, RunPod `0/0`, both holds `true`, no remote watchdog/process/create lock. All still-valid Stage 4J.1 authorization files were revoked and the local watchdog task was disabled.
