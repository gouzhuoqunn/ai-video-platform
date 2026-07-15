import assert from "node:assert/strict";
import { sanitizeGpuTarget, type GpuTarget } from "./gpu-first-image";
const target: GpuTarget = { provider: "manual_ssh", host: "gpu.example.test", port: 2222, username: "root", sshKeyPath: "C:\\private-key", gpuProfile: "rtx4090", runtimeDigest: "ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime@sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137" };
const safe = sanitizeGpuTarget(target);
assert.equal(safe.provider, "manual_ssh");
assert.equal(safe.runtime_digest_pinned, true);
assert.equal(safe.ssh_private_key_returned, false);
assert.ok(!JSON.stringify(safe).includes("private-key"));
console.log("Manual SSH GPU adapter tests passed.");
