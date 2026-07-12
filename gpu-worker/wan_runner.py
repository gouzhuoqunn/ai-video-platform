from __future__ import annotations

import os
import subprocess
import json
from dataclasses import dataclass
from pathlib import Path

from config import WorkerConfig


@dataclass(frozen=True)
class RenderResult:
    output_path: str
    mime_type: str = "video/mp4"


class MockWanRunner:
    def __init__(self, config: WorkerConfig):
        self.config = config

    def render(self, job: dict) -> RenderResult:
        job_id = str(job["id"])
        job_dir = Path(self.config.wan_output_dir) / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        output_path = job_dir / "output.mp4"
        output_path.write_bytes(b"mock wan2.2 mp4 placeholder\n")
        return RenderResult(str(output_path))


class RealWanRunner:
    def __init__(self, config: WorkerConfig):
        self.config = config
        self._validate_model_cache()

    def _validate_model_cache(self) -> None:
        model_dir = Path(self.config.wan_model_dir)
        manifest_path = model_dir / self.config.wan_model_manifest
        if not model_dir.exists():
            raise FileNotFoundError("Wan2.2 model directory is missing; refusing to start real runner.")
        if not manifest_path.exists():
            raise FileNotFoundError("Wan2.2 model manifest is missing; refusing to start real runner.")

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("model") != "Wan-AI/Wan2.2-TI2V-5B":
            raise ValueError("Wan2.2 model manifest model id does not match expected TI2V-5B.")
        files = manifest.get("files")
        if not isinstance(files, list) or not files:
            raise ValueError("Wan2.2 model manifest has no file list.")

        missing = []
        for item in files:
            if not isinstance(item, dict):
                raise ValueError("Wan2.2 model manifest file entries must be objects.")
            relative_path = str(item.get("path", ""))
            sha256 = str(item.get("sha256", ""))
            if not relative_path or ".." in Path(relative_path).parts or Path(relative_path).is_absolute():
                raise ValueError("Wan2.2 model manifest contains an unsafe path.")
            if len(sha256) != 64:
                raise ValueError("Wan2.2 model manifest contains an invalid SHA-256 value.")
            if not (model_dir / relative_path).exists():
                missing.append(relative_path)
        if missing:
            raise FileNotFoundError(f"Wan2.2 model files are incomplete: {', '.join(missing[:3])}")

    def render(self, job: dict) -> RenderResult:
        prompt = str(job["prompt"])
        job_id = str(job["id"])
        job_dir = Path(self.config.wan_output_dir) / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        output_path = job_dir / "output.mp4"

        command = [
            "python",
            "-m",
            "wan",
            "--task",
            "ti2v-5B",
            "--size",
            f"{self.config.wan_width}*{self.config.wan_height}",
            "--ckpt_dir",
            self.config.wan_model_dir,
            "--prompt",
            prompt,
            "--frame_num",
            str(self.config.wan_num_frames),
            "--sample_steps",
            str(self.config.wan_inference_steps),
            "--sample_guide_scale",
            str(self.config.wan_guidance_scale),
            "--base_seed",
            str(self.config.wan_seed),
            "--save_file",
            str(output_path),
        ]

        if self.config.wan_cpu_offload:
            command.extend(["--offload_model", "True", "--convert_model_dtype", "--t5_cpu"])

        env = os.environ.copy()
        env["HF_HUB_DISABLE_TELEMETRY"] = "1"
        env["DO_NOT_TRACK"] = "1"
        subprocess.run(command, check=True, env=env)
        return RenderResult(str(output_path))


def build_runner(config: WorkerConfig):
    if config.wan_runner == "real":
        return RealWanRunner(config)
    return MockWanRunner(config)
