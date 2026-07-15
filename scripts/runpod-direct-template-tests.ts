import assert from "node:assert/strict";
import { buildRunPodDirectTemplatePayload, RUNPOD_DIRECT_LAUNCH_MODE, RUNPOD_DIRECT_SSH_COMMAND } from "./gpu-providers/runpod";
import { FIXED_RUNTIME_DIGEST } from "./gpu-providers/common";

const payload = buildRunPodDirectTemplatePayload({ sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFN0YWdlM0tEcnlLZXk stage3k" });
assert.equal(RUNPOD_DIRECT_LAUNCH_MODE, "runpod_direct_template");
assert.equal(payload.imageName, FIXED_RUNTIME_DIGEST);
assert.equal(payload.containerDiskInGb, 50);
assert.equal(payload.volumeInGb, 30);
assert.equal(payload.volumeMountPath, "/workspace");
assert.deepEqual(payload.ports, ["22/tcp", "8080/http"]);
assert.deepEqual(payload.dockerEntrypoint, ["/bin/bash", "-lc"]);
for (const marker of ["id -u", "apt-get update", "openssh-server", "/root/.ssh", "/run/sshd", "authorized_keys", "chmod 0600", "PasswordAuthentication no", "sshd -D -e"]) assert.ok(RUNPOD_DIRECT_SSH_COMMAND.includes(marker), marker);
for (const forbidden of ["PRIVATE KEY", "R2_SECRET", "RUNPOD_API_KEY", "SUPABASE", "8188", "ComfyUI", "comfy-runtime/entrypoint"]) assert.ok(!JSON.stringify(payload).includes(forbidden), forbidden);
console.log("RunPod direct-template SSH bootstrap tests passed.");
