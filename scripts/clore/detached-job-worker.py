#!/usr/bin/env python3
"""Detached canary/restore worker with atomic state and heartbeat evidence."""
from __future__ import annotations
import argparse, json, os, pathlib, re, signal, subprocess, sys, time

stop_requested = False

def atomic(path: pathlib.Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)

def clean(value: object) -> str:
    text = str(value)
    text = re.sub(r"https://[^\s\"']+\?[^\s\"']+", "<redacted-url>", text)
    return text[-2000:]

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--mode", choices=("canary", "restore"), required=True)
    parser.add_argument("--bundle")
    parser.add_argument("--restore-script", default="/workspace/tools/restore-production-r2.py")
    args = parser.parse_args()
    root = pathlib.Path(args.job_dir)
    root.mkdir(parents=True, exist_ok=True)
    pid_path, state_path = root / "worker.pid", root / "state.json"
    heartbeat_path, result_path = root / "heartbeat.json", root / "result.json"
    started = time.time()
    pid_path.write_text(f"{os.getpid()}\n", encoding="utf-8")
    state = {"job_id": args.job_id, "pid": os.getpid(), "phase": "running",
             "current_object": None, "completed_bytes": 0,
             "total_bytes": 90 if args.mode == "canary" else 0,
             "last_heartbeat_at": started, "started_at": started,
             "completed_at": None, "exit_code": None, "sanitized_error": None}

    def update() -> None:
        state["last_heartbeat_at"] = time.time()
        atomic(state_path, state)
        atomic(heartbeat_path, {"job_id": args.job_id, "pid": os.getpid(),
                                "at": state["last_heartbeat_at"],
                                "completed_bytes": state["completed_bytes"]})

    def stop(_signum, _frame) -> None:
        global stop_requested
        stop_requested = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    update()
    child = None
    try:
        if args.mode == "canary":
            for elapsed in range(0, 91, 10):
                state["completed_bytes"] = elapsed
                state["current_object"] = "detached-canary"
                update()
                if stop_requested: raise InterruptedError("canary_canceled")
                if elapsed < 90: time.sleep(10)
        else:
            if not args.bundle: raise ValueError("restore_bundle_missing")
            bundle = json.loads(pathlib.Path(args.bundle).read_text(encoding="utf-8"))
            state["total_bytes"] = int(bundle["restoreBytes"])
            progress_path = pathlib.Path(bundle["progressPath"])
            child = subprocess.Popen([sys.executable, args.restore_script, "--bundle", args.bundle],
                                     stdin=subprocess.DEVNULL)
            while child.poll() is None:
                if stop_requested:
                    child.terminate()
                    raise InterruptedError("restore_canceled")
                if progress_path.exists():
                    progress = json.loads(progress_path.read_text(encoding="utf-8"))
                    files = progress.get("files", {})
                    state["completed_bytes"] = sum(int(item.get("completedBytes", 0)) for item in files.values())
                    active = [name for name, item in files.items() if item.get("status") != "verified"]
                    state["current_object"] = active[0] if active else None
                update()
                time.sleep(10)
            if child.returncode != 0:
                raise RuntimeError(f"restore_exit_{child.returncode}")
            state["completed_bytes"] = state["total_bytes"]
        state.update(phase="completed", completed_at=time.time(), exit_code=0)
        atomic(result_path, {"job_id": args.job_id, "ok": True, "completed_at": state["completed_at"]})
        update()
        return 0
    except InterruptedError as error:
        state.update(phase="canceled", completed_at=time.time(), exit_code=130, sanitized_error=clean(error))
        update()
        return 130
    except Exception as error:
        state.update(phase="failed", completed_at=time.time(),
                     exit_code=child.returncode if child and child.returncode is not None else 1,
                     sanitized_error=clean(f"{type(error).__name__}:{error}"))
        atomic(result_path, {"job_id": args.job_id, "ok": False, "error": state["sanitized_error"]})
        update()
        return int(state["exit_code"] or 1)

if __name__ == "__main__":
    raise SystemExit(main())
