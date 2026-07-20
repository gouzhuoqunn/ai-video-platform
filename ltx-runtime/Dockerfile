# LTX Runtime has two explicit targets.  Neither target contains model weights,
# credentials, prompts, media, or any automatic download path.
FROM node:22.14.0-bookworm-slim AS mock
LABEL org.opencontainers.image.title="ai-video-platform-ltx-runtime" \
      org.opencontainers.image.version="stage3a-mock" \
      org.opencontainers.image.description="Weight-free LTX mock contract"
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 runtime
WORKDIR /opt/ltx-runtime
COPY healthcheck.mjs entrypoint.sh ./
RUN chmod 0555 entrypoint.sh healthcheck.mjs && chown -R runtime:runtime /opt/ltx-runtime
USER runtime
VOLUME ["/models", "/work", "/output"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "/opt/ltx-runtime/healthcheck.mjs"]
ENTRYPOINT ["/opt/ltx-runtime/entrypoint.sh"]

# This pinned CUDA tag is the Blackwell-ready base selected for a future build.
# A registry digest must be recorded before a paid image is published or deployed.
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04 AS production
LABEL org.opencontainers.image.title="ai-video-platform-ltx-runtime" \
      org.opencontainers.image.version="stage3a-production-definition" \
      org.opencontainers.image.source="https://github.com/Lightricks/LTX-2/tree/9377758131b1ffde4b7f766804590a6617bf2ab9" \
      org.opencontainers.image.description="Weight-free official LTX pipelines runtime definition"
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ffmpeg ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 runtime \
    && mkdir -p /models /work/jobs /output && chown -R runtime:runtime /models /work /output
WORKDIR /opt/ltx-runtime
COPY python/requirements-runtime.lock python/requirements-source.lock python/requirements-test.lock ./python/
COPY python/ltx_runtime ./python/ltx_runtime
COPY python/entrypoint.py ./python/entrypoint.py
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --upgrade pip==25.0.1 \
    && /opt/venv/bin/pip install --extra-index-url https://download.pytorch.org/whl/cu128 -r python/requirements-runtime.lock \
    && /opt/venv/bin/pip install -r python/requirements-source.lock \
    && chmod -R a-w /opt/ltx-runtime/python
ENV PATH="/opt/venv/bin:${PATH}" LTX_MANIFEST_DIR=/models/manifests LTX_MODEL_ROOT=/models LTX_JOB_ROOT=/work/jobs LTX_OUTPUT_ROOT=/output
USER runtime
# The operator must mount /models read-only; Docker VOLUME itself cannot encode a mode.
VOLUME ["/models", "/work", "/output"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["python3", "/opt/ltx-runtime/python/entrypoint.py", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "python3", "/opt/ltx-runtime/python/entrypoint.py"]
