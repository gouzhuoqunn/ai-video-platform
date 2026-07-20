# GPT-SoVITS runtime handoff

This repository does not install, download, or execute GPT-SoVITS inference in this checkpoint. The local voice adapter intentionally exposes only a replaceable contract: validate voice profile, prepare, synthesize, cancel, validate WAV, unload, health, and shutdown.

The dependency gate now has a reproducible non-global Windows route. PyPI provides only the hash-verified `pyopenjtalk==0.4.1` source distribution for this target, so `.github/workflows/build-pyopenjtalk-windows-wheel.yml` builds a CPython 3.10 x64 wheel on a GitHub-hosted Windows runner. The workflow has not yet been dispatched or downloaded locally; see `PYOPENJTALK_WINDOWS_PROVENANCE.md` for the exact retrieval blocker.

A future local implementation must remain local-only, use explicit approved voice-profile metadata, write only approved relative local-media paths, validate WAV metadata and duration before handoff, preserve immutable audio revision evidence, and release loaded resources after completion or cancellation. It must not receive Clore keys, Supabase service keys, R2 write credentials, SSH keys, or production GPU authority.
## Stage 3A.2B branch build status

The Windows wheel workflow now also triggers only from relevant pushes to `codex/stage4g1-long-video-prompts`. It has not yet run or been downloaded locally because the normal push is blocked by a GitHub connection reset; the runtime remains fail-closed.
