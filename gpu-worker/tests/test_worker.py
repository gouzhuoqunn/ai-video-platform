import logging
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.append(str(Path(__file__).resolve().parents[1]))

from config import WorkerConfig
from security import cleanup_job_dir, prompt_metadata, redact, validate_output_path
from wan_runner import MockWanRunner, RealWanRunner
from worker import GpuWorker


class FakeExecute:
    def __init__(self, data=None):
        self.data = data

    def execute(self):
        return self


class FakeRpc:
    def __init__(self, client, name, payload):
        self.client = client
        self.name = name
        self.payload = payload

    def execute(self):
        self.client.calls.append((self.name, self.payload))
        if self.name == "claim_next_video_job":
            return FakeExecute(self.client.claim_data)
        return FakeExecute({})


class FakeBucket:
    def __init__(self, client):
        self.client = client

    def upload(self, remote_path, file, options):
        self.client.uploads.append((remote_path, options))
        file.read()
        return {"path": remote_path}


class FakeStorage:
    def __init__(self, client):
        self.client = client

    def from_(self, _bucket):
        return FakeBucket(self.client)


class FakeSupabase:
    def __init__(self, claim_data=None):
        self.claim_data = claim_data
        self.calls = []
        self.uploads = []
        self.storage = FakeStorage(self)

    def rpc(self, name, payload):
        return FakeRpc(self, name, payload)


def config(tmpdir):
    return WorkerConfig(
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="publishable",
        worker_email="worker@example.test",
        worker_password="password",
        worker_id="worker-user-id",
        wan_runner="mock",
        wan_model_dir="/workspace/models/Wan2.2-TI2V-5B",
        wan_model_manifest="model-cache-manifest.json",
        wan_output_dir=tmpdir,
        wan_width=1280,
        wan_height=704,
        wan_num_frames=120,
        wan_inference_steps=30,
        wan_guidance_scale=5.0,
        wan_seed=42,
        wan_cpu_offload=True,
        worker_poll_interval_seconds=1,
        worker_lease_seconds=300,
    )


class WorkerTests(unittest.TestCase):
    def test_prompt_metadata_does_not_include_prompt(self):
        meta = prompt_metadata("secret prompt")
        self.assertEqual(meta["prompt_length"], 13)
        self.assertNotIn("secret prompt", str(meta))

    def test_redact_masks_tokens_and_secret_names(self):
        self.assertIn("[REDACTED]", redact("SUPABASE_SECRET_KEY=abc"))

    def test_output_path_validation(self):
        self.assertTrue(validate_output_path("user", "job", "user/job/output.mp4"))
        self.assertFalse(validate_output_path("user", "job", "user/other/output.mp4"))

    def test_mock_success_calls_complete_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            job = {"id": "job-1", "user_id": "user-1", "prompt": "make video"}
            fake = FakeSupabase(claim_data=[job])
            worker = GpuWorker(config(tmp), supabase_client=fake, runner=MockWanRunner(config(tmp)), logger=logging.getLogger("test"))
            self.assertTrue(worker.process_one())
            call_names = [call[0] for call in fake.calls]
            self.assertIn("complete_video_job", call_names)
            self.assertEqual(fake.uploads[0][0], "user-1/job-1/output.mp4")
            self.assertFalse((Path(tmp) / "job-1").exists())

    def test_runner_failure_calls_fail(self):
        class BrokenRunner:
            def render(self, _job):
                raise RuntimeError("boom")

        with tempfile.TemporaryDirectory() as tmp:
            job = {"id": "job-2", "user_id": "user-1", "prompt": "make video"}
            fake = FakeSupabase(claim_data=[job])
            worker = GpuWorker(config(tmp), supabase_client=fake, runner=BrokenRunner(), logger=logging.getLogger("test"))
            self.assertTrue(worker.process_one())
            call_names = [call[0] for call in fake.calls]
            self.assertIn("fail_video_job", call_names)

    def test_cleanup_refuses_outside_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                cleanup_job_dir(tmp, "../outside")

    def test_real_runner_refuses_missing_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = config(tmp)
            cfg = WorkerConfig(
                supabase_url=cfg.supabase_url,
                supabase_publishable_key=cfg.supabase_publishable_key,
                worker_email=cfg.worker_email,
                worker_password=cfg.worker_password,
                worker_id=cfg.worker_id,
                wan_runner="real",
                wan_model_dir=tmp,
                wan_model_manifest=cfg.wan_model_manifest,
                wan_output_dir=tmp,
                wan_width=cfg.wan_width,
                wan_height=cfg.wan_height,
                wan_num_frames=cfg.wan_num_frames,
                wan_inference_steps=cfg.wan_inference_steps,
                wan_guidance_scale=cfg.wan_guidance_scale,
                wan_seed=cfg.wan_seed,
                wan_cpu_offload=cfg.wan_cpu_offload,
                worker_poll_interval_seconds=cfg.worker_poll_interval_seconds,
                worker_lease_seconds=cfg.worker_lease_seconds,
            )
            with self.assertRaises(FileNotFoundError):
                RealWanRunner(cfg)


if __name__ == "__main__":
    unittest.main()
