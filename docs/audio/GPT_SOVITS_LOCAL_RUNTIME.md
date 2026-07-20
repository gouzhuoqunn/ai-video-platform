# GPT-SoVITS local runtime

The local runtime is CPU-only and intentionally fail-closed. It uses only the
project-local Python environment under `local-data/voice/runtime-envs/gpt-sovits`.
No command installs into system Python, changes PATH, downloads a model, or
starts inference while the verified PyOpenJTalk artifact is absent.

Commands:

```powershell
npm run audio:gpt-sovits:setup
npm run audio:gpt-sovits:status
npm run audio:gpt-sovits:verify
npm run audio:gpt-sovits:repair
npm run audio:gpt-sovits:uninstall-runtime -- --execute
```

`setup`, `status`, and `repair` create the needed ignored directories
idempotently and write a sanitized journal under
`local-data/voice/worker-state/`. `verify` exits non-zero until the pinned
source and verified project-local `pyopenjtalk` are both available. The narrow
uninstall command requires `--execute` and targets only the pinned runtime
source, isolated environment, and GPT-SoVITS base-model root; it never targets
voice packs, inference revisions, dialogue records, or video/image media.

The current blocker is `blocked_pyopenjtalk_artifact_download`: GitHub Actions
does not expose a workflow that exists only on this feature branch for manual
dispatch; it must be available on the repository default branch or supplied as
an already-verified artifact through an approved repository flow. This stage
does not modify `main` to bypass that GitHub limitation.
