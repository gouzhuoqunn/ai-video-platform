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
    "comfy-runtime/supervisor.py",
    "comfy-runtime/launch_comfy.py",
    "comfy-runtime/controller.py",
    "comfy-runtime/healthcheck.py",
    "comfy-runtime/requirements.lock",
    "comfy-runtime/custom-node-locks.json",
    "comfy-runtime/node-profiles/production-minimal.json",
    "comfy-runtime/smoke_import_blocker/triton/__init__.py",
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
  assert.match(entrypoint, /supervisor\.py/);
  assert.ok(!entrypoint.includes("/app/worker.py"), "Comfy entrypoint must not launch the old Worker");
  assert.ok(!entrypoint.includes("0.0.0.0:8188"));

  const supervisor = read("comfy-runtime/supervisor.py");
  assert.match(supervisor, /START_GPU_WORKER/);
  assert.match(supervisor, /COMFY_RUNTIME_MODE/);
  assert.match(supervisor, /COMFY_NODE_PROFILE/);
  assert.match(supervisor, /smoke_cpu/);
  assert.match(supervisor, /SMOKE_IMPORT_BLOCKER/);
  assert.match(supervisor, /--disable-triton-backend/);
  assert.match(supervisor, /--disable-all-custom-nodes/);
  assert.match(supervisor, /gpu_preflight_failed/);
  assert.match(supervisor, /--models-directory/);

  const launcher = read("comfy-runtime/launch_comfy.py");
  assert.match(launcher, /production_minimal/);
  assert.match(launcher, /init_profile_builtin_extra_nodes/);
  assert.match(launcher, /async def load_profile_builtin_extra_nodes/);
  assert.match(launcher, /await nodes_module\.load_custom_node/);
  assert.match(launcher, /PROFILE_BUILTIN_EXTRA_FAILURES=0/);
  assert.match(launcher, /PROFILE_REQUIRED_NODE_CLASSES_OK/);
  assert.match(launcher, /enable_args_parsing/);
  assert.match(launcher, /comfy_cpu_state=CPU/);

  const extrasExtractor = read("comfy-runtime/extras_extractor.py");
  assert.match(extrasExtractor, /ast\.AsyncFunctionDef/);
  assert.match(extrasExtractor, /extract_builtin_extra_files/);

  const profileAudit = read("comfy-runtime/profile_audit.py");
  assert.match(profileAudit, /missingRequiredNodeClasses/);
  assert.match(profileAudit, /NODE_CLASS_MAPPINGS/);
  assert.match(profileAudit, /dependencyAudit/);
  assert.match(profileAudit, /nodes_post_processing\.py/);

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
  assert.match(workflow, /COMFY_RUNTIME_MODE=smoke_cpu/);
  assert.match(workflow, /COMFY_NODE_PROFILE=production_minimal/);
  assert.match(workflow, /runtime-hygiene-gate/);
  assert.match(workflow, /database_preflight_ok/);
  assert.match(workflow, /gpu_preflight_failed/);
  assert.match(workflow, /object_info/);
  assert.match(workflow, /\/interrupt/);
  assert.match(workflow, /START_GPU_WORKER=false/);
  assert.ok(!workflow.includes("context: ./gpu-worker"));
  assert.ok(!workflow.includes(":latest"));

  console.log("Comfy runtime contract tests passed");
}

main();
