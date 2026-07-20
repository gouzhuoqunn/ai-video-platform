#!/bin/sh
set -eu
if [ "${1:-health}" = "health" ]; then
  exec node /opt/ltx-runtime/healthcheck.mjs
fi
echo "LTX Stage 2 image is mock-only; real model execution is intentionally disabled." >&2
exit 64
