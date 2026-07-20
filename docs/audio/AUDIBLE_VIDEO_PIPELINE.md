# Audible video pipeline

An audible task is local-audio-first. Submission records the visual prompt and a structured dialogue snapshot, creates a local voice inference job/revision binding, and displays the task as waiting for local audio. It is not selectable for GPU confirmation until the local audio binding is `local_audio_ready`.

The approved handoff is a validated WAV plus its relative reference, SHA-256, duration, audio revision ID, voice inference job ID, voice profile ID, and dialogue snapshot. Confirmation freezes that revision ID on the video task. A failed, missing, mismatched, or replaced audio revision blocks confirmation.

The four sidebar queue identities remain `silent:rtx4090`, `silent:rtx5090`, `audible:rtx4090`, and `audible:rtx5090`. The audio-local lifecycle does not rent GPUs, call providers, download models, or upload media.
## Stage 3A.2B rental gate

The sidebar reports total, confirmed, executable, and waiting-local-audio queue counts separately. Only a task with an immutable `local_audio_ready` binding is executable; it remains in the video gallery while pending and never blocks a silent queue through GPT-SoVITS readiness.
