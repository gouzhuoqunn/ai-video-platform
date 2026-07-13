FROM nvidia/cuda:12.8.0-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-venv \
    python3-pip \
    git \
    ffmpeg \
    rclone \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN python3.11 -m pip install --upgrade pip setuptools wheel \
    && python3.11 -m pip install -r /app/requirements.txt \
    && python3.11 -m pip install --index-url https://download.pytorch.org/whl/cu128 \
      torch==2.7.1 torchvision==0.22.1 torchaudio==2.7.1 \
    && python3.11 -m pip install "git+https://github.com/Wan-Video/Wan2.2.git@42bf4cfaa384bc21833865abc2f9e6c0e67233dc" || true

COPY . /app
RUN chmod +x /app/entrypoint.sh

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 CMD python3.11 /app/healthcheck.py

ENTRYPOINT ["/app/entrypoint.sh"]
