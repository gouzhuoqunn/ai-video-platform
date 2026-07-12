import path from "node:path";
import { buildSshArgs, type SshTarget } from "./ssh-client";

const ALLOWED_UPLOADS = [
  "gpu-worker/config.py",
  "gpu-worker/healthcheck.py",
  "gpu-worker/security.py",
  "gpu-worker/wan_runner.py",
  "gpu-worker/worker.py",
  "gpu-worker/requirements.txt",
  "scripts/clore/bootstrap-worker.sh",
  "scripts/clore/start-worker.sh",
  "scripts/clore/cleanup-worker.sh",
  ".secrets/gpu-worker.env",
];

export function assertUploadAllowed(relativePath: string) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!ALLOWED_UPLOADS.includes(normalized)) {
    throw new Error(`Refusing to upload non-whitelisted file: ${relativePath}`);
  }
  if (normalized.includes(".env.local") || normalized.includes("clore.env") || normalized.includes(".pem")) {
    throw new Error(`Refusing to upload secret-like file: ${relativePath}`);
  }
}

export function buildWorkerDeploymentPlan(target: SshTarget) {
  for (const item of ALLOWED_UPLOADS) {
    assertUploadAllowed(item);
  }
  const homePrefix = process.env.USERPROFILE || process.env.HOME || "";
  return {
    dry_run: true,
    remote_root: "/workspace/ai-video-platform",
    model_dir: "/workspace/models/Wan2.2-TI2V-5B",
    jobs_dir: "/workspace/jobs",
    logs_dir: "/workspace/logs",
    allowed_uploads: ALLOWED_UPLOADS,
    forbidden_uploads: [".env.local", ".secrets/clore.env", "SSH private keys", "Supabase Secret keys", "local lab credentials", "videos"],
    ssh_args_preview: buildSshArgs(target, "bash /workspace/ai-video-platform/scripts/clore/bootstrap-worker.sh", { requirePrivateKey: false }).map((arg) =>
      homePrefix && arg.includes(homePrefix) ? path.basename(arg) : arg,
    ),
  };
}
