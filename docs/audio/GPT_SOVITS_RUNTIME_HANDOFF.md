# GPT-SoVITS runtime handoff

This repository does not install, download, or execute GPT-SoVITS in this checkpoint. The local voice adapter intentionally exposes only a replaceable contract: validate voice profile, prepare, synthesize, cancel, validate WAV, unload, health, and shutdown.

A future local implementation must remain local-only, use explicit approved voice-profile metadata, write only approved relative local-media paths, validate WAV metadata and duration before handoff, preserve immutable audio revision evidence, and release loaded resources after completion or cancellation. It must not receive Clore keys, Supabase service keys, R2 write credentials, SSH keys, or production GPU authority.
