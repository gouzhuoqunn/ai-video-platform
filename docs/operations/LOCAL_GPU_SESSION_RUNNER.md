# Local GPU session runner

Start normally through `tools/launcher/PlatformLauncher.ps1 start`. It starts the loopback Next app and `npm run gpu:session-runner:start` without creating an order.

Runner commands are `start`, `status`, `recover` and `stop`. State, PID and bounded status are kept only below `.secrets/gpu-session-runner`. A start intent is idempotent; runner candidate discovery is read-only unless all server-only execution guards are explicitly enabled.
