# Stage 2 contract image: mock-only, deliberately contains no weights or credentials.
# A paid-stage image must pin the official LTX Python runtime after its immutable dependency lock is verified.
FROM node:22.14.0-bookworm-slim

LABEL org.opencontainers.image.title="ai-video-platform-ltx-runtime-contract" \
      org.opencontainers.image.version="stage2-mock-1" \
      org.opencontainers.image.description="Mock native-audio Runtime contract; no model execution"

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 runtime
WORKDIR /opt/ltx-runtime
COPY healthcheck.mjs entrypoint.sh ./
RUN chmod 0555 entrypoint.sh healthcheck.mjs && chown -R runtime:runtime /opt/ltx-runtime
USER runtime
VOLUME ["/models", "/work", "/output"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "/opt/ltx-runtime/healthcheck.mjs"]
ENTRYPOINT ["/opt/ltx-runtime/entrypoint.sh"]
