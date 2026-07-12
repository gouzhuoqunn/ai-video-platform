import { assertNoSecretOutput } from "../clore/client";
import { loadLocalResultsConfig } from "./config";

function main() {
  const execute = process.argv.includes("--execute");
  if (execute) {
    throw new Error("Remote result cleanup execute mode is intentionally not implemented in this preparation task.");
  }
  const config = loadLocalResultsConfig();
  const output = JSON.stringify(
    {
      dry_run: true,
      deletes_remote_objects: false,
      min_remote_retention_hours: config.minRemoteRetentionHours,
      requires_local_verification_before_future_delete: true,
      deletes_video_jobs_metadata: false,
      deletes_real_users: false,
      deletes_gpu_worker_data: false,
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

void main();
