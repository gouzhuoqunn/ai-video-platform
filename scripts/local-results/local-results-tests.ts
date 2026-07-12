import { readFileSync } from "node:fs";
import { buildLocalResultsPlan } from "./plan";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const plan = buildLocalResultsPlan();
  assert(plan.library_dir.endsWith("AI-Video-Library"), "default local video library must be D:\\AI-Video-Library.");
  assert(plan.structure.videoPath.endsWith("output.mp4"), "local archive must use output.mp4.");
  assert(plan.structure.metadataPath.endsWith("metadata.json"), "local archive must write metadata.json.");
  assert(plan.structure.thumbnailPath.endsWith("thumbnail.jpg"), "local archive must write thumbnail.jpg.");
  assert(plan.cleanup_policy.default_dry_run === true, "remote cleanup must default to dry-run.");
  assert(plan.cleanup_policy.execute_flag_required === true, "remote cleanup must require --execute.");
  assert(plan.cleanup_policy.min_remote_retention_hours >= 24, "remote video objects must be retained for at least 24h.");
  assert(plan.local_serving.remote_host_access === false, "local file serving must not be exposed to remote hosts.");

  const cleanupScript = readFileSync("scripts/local-results/cleanup-remote.ts", "utf8");
  assert(cleanupScript.includes("execute mode is intentionally not implemented") || cleanupScript.includes("intentionally not implemented"), "cleanup execute mode must be blocked in this prep task.");
  const localResultsHelper = readFileSync("src/lib/local-lab/local-results.ts", "utf8");
  const resultsRoute = readFileSync("src/app/api/local-lab/results/route.ts", "utf8");
  const videoRoute = readFileSync("src/app/api/local-lab/results/[jobId]/video/route.ts", "utf8");
  const thumbnailRoute = readFileSync("src/app/api/local-lab/results/[jobId]/thumbnail/route.ts", "utf8");
  assert(localResultsHelper.includes("JOB_ID_PATTERN"), "local results helper must validate job ids.");
  assert(localResultsHelper.includes("path.relative"), "local results helper must prevent directory traversal.");
  assert(!localResultsHelper.includes("absolutePath"), "local results helper must not return absolute paths to the browser.");
  assert(resultsRoute.includes("guardLocalLabRequest"), "local results listing must be loopback protected.");
  assert(videoRoute.includes("range"), "local video route must support Range requests.");
  assert(videoRoute.includes("content-range"), "local video route must return Content-Range for partial video reads.");
  assert(thumbnailRoute.includes("guardLocalLabRequest"), "thumbnail route must be loopback protected.");
  console.log("Local results tests passed.");
}

void main();
