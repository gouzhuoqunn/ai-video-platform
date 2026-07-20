# LTX native-audio Runtime contract

This directory contains explicit Stage 3A `mock` and `production` Docker targets. Both are weight-free and credential-free. The production target is only a static, pinned definition around the official LTX source; it is not evidence of a built image, a downloaded model, a rented GPU, or real inference.

The future paid Runtime must mount an immutable verified model package read-only and use the narrow official `ltx-pipelines` adapter selected in `docs/models/LTX23_PRODUCTION_RUNTIME.md`. It must not reuse this image as proof of real LTX inference.
