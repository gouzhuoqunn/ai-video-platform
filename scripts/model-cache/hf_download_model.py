#!/usr/bin/env python3
"""Download one locked FLUX model through the official Hugging Face client."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


MODELS = {
    "qwen": {
        "repo": "Comfy-Org/vae-text-encorder-for-flux-klein-4b",
        "revision": "a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246",
        "filename": "split_files/text_encoders/qwen_3_4b.safetensors",
        "size": 8_044_982_048,
        "sha256": "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
    },
    "vae": {
        "repo": "Comfy-Org/vae-text-encorder-for-flux-klein-4b",
        "revision": "a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246",
        "filename": "split_files/vae/flux2-vae.safetensors",
        "size": 336_211_292,
        "sha256": "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
    },
}


def cache_progress(cache_dir: Path, expected_size: int) -> tuple[int, int]:
    largest = 0
    total = 0
    if cache_dir.exists():
        for item in cache_dir.rglob("*"):
            try:
                if item.is_file() and not item.is_symlink():
                    size = item.stat().st_size
                    total += size
                    largest = max(largest, size)
            except FileNotFoundError:
                continue
    return min(max(largest, total), expected_size), total


def should_fallback(last_change_at: float, now: float, stall_seconds: int, mode: str) -> bool:
    return mode == "xet" and now - last_change_at >= stall_seconds


def terminate_process(process: subprocess.Popen[str]) -> None:
    process.terminate()
    try:
        process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def worker(args: argparse.Namespace) -> int:
    from huggingface_hub import hf_hub_download

    model = MODELS[args.model]
    result = hf_hub_download(
        repo_id=model["repo"],
        revision=model["revision"],
        filename=model["filename"],
        cache_dir=args.cache_dir,
    )
    Path(args.result_file).write_text(json.dumps({"path": result}), encoding="utf-8")
    return 0


def run_download(args: argparse.Namespace) -> Path:
    model = MODELS[args.model]
    cache_dir = Path(args.cache_dir).resolve()
    cache_dir.mkdir(parents=True, exist_ok=True)
    result_file = cache_dir / "download-result.json"
    result_file.unlink(missing_ok=True)
    started = time.monotonic()
    deadline = started + args.max_minutes * 60
    stall_seconds = args.stall_minutes * 60
    modes = ["xet", "http"]

    print(json.dumps({
        "huggingface_hub_version": importlib.metadata.version("huggingface_hub"),
        "hf_xet_version": importlib.metadata.version("hf_xet"),
        "model": args.model,
        "expected_size": model["size"],
    }))

    for mode in modes:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("hf_download_deadline_exceeded")
        env = os.environ.copy()
        env.update({
            "HF_HOME": str(cache_dir),
            "HF_XET_HIGH_PERFORMANCE": "1",
            "HF_HUB_DOWNLOAD_TIMEOUT": "120",
            "HF_HUB_ETAG_TIMEOUT": "30",
            "HF_XET_CHUNK_CACHE_SIZE_BYTES": "0",
        })
        if mode == "http":
            env["HF_HUB_DISABLE_XET"] = "1"
        else:
            env.pop("HF_HUB_DISABLE_XET", None)
        result_file.unlink(missing_ok=True)
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--worker",
            "--model",
            args.model,
            "--cache-dir",
            str(cache_dir),
            "--result-file",
            str(result_file),
        ]
        process = subprocess.Popen(command, env=env, text=True)
        fallback_requested = False
        last_progress = -1
        last_change_at = time.monotonic()
        last_log_at = 0.0
        while process.poll() is None:
            now = time.monotonic()
            current, cache_bytes = cache_progress(cache_dir, int(model["size"]))
            if current != last_progress:
                last_progress = current
                last_change_at = now
            if now - last_log_at >= 60:
                disk = shutil.disk_usage(cache_dir)
                print(json.dumps({
                    "stage": "hf_download",
                    "mode": mode,
                    "current_bytes": current,
                    "cache_bytes": cache_bytes,
                    "ratio": round(current / int(model["size"]), 6),
                    "disk_free_bytes": disk.free,
                    "elapsed_seconds": round(now - started, 1),
                }), flush=True)
                last_log_at = now
            if now >= deadline:
                terminate_process(process)
                raise RuntimeError("hf_download_deadline_exceeded")
            if should_fallback(last_change_at, now, stall_seconds, mode):
                print(json.dumps({"stage": "hf_download", "mode": mode, "fallback": "ordinary_http", "reason": "no_byte_progress"}), flush=True)
                terminate_process(process)
                fallback_requested = True
                break
            time.sleep(5)
        if fallback_requested:
            continue
        if process.returncode == 0 and result_file.is_file():
            downloaded = Path(json.loads(result_file.read_text(encoding="utf-8"))["path"]).resolve()
            if not downloaded.is_file() or cache_dir not in downloaded.parents:
                raise RuntimeError("hf_download_returned_unsafe_path")
            if downloaded.stat().st_size != model["size"]:
                raise RuntimeError("hf_download_size_mismatch")
            print(json.dumps({"stage": "hf_download", "mode": mode, "complete": True, "size": downloaded.stat().st_size}), flush=True)
            return downloaded
        if mode == "xet":
            print(json.dumps({"stage": "hf_download", "mode": mode, "fallback": "ordinary_http", "reason": f"worker_exit_{process.returncode}"}), flush=True)
            continue
        raise RuntimeError(f"hf_http_download_failed:{process.returncode}")
    raise RuntimeError("hf_download_failed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--model", choices=sorted(MODELS), required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--result-file", default="")
    parser.add_argument("--github-output", default="")
    parser.add_argument("--max-minutes", type=int, default=25)
    parser.add_argument("--stall-minutes", type=int, default=10)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.worker:
        return worker(args)
    downloaded = run_download(args)
    if args.github_output:
        with Path(args.github_output).open("a", encoding="utf-8") as output:
            output.write(f"model_path={downloaded}\n")
    print(json.dumps({"download_complete": True, "model": args.model, "path": str(downloaded)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
