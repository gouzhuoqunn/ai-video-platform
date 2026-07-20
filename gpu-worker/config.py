from __future__ import annotations

import os
from dataclasses import dataclass


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    value = os.getenv(name)
    if not value:
        return default
    return int(value)


def _float(name: str, default: float) -> float:
    value = os.getenv(name)
    if not value:
        return default
    return float(value)


@dataclass(frozen=True)
class WorkerConfig:
    supabase_url: str
    supabase_publishable_key: str
    worker_email: str
    worker_password: str
    worker_id: str
    wan_runner: str
    wan_model_revision: str
    wan_code_revision: str
    wan_model_dir: str
    wan_model_manifest: str
    wan_output_dir: str
    wan_width: int
    wan_height: int
    wan_num_frames: int
    wan_inference_steps: int
    wan_guidance_scale: float
    wan_seed: int
    wan_cpu_offload: bool
    worker_poll_interval_seconds: int
    worker_lease_seconds: int
    first_session_max_claims: int
    execution_mode: str = "generic"
    execution_batch_id: str = ""
    expected_model_key: str = ""
    expected_gpu_class: str = ""

    @staticmethod
    def from_env() -> "WorkerConfig":
        email = os.getenv("GPU_WORKER_EMAIL", "").strip()
        return WorkerConfig(
            supabase_url=os.getenv("SUPABASE_URL", "").strip(),
            supabase_publishable_key=os.getenv("SUPABASE_PUBLISHABLE_KEY", "").strip(),
            worker_email=email,
            worker_password=os.getenv("GPU_WORKER_PASSWORD", "").strip(),
            worker_id=os.getenv("GPU_WORKER_USER_ID", "").strip() or email,
            wan_runner=os.getenv("WAN_RUNNER", "mock").strip().lower(),
            wan_model_revision=os.getenv("WAN_MODEL_REVISION", "921dbaf3f1674a56f47e83fb80a34bac8a8f203e").strip(),
            wan_code_revision=os.getenv("WAN_CODE_REVISION", "42bf4cfaa384bc21833865abc2f9e6c0e67233dc").strip(),
            wan_model_dir=os.getenv("WAN_MODEL_DIR", "/workspace/models/Wan2.2-TI2V-5B"),
            wan_model_manifest=os.getenv("WAN_MODEL_MANIFEST", "model-cache-manifest.json"),
            wan_output_dir=os.getenv("WAN_OUTPUT_DIR", "/workspace/jobs"),
            wan_width=_int("WAN_WIDTH", 1280),
            wan_height=_int("WAN_HEIGHT", 704),
            wan_num_frames=_int("WAN_NUM_FRAMES", 120),
            wan_inference_steps=_int("WAN_INFERENCE_STEPS", 30),
            wan_guidance_scale=_float("WAN_GUIDANCE_SCALE", 5.0),
            wan_seed=_int("WAN_SEED", 42),
            wan_cpu_offload=_bool("WAN_CPU_OFFLOAD", True),
            worker_poll_interval_seconds=_int("WORKER_POLL_INTERVAL_SECONDS", 8),
            worker_lease_seconds=_int("WORKER_LEASE_SECONDS", 300),
            first_session_max_claims=_int("FIRST_SESSION_MAX_CLAIMS", 0),
            execution_mode=os.getenv("GPU_WORKER_EXECUTION_MODE", "generic").strip().lower(),
            execution_batch_id=os.getenv("GPU_WORKER_BATCH_ID", "").strip(),
            expected_model_key=os.getenv("GPU_WORKER_EXPECTED_MODEL_KEY", "").strip(),
            expected_gpu_class=os.getenv("GPU_WORKER_EXPECTED_GPU_CLASS", "").strip().lower(),
        )

    def validate(self) -> None:
        missing = [
            name
            for name, value in {
                "SUPABASE_URL": self.supabase_url,
                "SUPABASE_PUBLISHABLE_KEY": self.supabase_publishable_key,
                "GPU_WORKER_EMAIL": self.worker_email,
                "GPU_WORKER_PASSWORD": self.worker_password,
            }.items()
            if not value
        ]
        if missing:
            raise ValueError(f"missing required env: {', '.join(missing)}")

        if self.wan_runner not in {"mock", "real"}:
            raise ValueError("WAN_RUNNER must be mock or real")
        if self.first_session_max_claims < 0:
            raise ValueError("FIRST_SESSION_MAX_CLAIMS must be 0 or greater")
        if self.execution_mode not in {"generic", "immutable_batch"}:
            raise ValueError("GPU_WORKER_EXECUTION_MODE must be generic or immutable_batch")
        if self.execution_mode == "immutable_batch" and (not self.execution_batch_id or self.expected_model_key != "video_wan_silent" or self.expected_gpu_class != "rtx4090"):
            raise ValueError("immutable batch mode requires batch id, video_wan_silent and rtx4090")
        if self.wan_runner == "real":
            if not self.wan_model_revision or self.wan_model_revision == "main":
                raise ValueError("WAN_MODEL_REVISION must be pinned for real runner")
            if not self.wan_code_revision or self.wan_code_revision == "main":
                raise ValueError("WAN_CODE_REVISION must be pinned for real runner")
