import assert from "node:assert/strict";
import { buildProviderDryRun } from "./gpu-first-image";
import { sanitizeGpuTarget, FIXED_RUNTIME_DIGEST } from "./gpu-providers/common";
import type { GpuTarget } from "./gpu-providers/types";

const target: GpuTarget = { provider: "manual_ssh", host: "gpu.example.test", port: 2222, username: "root", sshKeyPath: "C:\\private-key", gpuProfile: "rtx4090", runtimeDigest: FIXED_RUNTIME_DIGEST };
const safe = sanitizeGpuTarget(target);
assert.equal(safe.provider, "manual_ssh");
assert.equal(safe.runtime_digest_pinned, true);
assert.equal(safe.ssh_private_key_returned, false);
assert.ok(!JSON.stringify(safe).includes("private-key"));
async function main() {
  const runpod = await buildProviderDryRun("runpod");
  assert.equal(runpod.create_session_called, false);
  assert.deepEqual((runpod.payload as { ports: string[] }).ports, ["22/tcp", "8080/http"]);
  assert.ok(!(runpod.payload as { ports: string[] }).ports.some((port) => port.startsWith("8188/")));
  console.log("Unified GPU first-image provider dry-run tests passed.");
}
void main();
