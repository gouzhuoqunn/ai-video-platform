import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const supervisor = readFileSync("comfy-runtime/supervisor.py", "utf8");
const dockerfile = readFileSync("comfy-runtime/Dockerfile", "utf8");
const workflow = readFileSync(".github/workflows/comfy-runtime-image.yml", "utf8");

assert.match(dockerfile, /COMFY_RUNTIME_MODE=gpu/);
assert.match(supervisor, /mode not in \{"smoke_cpu", "gpu"\}/);
assert.match(supervisor, /--disable-triton-backend/);
assert.match(supervisor, /--disable-all-custom-nodes/);
assert.match(supervisor, /COMFY_GPU_PROFILE/);
assert.match(supervisor, /gpu_preflight_failed: COMFY_GPU_PROFILE must be rtx4090 or rtx5090/);
assert.match(supervisor, /gpu_preflight_failed: smoke import blocker present in PYTHONPATH/);
assert.match(supervisor, /gpu_preflight_failed: nvidia-smi unavailable/);
assert.match(supervisor, /gpu_preflight_failed: torch cuda unavailable/);
assert.match(supervisor, /supervisor_process_failure/);
assert.match(workflow, /verify-public-digest/);
assert.match(workflow, /runtime-hygiene-gate/);
assert.match(workflow, /DOCKER_CONFIG/);
assert.match(workflow, /COMFY_RUNTIME_MODE=smoke_cpu/);
assert.match(workflow, /COMFY_RUNTIME_MODE=gpu/);
assert.match(workflow, /COMFY_NODE_PROFILE=production_minimal/);
assert.match(workflow, /COMFY_GPU_PROFILE=rtx4090/);
assert.match(workflow, /127\.0\.0\.1:8080:8080/);
assert.ok(!workflow.includes("-p 8188:8188"), "ComfyUI port 8188 must not be published");

console.log("Comfy runtime mode tests passed");
