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
        if self.name in {"claim_next_video_job", "claim_next_video_job_for_batch"}:
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
        wan_model_revision="921dbaf3f1674a56f47e83fb80a34bac8a8f203e",
        wan_code_revision="42bf4cfaa384bc21833865abc2f9e6c0e67233dc",
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
        first_session_max_claims=0,
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
        self.assertTrue(validate_output_path("user", "job", "user/job/thumbnail.jpg"))
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
                wan_model_revision=cfg.wan_model_revision,
                wan_code_revision=cfg.wan_code_revision,
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
                first_session_max_claims=cfg.first_session_max_claims,
            )
            with self.assertRaises(FileNotFoundError):
                RealWanRunner(cfg)

    def test_first_session_claim_limit_counts_failure(self):
        class BrokenRunner:
            def render(self, _job):
                raise RuntimeError("boom")

        with tempfile.TemporaryDirectory() as tmp:
            cfg = config(tmp)
            limited = WorkerConfig(
                supabase_url=cfg.supabase_url,
                supabase_publishable_key=cfg.supabase_publishable_key,
                worker_email=cfg.worker_email,
                worker_password=cfg.worker_password,
                worker_id=cfg.worker_id,
                wan_runner=cfg.wan_runner,
                wan_model_revision=cfg.wan_model_revision,
                wan_code_revision=cfg.wan_code_revision,
                wan_model_dir=cfg.wan_model_dir,
                wan_model_manifest=cfg.wan_model_manifest,
                wan_output_dir=cfg.wan_output_dir,
                wan_width=cfg.wan_width,
                wan_height=cfg.wan_height,
                wan_num_frames=cfg.wan_num_frames,
                wan_inference_steps=cfg.wan_inference_steps,
                wan_guidance_scale=cfg.wan_guidance_scale,
                wan_seed=cfg.wan_seed,
                wan_cpu_offload=cfg.wan_cpu_offload,
                worker_poll_interval_seconds=cfg.worker_poll_interval_seconds,
                worker_lease_seconds=cfg.worker_lease_seconds,
                first_session_max_claims=1,
            )
            fake = FakeSupabase(claim_data=[{"id": "job-3", "user_id": "user-1", "prompt": "make video"}])
            worker = GpuWorker(limited, supabase_client=fake, runner=BrokenRunner(), logger=logging.getLogger("test"))
            self.assertTrue(worker.process_one())
            fake.claim_data = [{"id": "job-4", "user_id": "user-1", "prompt": "second video"}]
            self.assertFalse(worker.process_one())
            claim_calls = [call for call in fake.calls if call[0] == "claim_next_video_job"]
            self.assertEqual(len(claim_calls), 1)

    def test_immutable_batch_never_calls_generic_claim(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = config(tmp)
            batch = WorkerConfig(**{**base.__dict__, "execution_mode": "immutable_batch", "execution_batch_id": "batch-1", "expected_model_key": "video_wan_silent", "expected_gpu_class": "rtx4090", "expected_task_count": 1})
            fake = FakeSupabase(claim_data=[])
            worker = GpuWorker(batch, supabase_client=fake, runner=MockWanRunner(batch), logger=logging.getLogger("test"))
            self.assertFalse(worker.process_one())
            self.assertEqual(fake.calls[0][0], "claim_next_video_job_for_batch")
            self.assertNotIn("claim_next_video_job", [call[0] for call in fake.calls])

    def test_immutable_batch_uses_claim_scoped_lifecycle_rpcs(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = config(tmp)
            batch = WorkerConfig(**{**base.__dict__, "execution_mode": "immutable_batch", "execution_batch_id": "batch-1", "expected_model_key": "video_wan_silent", "expected_gpu_class": "rtx4090", "expected_task_count": 1})
            fake = FakeSupabase(claim_data=[{"id": "job-batch", "user_id": "user-1", "prompt": "make video"}])
            worker = GpuWorker(batch, supabase_client=fake, runner=MockWanRunner(batch), logger=logging.getLogger("test"))
            self.assertTrue(worker.process_one())
            names = [call[0] for call in fake.calls]
            self.assertIn("heartbeat_video_job_for_batch", names)
            self.assertIn("complete_video_job_for_batch", names)
            self.assertNotIn("heartbeat_video_job", names)
            self.assertNotIn("complete_video_job", names)


if __name__ == "__main__":
    unittest.main()
