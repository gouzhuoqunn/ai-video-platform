FROM ghcr.io/gouzhuoqunn/wan22-runtime@sha256:4e3dd6d2610c33ab2b260e970e4a9288043dc2c762cb1b8902b6712cfdfaa96c

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    COMFYUI_COMMIT=da2608926eaf68fd532bba4e1ace3402c5d21399 \
    COMFYUI_HOST=127.0.0.1 \
    COMFYUI_PORT=8188 \
    COMFY_CONTROLLER_HOST=0.0.0.0 \
    COMFY_CONTROLLER_PORT=8080 \
    COMFY_RUNTIME_MODE=gpu \
    COMFY_NODE_PROFILE=production_minimal \
    START_GPU_WORKER=false

WORKDIR /opt

ARG KORNIA_VERSION=""
COPY requirements.lock /opt/comfy-runtime/requirements.lock

RUN git clone https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
    && cd /opt/ComfyUI \
    && git checkout "${COMFYUI_COMMIT}" \
    && python3.11 -m pip install --upgrade pip setuptools wheel \
    && python3.11 -m pip install -r requirements.txt \
    && python3.11 -m pip install -r /opt/comfy-runtime/requirements.lock \
    && if [ -n "${KORNIA_VERSION}" ]; then python3.11 -m pip install "kornia==${KORNIA_VERSION}"; fi \
    && mkdir -p /workspace/models /workspace/comfy-input /workspace/comfy-output /workspace/comfy-user /workspace/logs /workspace/r2-cache /workspace/workflows \
    && find /opt/ComfyUI -type d -name ".git" -prune -exec rm -rf {} +

COPY controller.py healthcheck.py supervisor.py launch_comfy.py extras_extractor.py profile_audit.py custom-node-locks.json comfyui-source-audit.json /opt/comfy-runtime/
COPY --chmod=0755 entrypoint.sh /opt/comfy-runtime/entrypoint.sh
COPY node-profiles/ /opt/comfy-runtime/node-profiles/
COPY smoke_import_blocker/ /opt/comfy-runtime/smoke_import_blocker/
COPY workflows/ /opt/comfy-runtime/workflows/

RUN python3.11 -m compileall -q /opt/comfy-runtime

# The inherited Wan runtime may carry this retired entrypoint. Whiteout it explicitly.
RUN set -eux; \
    rm -f /app/worker.py; \
    test ! -e /app/worker.py

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD python3.11 /opt/comfy-runtime/healthcheck.py

ENTRYPOINT ["/opt/comfy-runtime/entrypoint.sh"]
