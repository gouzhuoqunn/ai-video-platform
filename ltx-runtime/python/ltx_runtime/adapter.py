from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any

OFFICIAL_SOURCE_REVISION = "9377758131b1ffde4b7f766804590a6617bf2ab9"
_ACTIVE_TASKS: set[str] = set()
_LOCK = Lock()


class RuntimeBlocked(RuntimeError):
    """The immutable manifest or a runtime safety precondition is not satisfied."""


@dataclass(frozen=True)
class Job:
    task_id: str
    prompt: str
    width: int
    height: int
    frame_count: int
    fps: float
    seed: int
    output_path: Path
    first_frame_path: Path | None = None


def _canonical_manifest_digest(payload: dict[str, Any]) -> str:
    body = {key: value for key, value in payload.items() if key != "manifestSha256"}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class LtxRuntimeAdapter:
    """Runs only the official LTX CLI from a fixed checkout; it never downloads artifacts."""

    def __init__(self, manifest_path: Path, model_root: Path, job_root: Path, output_root: Path):
        self.manifest_path = manifest_path.resolve()
        self.model_root = model_root.resolve()
        self.job_root = job_root.resolve()
        self.output_root = output_root.resolve()
        self.process: subprocess.Popen[str] | None = None
        self.loaded = False

    def load_manifest(self) -> dict[str, Any]:
        payload = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        if payload.get("schemaVersion") != 2:
            raise RuntimeBlocked("manifest_schema_unsupported")
        if payload.get("manifestSha256") != _canonical_manifest_digest(payload):
            raise RuntimeBlocked("manifest_sha256_mismatch")
        if payload.get("executableStatus") != "executable":
            raise RuntimeBlocked(f"model_blocked:{payload.get('blockerReason') or 'unknown'}")
        if payload.get("officialRuntimeSource", {}).get("revision") != OFFICIAL_SOURCE_REVISION:
            raise RuntimeBlocked("official_runtime_revision_mismatch")
        if payload.get("pipeline", {}).get("id") not in {"official-distilled", "official-ti2vid-two-stage"}:
            raise RuntimeBlocked("pipeline_not_allowlisted")
        return payload

    def _checked_model_path(self, relative: str) -> Path:
        candidate = (self.model_root / relative).resolve()
        if self.model_root not in candidate.parents or not candidate.is_file():
            raise RuntimeBlocked("required_model_file_missing")
        return candidate

    def prepare(self) -> None:
        manifest = self.load_manifest()
        for item in manifest["files"]:
            if item.get("required"):
                model_file = self._checked_model_path(str(item["path"]))
                if hashlib.sha256(model_file.read_bytes()).hexdigest() != item["sha256"]:
                    raise RuntimeBlocked("model_checksum_mismatch")
        self.loaded = True

    def command_for(self, job: Job) -> list[str]:
        if not self.loaded:
            raise RuntimeBlocked("model_not_prepared")
        if job.width % 32 or job.height % 32 or job.frame_count % 8 != 1:
            raise RuntimeBlocked("invalid_ltx_dimensions_or_frames")
        manifest = self.load_manifest()
        checkpoint = self._checked_model_path(manifest["pipeline"]["checkpointPath"])
        spatial = self._checked_model_path(manifest["pipeline"]["spatialUpscalerPath"])
        gemma = self._checked_model_path(manifest["pipeline"]["gemmaSentinelPath"]).parent
        module = "ltx_pipelines.distilled" if manifest["pipeline"]["id"] == "official-distilled" else "ltx_pipelines.ti2vid_two_stages"
        command = ["python3", "-m", module, "--output-path", str(job.output_path), "--prompt", job.prompt, "--seed", str(job.seed), "--height", str(job.height), "--width", str(job.width), "--num-frames", str(job.frame_count), "--frame-rate", str(job.fps), "--spatial-upsampler-path", str(spatial), "--gemma-root", str(gemma)]
        command += ["--distilled-checkpoint-path", str(checkpoint)] if module.endswith("distilled") else ["--checkpoint-path", str(checkpoint)]
        if job.first_frame_path is not None:
            # Official TI2Vid accepts image conditioning; the exact CLI input is verified in Stage 3B before use.
            if module.endswith("distilled"):
                command += ["--images", str(job.first_frame_path)]
            else:
                raise RuntimeBlocked("i2v_cli_contract_requires_stage3b_validation")
        return command

    def run(self, job: Job) -> dict[str, Any]:
        """Production invocation path; unused in Stage 3A and intentionally no auto-download."""
        with _LOCK:
            if job.task_id in _ACTIVE_TASKS:
                raise RuntimeBlocked("duplicate_task_suppressed")
            _ACTIVE_TASKS.add(job.task_id)
        try:
            job.output_path.parent.mkdir(parents=True, exist_ok=True)
            self.process = subprocess.Popen(self.command_for(job), cwd=self.job_root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env={**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
            started = time.time()
            while self.process.poll() is None:
                time.sleep(1)
            if self.process.returncode != 0 or not job.output_path.is_file():
                raise RuntimeBlocked("official_ltx_process_failed")
            return {"taskId": job.task_id, "status": "completed", "elapsedSeconds": round(time.time() - started, 3), "output": job.output_path.name}
        finally:
            with _LOCK:
                _ACTIVE_TASKS.discard(job.task_id)
            self.process = None

    def cancel(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()

    def unload(self) -> None:
        self.cancel()
        self.loaded = False
        try:
            import torch
            torch.cuda.empty_cache()
        except ImportError:
            pass
