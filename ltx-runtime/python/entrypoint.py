from __future__ import annotations

import json
import signal
import sys
from pathlib import Path

from ltx_runtime import LtxRuntimeAdapter


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "health"
    if command == "health":
        print(json.dumps({"status": "ok", "runtime": "stage3a-production-definition", "modelExecution": "requires_explicit_job"}))
        return 0
    if command != "plan" or len(sys.argv) != 3:
        print("usage: entrypoint.py health | plan <manifest.json>", file=sys.stderr)
        return 64
    adapter = LtxRuntimeAdapter(Path(sys.argv[2]), Path("/models"), Path("/work/jobs"), Path("/output"))
    signal.signal(signal.SIGTERM, lambda *_: adapter.cancel())
    try:
        manifest = adapter.load_manifest()
        print(json.dumps({"status": "ready", "modelKey": manifest["modelKey"], "pipeline": manifest["pipeline"]["id"]}))
        return 0
    except Exception as error:  # no prompt or path is emitted
        print(json.dumps({"status": "blocked", "reason": str(error).split(":", 1)[0]}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
