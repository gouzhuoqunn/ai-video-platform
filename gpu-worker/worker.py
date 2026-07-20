from __future__ import annotations

import logging
import os
import random
import subprocess
import time
from pathlib import Path

from config import WorkerConfig
from security import cleanup_job_dir, prompt_metadata, safe_log, validate_output_path
from wan_runner import build_runner

BUCKET = "generated-videos"
PROGRESS_STEPS = [5, 20, 45, 70, 90]


class GpuWorker:
    def __init__(self, config: WorkerConfig, supabase_client=None, runner=None, logger=None):
        self.config = config
        if supabase_client is None:
            from supabase import create_client

            supabase_client = create_client(config.supabase_url, config.supabase_publishable_key)
        self.supabase = supabase_client
        self.runner = runner or build_runner(config)
        self.logger = logger or logging.getLogger("gpu-worker")
        self.claim_count = 0

    def login(self) -> None:
        self.supabase.auth.sign_in_with_password(
            {"email": self.config.worker_email, "password": self.config.worker_password}
        )

    def claim(self):
        if self.config.execution_mode == "immutable_batch":
            response = self.supabase.rpc(
                "claim_next_video_job_for_batch",
                {
                    "p_batch_id": self.config.execution_batch_id,
                    "p_worker_id": self.config.worker_id,
                    "p_expected_model_key": self.config.expected_model_key,
                    "p_expected_gpu_class": self.config.expected_gpu_class,
                    "p_lease_seconds": self.config.worker_lease_seconds,
                },
            ).execute()
            data = response.data
            if isinstance(data, list):
                return data[0] if data else None
            return data
        response = self.supabase.rpc(
            "claim_next_video_job",
            {"p_worker_id": self.config.worker_id, "p_lease_seconds": self.config.worker_lease_seconds},
        ).execute()
        data = response.data
        if isinstance(data, list):
            return data[0] if data else None
        return data

    def heartbeat(self, job_id: str, progress: int) -> None:
        if self.config.execution_mode == "immutable_batch":
            self.supabase.rpc(
                "heartbeat_video_job_for_batch",
                {
                    "p_batch_id": self.config.execution_batch_id,
                    "p_job_id": job_id,
                    "p_worker_id": self.config.worker_id,
                    "p_expected_model_key": self.config.expected_model_key,
                    "p_expected_gpu_class": self.config.expected_gpu_class,
                    "p_progress": progress,
                    "p_lease_seconds": self.config.worker_lease_seconds,
                },
            ).execute()
            return
        self.supabase.rpc(
            "heartbeat_video_job",
            {
                "p_job_id": job_id,
                "p_worker_id": self.config.worker_id,
                "p_progress": progress,
                "p_lease_seconds": self.config.worker_lease_seconds,
            },
        ).execute()

    def fail(self, job_id: str, message: str) -> None:
        if self.config.execution_mode == "immutable_batch":
            self.supabase.rpc(
                "fail_video_job_for_batch",
                {
                    "p_batch_id": self.config.execution_batch_id,
                    "p_job_id": job_id,
                    "p_worker_id": self.config.worker_id,
                    "p_expected_model_key": self.config.expected_model_key,
                    "p_expected_gpu_class": self.config.expected_gpu_class,
                    "p_error_message": message.splitlines()[0][:300] or "GPU worker failed.",
                },
            ).execute()
            return
        self.supabase.rpc(
            "fail_video_job",
            {
                "p_job_id": job_id,
                "p_worker_id": self.config.worker_id,
                "p_error_message": message.splitlines()[0][:300] or "GPU worker failed.",
            },
        ).execute()

    def make_thumbnail(self, job_id: str, local_output_path: str) -> str | None:
        output = Path(local_output_path)
        thumbnail = output.with_name("thumbnail.jpg")
        try:
            duration_probe = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(output),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            duration = float(duration_probe.stdout.strip() or "0")
            rng = random.Random(job_id)
            seek = duration * rng.uniform(0.10, 0.90) if duration > 0 else 0
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    f"{seek:.3f}",
                    "-i",
                    str(output),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=640:360:force_original_aspect_ratio=increase,crop=640:360",
                    "-q:v",
                    "3",
                    str(thumbnail),
                ],
                check=True,
                capture_output=True,
                timeout=60,
            )
            return str(thumbnail)
        except Exception:
            try:
                subprocess.run(
                    [
                        "ffmpeg",
                        "-y",
                        "-f",
                        "lavfi",
                        "-i",
                        "color=c=0x111827:s=640x360:d=0.1",
                        "-frames:v",
                        "1",
                        str(thumbnail),
                    ],
                    check=True,
                    capture_output=True,
                    timeout=30,
                )
                return str(thumbnail)
            except Exception:
                safe_log(self.logger, "thumbnail_failed", job_id=job_id)
                return None

    def complete(self, job: dict, local_output_path: str, mime_type: str) -> None:
        job_id = str(job["id"])
        user_id = str(job["user_id"])
        extension = "webm" if mime_type == "video/webm" else "mp4"
        remote_path = f"{user_id}/{job_id}/output.{extension}"
        if not validate_output_path(user_id, job_id, remote_path):
            raise ValueError("invalid output path")

        with open(local_output_path, "rb") as file:
            self.supabase.storage.from_(BUCKET).upload(
                remote_path,
                file,
                {"content-type": mime_type, "upsert": "false"},
            )

        thumbnail_path = self.make_thumbnail(job_id, local_output_path)
        if thumbnail_path:
            remote_thumbnail_path = f"{user_id}/{job_id}/thumbnail.jpg"
            if validate_output_path(user_id, job_id, remote_thumbnail_path):
                with open(thumbnail_path, "rb") as file:
                    self.supabase.storage.from_(BUCKET).upload(
                        remote_thumbnail_path,
                        file,
                        {"content-type": "image/jpeg", "upsert": "false"},
                    )

        size_bytes = Path(local_output_path).stat().st_size
        rpc_name = "complete_video_job"
        payload = {
                "p_job_id": job_id,
                "p_worker_id": self.config.worker_id,
                "p_output_video_path": remote_path,
                "p_output_size_bytes": size_bytes,
                "p_output_mime_type": mime_type,
            }
        if self.config.execution_mode == "immutable_batch":
            rpc_name = "complete_video_job_for_batch"
            payload.update({
                "p_batch_id": self.config.execution_batch_id,
                "p_expected_model_key": self.config.expected_model_key,
                "p_expected_gpu_class": self.config.expected_gpu_class,
            })
        self.supabase.rpc(rpc_name, payload).execute()

    def process_one(self) -> bool:
        if self.config.first_session_max_claims and self.claim_count >= self.config.first_session_max_claims:
            safe_log(self.logger, "claim_limit_reached", worker_id=self.config.worker_id, claim_count=self.claim_count)
            return False

        job = self.claim()
        if not job:
            return False
        self.claim_count += 1

        job_id = str(job["id"])
        started = time.monotonic()
        safe_log(self.logger, "job_started", job_id=job_id, worker_id=self.config.worker_id, **prompt_metadata(str(job["prompt"])))
        try:
            for progress in PROGRESS_STEPS:
                self.heartbeat(job_id, progress)
                safe_log(self.logger, "job_progress", job_id=job_id, progress=progress)

            result = self.runner.render(job)
            self.complete(job, result.output_path, result.mime_type)
            safe_log(self.logger, "job_completed", job_id=job_id, elapsed_seconds=round(time.monotonic() - started, 2))
            return True
        except Exception as exc:
            safe_log(self.logger, "job_failed", job_id=job_id, error_code=exc.__class__.__name__)
            self.fail(job_id, "GPU worker failed safely.")
            return True
        finally:
            cleanup_job_dir(self.config.wan_output_dir, job_id)

    def run_forever(self) -> None:
        self.login()
        while True:
            processed = self.process_one()
            if not processed:
                time.sleep(self.config.worker_poll_interval_seconds)


def main() -> None:
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = WorkerConfig.from_env()
    config.validate()
    GpuWorker(config).run_forever()


if __name__ == "__main__":
    main()
