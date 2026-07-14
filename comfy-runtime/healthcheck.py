from __future__ import annotations

import json
import os
import sys
import urllib.request


def main() -> int:
    host = os.environ.get("COMFY_CONTROLLER_HOST", "127.0.0.1")
    if host == "0.0.0.0":
        host = "127.0.0.1"
    port = os.environ.get("COMFY_CONTROLLER_PORT", "8080")
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/healthz", timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return 0 if response.status == 200 and payload.get("ok") is True else 1
    except Exception:
        return 1


if __name__ == "__main__":
    sys.exit(main())
