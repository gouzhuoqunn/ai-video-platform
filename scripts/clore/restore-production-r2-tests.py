#!/usr/bin/env python3
"""External-network-free fixtures for the Stage 4J.7 restore transport."""

from __future__ import annotations

import hashlib
import importlib.util
import pathlib
import tempfile
import threading

MODULE_PATH = pathlib.Path(__file__).with_name("restore-production-r2.py")
SPEC = importlib.util.spec_from_file_location("restore_production_r2", MODULE_PATH)
assert SPEC and SPEC.loader
restore = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(restore)
WORKER_SPEC = importlib.util.spec_from_file_location("detached_job_worker", pathlib.Path(__file__).with_name("detached-job-worker.py"))
assert WORKER_SPEC and WORKER_SPEC.loader
worker = importlib.util.module_from_spec(WORKER_SPEC)
WORKER_SPEC.loader.exec_module(worker)


class Headers(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class FakeResponse:
    def __init__(self, payload: bytes, status: int, content_range: str | None = None):
        self.payload = payload
        self.status = status
        self.offset = 0
        self.headers = Headers()
        if content_range:
            self.headers["Content-Range"] = content_range

    def getcode(self):
        return self.status

    def read(self, count=-1):
        if count < 0:
            count = len(self.payload) - self.offset
        value = self.payload[self.offset:self.offset + count]
        self.offset += len(value)
        return value

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeOpener:
    def __init__(self, payload: bytes, ranges_supported: bool):
        self.payload = payload
        self.ranges_supported = ranges_supported
        self.requests: list[str | None] = []
        self.lock = threading.Lock()

    def __call__(self, request, timeout=None):
        del timeout
        range_header = request.headers.get("Range")
        with self.lock:
            self.requests.append(range_header)
        if not range_header:
            return FakeResponse(self.payload, 200)
        if not self.ranges_supported:
            return FakeResponse(self.payload, 200)
        raw = range_header.removeprefix("bytes=")
        start_text, end_text = raw.split("-", 1)
        start = int(start_text)
        end = len(self.payload) - 1 if end_text == "" else int(end_text)
        selected = self.payload[start:end + 1]
        return FakeResponse(selected, 206, f"bytes {start}-{end}/{len(self.payload)}")


def assert_true(value: bool, label: str):
    if not value:
        raise AssertionError(label)


def fixture_file(payload: bytes, sha_override: str | None = None):
    return {
        "path": "diffusion_models/fixture.bin",
        "objectKey": "models/private/fixture.bin",
        "bytes": len(payload),
        "sha256": sha_override or hashlib.sha256(payload).hexdigest(),
    }


def test_exact_ranges():
    ranges = restore.exact_ranges(1_000_003, 8)
    assert_true(len(ranges) == 8, "range_count")
    assert_true(ranges[0][0] == 0 and ranges[-1][1] == 1_000_002, "range_boundaries")
    for left, right in zip(ranges, ranges[1:]):
        assert_true(left[1] + 1 == right[0], "range_gap_or_overlap")


def run_restore_fixture(payload: bytes, ranges_supported: bool, sha_override: str | None = None, seed_resume=False):
    with tempfile.TemporaryDirectory() as raw:
        root = pathlib.Path(raw)
        progress = restore.Progress(root / "progress.json", "fixture")
        progress.set_total(len(payload))
        file = fixture_file(payload, sha_override)
        multistream = {
            "enabled": True,
            "streamsPerLargeObject": 8,
            "minimumStreamsPerObject": 4,
            "maximumStreamsPerObject": 12,
            "maximumTotalStreams": 12,
            "largeObjectThresholdBytes": 1,
            "chunkDirectoryName": ".restore-chunks",
        }
        if seed_resume:
            ranges = restore.exact_ranges(len(payload), 8)
            chunk_root = root / "diffusion_models" / ".restore-chunks"
            chunk_dir = chunk_root / hashlib.sha256(file["objectKey"].encode("utf-8")).hexdigest()[:24]
            chunk_dir.mkdir(parents=True)
            start, end = ranges[0]
            (chunk_dir / f"000-{start}-{end}.part").write_bytes(payload[start:end + 1])
            start, end = ranges[1]
            partial_length = (end - start + 1) // 2
            (chunk_dir / f"001-{start}-{end}.part").write_bytes(payload[start:start + partial_length])
        opener = FakeOpener(payload, ranges_supported)
        original = restore.urllib.request.urlopen
        restore.urllib.request.urlopen = opener
        try:
            result = restore.restore_file(
                file, "https://redacted.invalid/object", root, progress,
                multistream, threading.Semaphore(12))
            target = root / file["path"]
            assert_true(target.read_bytes() == payload, "restored_payload")
            return result, opener.requests
        finally:
            restore.urllib.request.urlopen = original


def test_resume_and_assembly():
    payload = bytes((index * 17) % 251 for index in range(2 * 1024 * 1024 + 31))
    result, requests = run_restore_fixture(payload, True, seed_resume=True)
    assert_true(result["method"] == "parallel_ranges", "parallel_method")
    assert_true(result["reusedBytes"] > 0, "resume_reused_bytes")
    assert_true(all(value and value.startswith("bytes=") for value in requests), "all_parallel_ranges")
    assert_true(len(requests) == 7, "completed_chunk_not_redownloaded")
    assert_true(not any(value.startswith("bytes=0-") for value in requests if value), "completed_first_chunk_not_requested")


def test_range_unsupported_fallback():
    payload = bytes((index * 13) % 239 for index in range(1024 * 1024 + 7))
    result, requests = run_restore_fixture(payload, False)
    assert_true(result["method"] == "single_stream_range_fallback", "range_fallback_method")
    assert_true(any(value is None for value in requests), "fallback_full_get")


def test_sha_failure_cleanup():
    payload = b"stage4j7-sha-fixture" * 65_537
    with tempfile.TemporaryDirectory() as raw:
        root = pathlib.Path(raw)
        progress = restore.Progress(root / "progress.json", "fixture")
        progress.set_total(len(payload))
        file = fixture_file(payload, "0" * 64)
        opener = FakeOpener(payload, True)
        original = restore.urllib.request.urlopen
        restore.urllib.request.urlopen = opener
        try:
            try:
                restore.restore_file(file, "https://redacted.invalid/object", root, progress, {
                    "enabled": True,
                    "streamsPerLargeObject": 8,
                    "minimumStreamsPerObject": 4,
                    "maximumStreamsPerObject": 12,
                    "maximumTotalStreams": 12,
                    "largeObjectThresholdBytes": 1,
                    "chunkDirectoryName": ".restore-chunks",
                }, threading.Semaphore(12))
            except ValueError as error:
                assert_true(str(error).startswith("sha256_mismatch:"), "sha_failure_classification")
            else:
                raise AssertionError("sha_failure_not_raised")
            target = root / file["path"]
            assert_true(not target.exists(), "corrupt_target_removed")
            assert_true(not target.with_suffix(target.suffix + ".part").exists(), "corrupt_assembled_part_removed")
            chunk_root = target.parent / ".restore-chunks"
            assert_true(not any(chunk_root.glob("*")) if chunk_root.exists() else True, "corrupt_chunks_removed")
        finally:
            restore.urllib.request.urlopen = original


def test_log_redaction():
    cleaned = worker.clean(
        "GET https://example.invalid/model?X-Amz-Signature=abc "
        "token=secret password=hunter2 ssh_key=AAA")
    assert_true("X-Amz" not in cleaned, "signed_url_redacted")
    assert_true("hunter2" not in cleaned and "AAA" not in cleaned, "credentials_redacted")


if __name__ == "__main__":
    test_exact_ranges()
    test_resume_and_assembly()
    test_range_unsupported_fallback()
    test_sha_failure_cleanup()
    test_log_redaction()
    print("stage4j7_python_restore_fixtures=passed")
