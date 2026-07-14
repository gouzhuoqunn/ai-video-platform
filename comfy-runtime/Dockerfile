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
    START_GPU_WORKER=false

WORKDIR /opt

COPY requirements.lock /opt/comfy-runtime/requirements.lock

RUN git clone https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
    && cd /opt/ComfyUI \
    && git checkout "${COMFYUI_COMMIT}" \
    && python3.11 -m pip install --upgrade pip setuptools wheel \
    && python3.11 -m pip install -r requirements.txt \
    && python3.11 -m pip install -r /opt/comfy-runtime/requirements.lock \
    && mkdir -p /workspace/models /workspace/comfy-input /workspace/comfy-output /workspace/comfy-user /workspace/logs /workspace/r2-cache /workspace/workflows \
    && find /opt/ComfyUI -type d -name ".git" -prune -exec rm -rf {} +

COPY controller.py healthcheck.py supervisor.py entrypoint.sh custom-node-locks.json /opt/comfy-runtime/
COPY workflows/ /opt/comfy-runtime/workflows/

RUN chmod +x /opt/comfy-runtime/entrypoint.sh \
    && python3.11 -m compileall -q /opt/comfy-runtime

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD python3.11 /opt/comfy-runtime/healthcheck.py

ENTRYPOINT ["/opt/comfy-runtime/entrypoint.sh"]
