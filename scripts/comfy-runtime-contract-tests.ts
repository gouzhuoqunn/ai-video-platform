import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { COMFYUI_BIND_HOST, COMFYUI_COMMIT, COMFYUI_PORT } from "../src/lib/generation/comfy-runtime";

function read(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function main() {
  assert.equal(COMFYUI_COMMIT, "da2608926eaf68fd532bba4e1ace3402c5d21399");
  assert.equal(COMFYUI_BIND_HOST, "127.0.0.1");
  assert.equal(COMFYUI_PORT, 8188);

  for (const file of [
    "comfy-runtime/Dockerfile",
    "comfy-runtime/entrypoint.sh",
    "comfy-runtime/controller.py",
    "comfy-runtime/healthcheck.py",
    "comfy-runtime/requirements.lock",
    "comfy-runtime/custom-node-locks.json",
    "comfy-runtime/workflows/safe-object-info.json",
    ".github/workflows/comfy-runtime-image.yml",
  ]) {
    assert.equal(existsSync(path.join(process.cwd(), file)), true, `${file} must exist`);
  }

  const dockerfile = read("comfy-runtime/Dockerfile");
  assert.match(dockerfile, /ai-creative-comfy-runtime|COMFYUI_COMMIT|ComfyUI/i);
  assert.match(dockerfile, /sha256:4e3dd6d2610c33ab2b260e970e4a9288043dc2c762cb1b8902b6712cfdfaa96c/);
  assert.ok(!dockerfile.includes("COPY . /app"), "Comfy runtime must not copy the old Wan worker app wholesale");
  assert.ok(!dockerfile.includes("gpu-worker/Dockerfile"), "Comfy runtime must not replace the Wan runtime Dockerfile");
  assert.ok(!/\.secrets|\.env\.local|CLORE_API_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|model-weights/.test(dockerfile));

  const entrypoint = read("comfy-runtime/entrypoint.sh");
  assert.match(entrypoint, /--listen "\$\{COMFYUI_HOST\}"/);
  assert.match(entrypoint, /--models-directory \/workspace\/models/);
  assert.match(entrypoint, /START_GPU_WORKER/);
  assert.ok(!entrypoint.includes("/app/worker.py"), "Comfy entrypoint must not launch the old Worker");
  assert.ok(!entrypoint.includes("0.0.0.0:8188"));

  const controller = read("comfy-runtime/controller.py");
  assert.match(controller, /\/healthz/);
  assert.match(controller, /\/interrupt/);
  assert.match(controller, /\/system_stats/);
  assert.match(controller, /0\.0\.0\.0/);

  const locks = JSON.parse(read("comfy-runtime/custom-node-locks.json"));
  assert.equal(locks.baseRuntimeIncludesCustomNodes, false);
  for (const node of locks.nodes) {
    assert.equal(node.includedInBaseRuntime, false);
    assert.equal(node.compatibilityStatus, "not_installed_pending_lock");
  }

  const workflow = read(".github/workflows/comfy-runtime-image.yml");
  assert.match(workflow, /ai-creative-comfy-runtime/);
  assert.match(workflow, /linux\/amd64/);
  assert.match(workflow, /COMFYUI_EXTRA_ARGS=--cpu/);
  assert.match(workflow, /object_info/);
  assert.match(workflow, /\/interrupt/);
  assert.match(workflow, /START_GPU_WORKER=false/);
  assert.ok(!workflow.includes("context: ./gpu-worker"));
  assert.ok(!workflow.includes(":latest"));

  console.log("Comfy runtime contract tests passed");
}

main();
