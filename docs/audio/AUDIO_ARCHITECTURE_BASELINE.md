# Audio Architecture Baseline

Audio origin is explicit: `none` for Wan silent tasks, `native_model` for LTX native audio-video tasks, and `local_voice` for future local voice composition. A native-audio task never creates a local voice inference job and has no independent regenerate-audio action. Regenerating it creates a complete new audio-video revision.
