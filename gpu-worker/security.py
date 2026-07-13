from __future__ import annotations

import hashlib
import logging
import re
import shutil
from pathlib import Path

SECRET_PATTERNS = [
    re.compile(r"SUPABASE_[A-Z_]*KEY", re.IGNORECASE),
    re.compile(r"GPU_WORKER_PASSWORD", re.IGNORECASE),
    re.compile(r"eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}"),
    re.compile(r"https://[^ ]*token=[^ ]+", re.IGNORECASE),
]


def prompt_metadata(prompt: str) -> dict[str, str | int]:
    digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
    return {"prompt_length": len(prompt), "prompt_sha256_16": digest}


def redact(value: str) -> str:
    redacted = value
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def safe_log(logger: logging.Logger, message: str, **fields: object) -> None:
    safe_fields = {key: redact(str(value)) for key, value in fields.items()}
    logger.info("%s %s", redact(message), safe_fields)


def validate_output_path(user_id: str, job_id: str, output_path: str) -> bool:
    return output_path in {
        f"{user_id}/{job_id}/output.mp4",
        f"{user_id}/{job_id}/output.webm",
        f"{user_id}/{job_id}/thumbnail.jpg",
        f"{user_id}/{job_id}/thumbnail.webp",
    }


def cleanup_job_dir(base_dir: str, job_id: str) -> None:
    job_path = (Path(base_dir) / job_id).resolve()
    base_path = Path(base_dir).resolve()
    if base_path not in job_path.parents:
        raise ValueError("refusing to clean path outside WAN_OUTPUT_DIR")
    shutil.rmtree(job_path, ignore_errors=True)
