# LTX native-audio Runtime contract

This directory is a non-production, weight-free Stage 2 image definition. It is intentionally mock-only: it includes FFmpeg/FFprobe health checks but no LTX Python packages, models, media, tokens, signed URLs, or credentials.

The future paid Runtime must mount an immutable verified model package read-only and use the narrow official `ltx-pipelines` adapter selected in `docs/models/LTX23_RUNTIME_BASELINE.md`. It must not reuse this image as proof of real LTX inference.
