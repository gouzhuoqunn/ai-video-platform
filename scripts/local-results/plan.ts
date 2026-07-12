import { assertNoSecretOutput } from "../clore/client";
import { buildLocalJobPaths, loadLocalResultsConfig } from "./config";

export function buildLocalResultsPlan() {
  const config = loadLocalResultsConfig();
  return {
    dry_run: true,
    library_dir: config.libraryDir,
    structure: buildLocalJobPaths(config.libraryDir, "YYYY-MM-DD", "job_id"),
    sync_flow: [
      "Query local_tester succeeded jobs only.",
      "Request a short signed URL without printing it.",
      "Download to output.mp4.part.",
      "Verify size/hash when available.",
      "Atomically rename to output.mp4.",
      "Write metadata.json and thumbnail.jpg.",
      "Mark local sync success.",
    ],
    cleanup_policy: {
      default_dry_run: true,
      execute_flag_required: true,
      min_remote_retention_hours: config.minRemoteRetentionHours,
      deletes_video_jobs_metadata: false,
      deletes_real_users: false,
      deletes_gpu_worker_data: false,
    },
    local_serving: {
      allowed_host: "127.0.0.1/localhost only",
      remote_host_access: false,
      history_statuses: ["local", "cloud", "both", "archive"],
    },
  };
}

function main() {
  const output = JSON.stringify(buildLocalResultsPlan(), null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

if (process.argv[1]?.endsWith("plan.ts")) {
  main();
}
