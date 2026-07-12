import { MODEL_CACHE_CURRENT_KEY, MODEL_CACHE_PREFIX, buildMockManifest, validateManifest } from "../model-cache/manifest";
import { buildWorkerDeploymentPlan } from "./deploy-worker";
import type { SshTarget } from "./ssh-client";

export function buildFirstGpuSessionPlan(target: SshTarget) {
  const manifest = buildMockManifest();
  const manifestErrors = validateManifest(manifest);
  const deployment = buildWorkerDeploymentPlan(target);
  return {
    dry_run: true,
    real_ssh_connected: false,
    real_model_downloaded: false,
    real_worker_started: false,
    first_session_mode: true,
    max_auto_jobs_before_pause: 1,
    steps: [
      "verify RTX 5090 with nvidia-smi",
      "verify CUDA/PyTorch/Python/ffmpeg/git",
      "verify disk and RAM",
      "install runtime dependencies",
      "download Wan-AI/Wan2.2-TI2V-5B from official Hugging Face only",
      "generate model manifest and SHA-256 summary",
      "seed private R2 cache through controller-signed short-lived upload URLs",
      "start limited gpu_worker",
      "process first synthetic text job",
      "pause for user video inspection",
    ],
    deployment,
    model_cache_seed: {
      required_before_real_create: true,
      status_gate_script: "npm run model-cache:seed:test",
      cache_prefix: MODEL_CACHE_PREFIX,
      current_manifest_key: MODEL_CACHE_CURRENT_KEY,
      presigned_put_supported: true,
      multipart_upload_supported: true,
      admin_credentials_uploaded: false,
      gpu_credentials_file: ".secrets/model-cache-readonly.env",
      signed_urls_logged_or_returned_to_browser: false,
      real_model_uploaded_in_tests: false,
    },
    mock_model_manifest_valid: manifestErrors.length === 0,
    records_without_sensitive_prompt: [
      "model download duration",
      "environment install duration",
      "worker startup duration",
      "inference duration",
      "upload duration",
      "peak VRAM/RAM",
      "output file size",
      "estimated GPU cost",
    ],
  };
}

function main() {
  const plan = buildFirstGpuSessionPlan({ host: "127.0.0.1", port: 2222, user: "root" });
  console.log(JSON.stringify(plan, null, 2));
}

if (process.argv[1]?.endsWith("first-gpu-session.ts")) {
  main();
}
