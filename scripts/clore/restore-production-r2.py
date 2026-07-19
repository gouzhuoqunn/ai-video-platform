#!/usr/bin/env python3
"""Resumable, integrity-checked, multi-stream restore from read-only R2 URLs."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import shutil
import threading
import time
import urllib.error
import urllib.request

CONNECT_TIMEOUT_SECONDS = 30
STALL_TIMEOUT_SECONDS = 120
HEARTBEAT_SECONDS = 5
IO_CHUNK_BYTES = 4 * 1024 * 1024
MAX_ATTEMPTS = 5


class RangeUnsupported(RuntimeError):
    pass


def fetch_json(url: str) -> dict:
    last_error = None
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "ai-video-platform-restore-v2"})
            with urllib.request.urlopen(request, timeout=CONNECT_TIMEOUT_SECONDS) as response:
                return json.load(response)
        except Exception as error:
            last_error = error
            time.sleep(2 ** attempt)
    raise RuntimeError(f"metadata_fetch_failed:{type(last_error).__name__}")


def atomic_json(path: pathlib.Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def sha256_path(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(IO_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def exact_ranges(total_bytes: int, stream_count: int) -> list[tuple[int, int]]:
    if total_bytes <= 0 or stream_count <= 0:
        raise ValueError("range_arguments_invalid")
    count = min(total_bytes, stream_count)
    base, remainder = divmod(total_bytes, count)
    cursor = 0
    ranges = []
    for index in range(count):
        length = base + (1 if index < remainder else 0)
        ranges.append((cursor, cursor + length - 1))
        cursor += length
    if ranges[0][0] != 0 or ranges[-1][1] != total_bytes - 1:
        raise AssertionError("range_coverage_invalid")
    return ranges


def response_status(response) -> int:
    return int(getattr(response, "status", response.getcode()))


def validate_content_range(value: str | None, requested_start: int, requested_end: int) -> None:
    expected = f"bytes {requested_start}-{requested_end}/"
    if not value or not value.startswith(expected):
        raise ValueError("content_range_mismatch")


class Progress:
    def __init__(self, path: pathlib.Path, family_id: str):
        self.path = path
        self.lock = threading.Lock()
        self.started = time.time()
        self.state = {
            "familyId": family_id,
            "status": "restoring",
            "startedAt": self.started,
            "files": {},
            "activeStreams": 0,
            "completedBytes": 0,
            "totalBytes": 0,
            "aggregateBytesPerSecond": 0,
            "etaSeconds": None,
        }

    def set_total(self, total_bytes: int) -> None:
        with self.lock:
            self.state["totalBytes"] = total_bytes
            self._write()

    def stream_delta(self, delta: int) -> None:
        with self.lock:
            self.state["activeStreams"] += delta
            self._recalculate()

    def update_file(self, name: str, detail: dict) -> None:
        with self.lock:
            existing = self.state["files"].get(name, {})
            self.state["files"][name] = {**existing, **detail, "updatedAt": time.time()}
            self._recalculate()

    def heartbeat(self) -> None:
        with self.lock:
            self._recalculate()

    def finish(self, status: str, error: str | None = None) -> None:
        with self.lock:
            self.state["status"] = status
            self.state["completedAt" if status == "completed" else "failedAt"] = time.time()
            if error:
                self.state["error"] = error
            self._write()

    def _recalculate(self) -> None:
        completed = sum(int(item.get("completedBytes", 0)) for item in self.state["files"].values())
        duration = max(0.001, time.time() - self.started)
        rate = completed / duration
        remaining = max(0, int(self.state["totalBytes"]) - completed)
        self.state["completedBytes"] = completed
        self.state["aggregateBytesPerSecond"] = rate
        self.state["etaSeconds"] = remaining / rate if rate > 0 else None
        self.state["heartbeatAt"] = time.time()
        self._write()

    def _write(self) -> None:
        atomic_json(self.path, self.state)


def download_range(
    *,
    url: str,
    chunk_path: pathlib.Path,
    absolute_start: int,
    absolute_end: int,
    progress: Progress,
    file_name: str,
    semaphore: threading.Semaphore,
) -> dict:
    chunk_path.parent.mkdir(parents=True, exist_ok=True)
    expected = absolute_end - absolute_start + 1
    if chunk_path.exists() and chunk_path.stat().st_size > expected:
        chunk_path.unlink()
    initial = chunk_path.stat().st_size if chunk_path.exists() else 0
    retries = 0
    last_error = None
    for attempt in range(MAX_ATTEMPTS):
        present = chunk_path.stat().st_size if chunk_path.exists() else 0
        if present == expected:
            return {"reusedBytes": initial, "transferredBytes": expected - initial, "retries": retries}
        request_start = absolute_start + present
        headers = {
            "User-Agent": "ai-video-platform-restore-v2",
            "Range": f"bytes={request_start}-{absolute_end}",
            "Accept-Encoding": "identity",
        }
        try:
            with semaphore:
                progress.stream_delta(1)
                try:
                    request = urllib.request.Request(url, headers=headers)
                    with urllib.request.urlopen(request, timeout=STALL_TIMEOUT_SECONDS) as response:
                        status = response_status(response)
                        if status != 206:
                            raise RangeUnsupported(f"range_status_{status}")
                        validate_content_range(response.headers.get("Content-Range"), request_start, absolute_end)
                        with chunk_path.open("ab" if present else "wb") as output:
                            while present < expected:
                                data = response.read(min(IO_CHUNK_BYTES, expected - present))
                                if not data:
                                    break
                                output.write(data)
                                present += len(data)
                                progress.update_file(file_name, {
                                    "status": "downloading",
                                    "activeChunk": chunk_path.name,
                                    "retries": retries,
                                })
                finally:
                    progress.stream_delta(-1)
            last_error = None
        except RangeUnsupported:
            raise
        except Exception as error:
            last_error = error
            retries += 1
            progress.update_file(file_name, {"status": "reconnecting", "retries": retries})
            time.sleep(min(16, 2 ** attempt))
    present = chunk_path.stat().st_size if chunk_path.exists() else 0
    if present != expected:
        raise RuntimeError(f"range_reconnect_exhausted:{file_name}:{type(last_error).__name__}")
    return {"reusedBytes": initial, "transferredBytes": expected - initial, "retries": retries}


def chunk_completed_bytes(chunk_dir: pathlib.Path, ranges: list[tuple[int, int]]) -> int:
    total = 0
    for index, (start, end) in enumerate(ranges):
        path = chunk_dir / f"{index:03d}-{start}-{end}.part"
        if path.exists():
            total += min(path.stat().st_size, end - start + 1)
    return total


def assemble_chunks(chunk_dir: pathlib.Path, ranges: list[tuple[int, int]], assembled: pathlib.Path) -> None:
    temporary = assembled.with_suffix(assembled.suffix + ".building")
    temporary.unlink(missing_ok=True)
    with temporary.open("wb") as output:
        for index, (start, end) in enumerate(ranges):
            chunk_path = chunk_dir / f"{index:03d}-{start}-{end}.part"
            expected = end - start + 1
            if not chunk_path.exists() or chunk_path.stat().st_size != expected:
                raise ValueError(f"range_chunk_size_mismatch:{index}")
            with chunk_path.open("rb") as source:
                shutil.copyfileobj(source, output, IO_CHUNK_BYTES)
    os.replace(temporary, assembled)


def legacy_single_stream(file: dict, url: str, target: pathlib.Path, progress: Progress) -> dict:
    expected_size = int(file["bytes"])
    part = target.with_suffix(target.suffix + ".part")
    if part.exists() and part.stat().st_size > expected_size:
        part.unlink()
    initial = part.stat().st_size if part.exists() else 0
    retries = 0
    range_reset_used = False
    for attempt in range(MAX_ATTEMPTS):
        offset = part.stat().st_size if part.exists() else 0
        if offset == expected_size:
            break
        headers = {"User-Agent": "ai-video-platform-restore-v2", "Accept-Encoding": "identity"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=STALL_TIMEOUT_SECONDS) as response:
                status = response_status(response)
                if offset and status != 206:
                    part.unlink(missing_ok=True)
                    raise RangeUnsupported("legacy_resume_range_unsupported")
                with part.open("ab" if offset else "wb") as output:
                    while True:
                        data = response.read(IO_CHUNK_BYTES)
                        if not data:
                            break
                        output.write(data)
                        offset += len(data)
                        progress.update_file(file["path"], {
                            "status": "downloading_single_stream",
                            "completedBytes": offset,
                            "expectedBytes": expected_size,
                            "retries": retries,
                        })
        except RangeUnsupported:
            if offset and not range_reset_used:
                range_reset_used = True
                continue
            raise
        except Exception:
            retries += 1
            time.sleep(min(16, 2 ** attempt))
    if not part.exists() or part.stat().st_size != expected_size:
        raise ValueError(f"size_mismatch:{file['path']}")
    if sha256_path(part) != file["sha256"].lower():
        part.unlink(missing_ok=True)
        raise ValueError(f"sha256_mismatch:{file['path']}")
    os.replace(part, target)
    return {"reusedBytes": initial, "transferredBytes": expected_size - initial, "retries": retries}


def restore_file(
    file: dict,
    url: str,
    root: pathlib.Path,
    progress: Progress,
    multistream: dict,
    semaphore: threading.Semaphore,
) -> dict:
    target = root / file["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    expected_size = int(file["bytes"])
    expected_sha = file["sha256"].lower()
    started = time.time()
    if target.exists() and target.stat().st_size == expected_size and sha256_path(target) == expected_sha:
        result = {
            "status": "verified",
            "completedBytes": expected_size,
            "expectedBytes": expected_size,
            "reusedBytes": expected_size,
            "transferredBytes": 0,
            "method": "existing_verified",
        }
        progress.update_file(file["path"], result)
        return result
    target.unlink(missing_ok=True)

    use_multistream = bool(multistream.get("enabled", True)) and expected_size >= int(
        multistream.get("largeObjectThresholdBytes", 1024 ** 3))
    if not use_multistream:
        stats = legacy_single_stream(file, url, target, progress)
        method = "single_stream"
    else:
        requested = int(multistream.get("streamsPerLargeObject", 8))
        minimum = int(multistream.get("minimumStreamsPerObject", 4))
        maximum = int(multistream.get("maximumStreamsPerObject", 12))
        stream_count = max(minimum, min(maximum, requested))
        ranges = exact_ranges(expected_size, stream_count)
        chunk_root = target.parent / str(multistream.get("chunkDirectoryName", ".restore-chunks"))
        chunk_dir = chunk_root / hashlib.sha256(file["objectKey"].encode("utf-8")).hexdigest()[:24]
        initial = chunk_completed_bytes(chunk_dir, ranges)
        progress.update_file(file["path"], {
            "status": "downloading",
            "completedBytes": initial,
            "expectedBytes": expected_size,
            "streamCount": stream_count,
            "method": "parallel_ranges",
        })
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=stream_count) as pool:
                futures = []
                for index, (start, end) in enumerate(ranges):
                    chunk_path = chunk_dir / f"{index:03d}-{start}-{end}.part"
                    futures.append(pool.submit(
                        download_range,
                        url=url,
                        chunk_path=chunk_path,
                        absolute_start=start,
                        absolute_end=end,
                        progress=progress,
                        file_name=file["path"],
                        semaphore=semaphore,
                    ))
                while futures:
                    done, pending = concurrent.futures.wait(
                        futures, timeout=HEARTBEAT_SECONDS,
                        return_when=concurrent.futures.FIRST_COMPLETED)
                    progress.update_file(file["path"], {
                        "status": "downloading",
                        "completedBytes": chunk_completed_bytes(chunk_dir, ranges),
                        "expectedBytes": expected_size,
                        "streamCount": stream_count,
                        "method": "parallel_ranges",
                    })
                    for future in done:
                        future.result()
                    futures = list(pending)
            assembled = target.with_suffix(target.suffix + ".part")
            assemble_chunks(chunk_dir, ranges, assembled)
            if assembled.stat().st_size != expected_size:
                raise ValueError(f"size_mismatch:{file['path']}")
            if sha256_path(assembled) != expected_sha:
                assembled.unlink(missing_ok=True)
                shutil.rmtree(chunk_dir, ignore_errors=True)
                raise ValueError(f"sha256_mismatch:{file['path']}")
            os.replace(assembled, target)
            shutil.rmtree(chunk_dir, ignore_errors=True)
            stats = {
                "reusedBytes": initial,
                "transferredBytes": expected_size - initial,
                "retries": 0,
            }
            method = "parallel_ranges"
        except RangeUnsupported:
            shutil.rmtree(chunk_dir, ignore_errors=True)
            stats = legacy_single_stream(file, url, target, progress)
            method = "single_stream_range_fallback"

    duration = max(0.001, time.time() - started)
    result = {
        "status": "verified",
        "completedBytes": expected_size,
        "expectedBytes": expected_size,
        **stats,
        "method": method,
        "startedAt": started,
        "completedAt": time.time(),
        "durationSeconds": duration,
        "averageBytesPerSecond": int(stats["transferredBytes"]) / duration,
    }
    progress.update_file(file["path"], result)
    return result


def validate_bundle(bundle: dict) -> None:
    if bundle.get("schemaVersion") not in (1, 2):
        raise ValueError("restore_bundle_schema_invalid")
    if bundle.get("schemaVersion") == 2:
        streams = int(bundle.get("multistream", {}).get("streamsPerLargeObject", 8))
        if streams < 4 or streams > 12:
            raise ValueError("restore_stream_count_out_of_policy")


def load_manifest(bundle: dict) -> dict:
    current = fetch_json(bundle["currentUrl"])
    if current.get("manifestKey") != bundle["expectedManifestKey"]:
        raise ValueError("current_manifest_key_mismatch")
    manifest = fetch_json(bundle["manifestUrl"])
    if manifest.get("familyId") != bundle["familyId"] or manifest.get("revision") != current.get("revision"):
        raise ValueError("manifest_identity_mismatch")
    return manifest


def run(bundle_path: pathlib.Path) -> None:
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    validate_bundle(bundle)
    manifest = load_manifest(bundle)
    progress = Progress(pathlib.Path(bundle["progressPath"]), bundle["familyId"])
    progress.set_total(int(bundle["restoreBytes"]))
    root = pathlib.Path(bundle["destinationRoot"])
    root.mkdir(parents=True, exist_ok=True)
    required_free = int(bundle["minimumFreeDiskBytes"])
    available_free = shutil.disk_usage(root).free
    if available_free < required_free:
        raise RuntimeError(f"insufficient_free_disk:{available_free}:{required_free}")
    multistream = bundle.get("multistream", {"enabled": False})
    semaphore = threading.Semaphore(int(multistream.get("maximumTotalStreams", 12)))
    heartbeat_stop = threading.Event()

    def heartbeat() -> None:
        while not heartbeat_stop.wait(HEARTBEAT_SECONDS):
            progress.heartbeat()

    heartbeat_thread = threading.Thread(target=heartbeat, name="restore-heartbeat", daemon=True)
    heartbeat_thread.start()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=int(bundle["parallelDownloads"])) as pool:
            futures = []
            for file in manifest["files"]:
                url = bundle["objectUrls"].get(file["objectKey"])
                if not url:
                    raise ValueError(f"missing_presigned_object_url:{file['objectKey']}")
                futures.append(pool.submit(restore_file, file, url, root, progress, multistream, semaphore))
            for future in concurrent.futures.as_completed(futures):
                future.result()
        progress.finish("completed")
    except Exception as error:
        progress.finish("failed", f"{type(error).__name__}:{error}")
        raise
    finally:
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=2)


def probe_stream(url: str, start: int, end: int, deadline: float) -> dict:
    requested = end - start + 1
    received = 0
    status = None
    started = time.monotonic()
    request = urllib.request.Request(url, headers={
        "User-Agent": "ai-video-platform-restore-probe-v1",
        "Range": f"bytes={start}-{end}",
        "Accept-Encoding": "identity",
    })
    remaining_timeout = max(1, min(STALL_TIMEOUT_SECONDS, deadline - time.monotonic()))
    with urllib.request.urlopen(request, timeout=remaining_timeout) as response:
        status = response_status(response)
        if status != 206:
            raise RangeUnsupported(f"probe_range_status_{status}")
        validate_content_range(response.headers.get("Content-Range"), start, end)
        while received < requested and time.monotonic() < deadline:
            data = response.read(min(IO_CHUNK_BYTES, requested - received))
            if not data:
                break
            received += len(data)
    return {
        "requestedBytes": requested,
        "receivedBytes": received,
        "durationSeconds": max(0.001, time.monotonic() - started),
        "httpStatus": status,
        "rangeSupported": status == 206,
    }


def run_probe(bundle_path: pathlib.Path) -> dict:
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    validate_bundle(bundle)
    manifest = load_manifest(bundle)
    config = bundle.get("throughputProbe", {})
    object_count = max(2, int(config.get("objectCount", 2)))
    total_bytes = min(512 * 1024 ** 2, max(256 * 1024 ** 2, int(config.get("totalBytes", 384 * 1024 ** 2))))
    stream_count = max(4, min(8, int(config.get("streamCount", 8))))
    deadline_seconds = max(60, min(90, int(config.get("deadlineSeconds", 90))))
    minimum_bytes = int(config.get("minimumObjectBytes", 1024 ** 3))
    selected = sorted(
        (file for file in manifest["files"] if int(file["bytes"]) >= minimum_bytes),
        key=lambda file: int(file["bytes"]),
        reverse=True,
    )[:object_count]
    if len(selected) < 2:
        raise ValueError("probe_requires_two_large_objects")
    per_object = total_bytes // len(selected)
    tasks = []
    deadline = time.monotonic() + deadline_seconds
    probe_started = time.monotonic()
    for object_index, file in enumerate(selected):
        object_budget = min(per_object, int(file["bytes"]))
        ranges = exact_ranges(object_budget, max(2, stream_count // len(selected)))
        url = bundle["objectUrls"].get(file["objectKey"])
        if not url:
            raise ValueError("probe_object_url_missing")
        for start, end in ranges:
            absolute_start = min(int(file["bytes"]) - (end - start + 1), object_index * per_object + start)
            tasks.append((file, url, absolute_start, absolute_start + (end - start)))
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=stream_count) as pool:
        futures = [
            (file, pool.submit(probe_stream, url, start, end, deadline))
            for file, url, start, end in tasks
        ]
        for file, future in futures:
            result = future.result(timeout=deadline_seconds + 10)
            results.append((file, result))
    duration = max(0.001, time.monotonic() - probe_started)
    objects = []
    for file in selected:
        matching = [result for candidate, result in results if candidate["objectKey"] == file["objectKey"]]
        received = sum(int(result["receivedBytes"]) for result in matching)
        requested = sum(int(result["requestedBytes"]) for result in matching)
        object_duration = max((float(result["durationSeconds"]) for result in matching), default=duration)
        objects.append({
            "objectId": hashlib.sha256(file["objectKey"].encode("utf-8")).hexdigest()[:16],
            "requestedBytes": requested,
            "receivedBytes": received,
            "durationSeconds": object_duration,
            "bytesPerSecond": received / max(0.001, object_duration),
            "httpStatuses": sorted(set(int(result["httpStatus"]) for result in matching)),
            "rangeSupported": all(bool(result["rangeSupported"]) for result in matching),
        })
    received_total = sum(int(item["receivedBytes"]) for item in objects)
    aggregate = received_total / duration
    restore_bytes = int(bundle["restoreBytes"])
    gate = bundle.get("qualificationGate", {})
    mib_per_second = aggregate / 1024 ** 2
    if mib_per_second >= 15:
        band, safety = "healthy", 1.2
    elif mib_per_second >= 8:
        band, safety = "acceptable_extended", 1.35
    elif mib_per_second >= 5:
        band, safety = "slow", 1.6
    else:
        band, safety = "inadequate", 2.0
    restore_eta = restore_bytes / max(1, aggregate)
    elapsed = float(gate.get("elapsedSeconds", 0))
    allowance = float(gate.get("fixedAllowanceSeconds", 55 * 60))
    elapsed_after_probe = elapsed + duration
    projected_additional_billing = duration + restore_eta * safety + allowance
    projected_completion = elapsed_after_probe + restore_eta * safety + allowance
    hourly = gate.get("hourlyUsd")
    wallet_spent = float(gate.get("walletSpentUsd", 0))
    wallet_cap = float(gate.get("walletCapUsd", 1.25))
    projected_spend = None if hourly is None else wallet_spent + float(hourly) * projected_additional_billing / 3600
    drain = float(gate.get("drainingAtSeconds", 220 * 60))
    wall = float(gate.get("wallClockCapSeconds", 240 * 60))
    qualification_reason = "restore_gate_passed"
    ranges_accepted = all(item["rangeSupported"] and item["httpStatuses"] == [206] for item in objects)
    if not ranges_accepted:
        qualification_reason = "probe_range_support_failed"
    elif band == "inadequate":
        qualification_reason = "restore_probe_throughput_inadequate"
    elif projected_completion > drain:
        qualification_reason = "restore_does_not_fit_draining_deadline"
    elif projected_completion > wall:
        qualification_reason = "restore_does_not_fit_wall_clock_cap"
    elif projected_spend is None:
        qualification_reason = "hourly_price_missing"
    elif projected_spend > wallet_cap:
        qualification_reason = "restore_does_not_fit_wallet_cap"
    payload = {
        "schemaVersion": 1,
        "familyId": bundle["familyId"],
        "measuredAt": time.time(),
        "durationSeconds": duration,
        "requestedBytes": sum(int(item["requestedBytes"]) for item in objects),
        "receivedBytes": received_total,
        "aggregateBytesPerSecond": aggregate,
        "aggregateMiBPerSecond": mib_per_second,
        "restoreEtaSeconds": restore_eta,
        "objects": objects,
        "allRangesAccepted": ranges_accepted,
        "source": "presigned_readonly_r2_model_objects",
        "qualification": {
            "passed": qualification_reason == "restore_gate_passed",
            "reason": qualification_reason,
            "band": band,
            "safetyMultiplier": safety,
            "guardedRestoreEtaSeconds": restore_eta * safety,
            "fixedAllowanceSeconds": allowance,
            "remainingWallClockSeconds": max(0, min(wall, drain) - elapsed_after_probe),
            "projectedAdditionalBillingSeconds": projected_additional_billing,
            "projectedCompletionSeconds": projected_completion,
            "projectedSpendUsd": projected_spend,
            "remainingWalletUsd": max(0, wallet_cap - wallet_spent),
        },
    }
    result_path = pathlib.Path(config.get("resultPath", "/workspace/logs/restore-probe.json"))
    atomic_json(result_path, payload)
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if args.probe:
        print(json.dumps(run_probe(pathlib.Path(args.bundle)), separators=(",", ":")))
    else:
        run(pathlib.Path(args.bundle))
