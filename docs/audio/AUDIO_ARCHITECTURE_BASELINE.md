# Audio Architecture Baseline

Audio origin is explicit: `none` for Wan silent tasks and `local_voice_conditioning` for audible LTX A2Vid tasks. An audible task creates a local voice inference job and immutable audio revision before GPU confirmation. The local runtime boundary is interface-first: validation, prepare, synthesize, cancel, unload, health, and shutdown are defined, while this checkpoint uses only a silent-WAV mock and does not download or run GPT-SoVITS.

The GPU task receives a relative input WAV reference, SHA-256, duration, voice/revision IDs, and immutable dialogue snapshot. It must preserve the supplied audio stream and record matching result provenance; it must not synthesize audio from the visual prompt or silently replace the input audio.
