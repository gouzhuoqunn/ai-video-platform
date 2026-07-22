FROM nvidia/cuda:12.4.1-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    COMFYUI_COMMIT=da2608926eaf68fd532bba4e1ace3402c5d21399 \
    PYTORCH_VERSION=2.5.1 \
    TORCHVISION_VERSION=0.20.1 \
    COMFYUI_HOST=127.0.0.1 \
    COMFYUI_PORT=8188 \
    COMFY_CONTROLLER_HOST=0.0.0.0 \
    COMFY_CONTROLLER_PORT=8080 \
    COMFY_RUNTIME_MODE=gpu \
    COMFY_NODE_PROFILE=image-flux \
    START_GPU_WORKER=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --upgrade pip setuptools wheel \
    && python3 -m pip install --index-url https://download.pytorch.org/whl/cu124 "torch==${PYTORCH_VERSION}" "torchvision==${TORCHVISION_VERSION}"

WORKDIR /opt
COPY requirements.lock /opt/image-runtime/requirements.lock
RUN git clone https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
    && cd /opt/ComfyUI \
    && git checkout "${COMFYUI_COMMIT}" \
    && python3 -m pip install -r requirements.txt \
    && python3 -m pip install -r /opt/image-runtime/requirements.lock \
    && mkdir -p /workspace/models /workspace/comfy-input /workspace/comfy-output /workspace/comfy-user /workspace/logs /workspace/r2-cache \
    && find /opt/ComfyUI -type d -name ".git" -prune -exec rm -rf {} +

COPY controller.py image_workflow.py restore_r2.py healthcheck.py supervisor.py launch_comfy.py extras_extractor.py profile_audit.py image-model-artifacts.json image-source-artifacts.json /opt/image-runtime/
COPY --chmod=0755 entrypoint.sh /opt/image-runtime/entrypoint.sh
COPY node-profiles/image-flux.json /opt/image-runtime/node-profiles/image-flux.json
COPY smoke_import_blocker/ /opt/image-runtime/smoke_import_blocker/
RUN python3 -m compileall -q /opt/image-runtime

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD python3 /opt/image-runtime/healthcheck.py
ENTRYPOINT ["/opt/image-runtime/entrypoint.sh"]
