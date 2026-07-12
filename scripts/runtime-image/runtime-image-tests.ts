import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { checkRuntimeImageFiles } from "./check";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const result = checkRuntimeImageFiles();
  assert(result.runtime_image_ok, "runtime image checks must pass.");
  const workflowPath = path.join(process.cwd(), ".github", "workflows", "runtime-image.yml");
  assert(existsSync(workflowPath), "runtime image GitHub Actions skeleton is required.");
  const workflow = readFileSync(workflowPath, "utf8");
  assert(workflow.includes("workflow_dispatch"), "runtime image workflow must be manually triggered.");
  assert(workflow.includes("packages: write"), "runtime image workflow must be allowed to push GHCR packages.");
  assert(workflow.includes("secrets.GITHUB_TOKEN"), "runtime image workflow must use the repository GITHUB_TOKEN.");
  assert(workflow.includes("push: true"), "runtime image workflow must push only from the manual workflow.");
  assert(workflow.includes("sbom: true"), "runtime image workflow must generate an SBOM.");
  assert(workflow.includes("provenance: true"), "runtime image workflow must enable provenance.");
  assert(workflow.includes("linux/amd64"), "runtime image workflow must build linux/amd64.");
  assert(workflow.includes("gpu-worker/Dockerfile"), "runtime image workflow must build gpu-worker/Dockerfile.");
  assert(workflow.includes("npm run secret:scan"), "runtime image workflow must scan for secrets before building.");
  assert(!workflow.includes(":latest"), "runtime image workflow must not publish latest-only tags.");
  assert(!workflow.includes("SUPABASE_SECRET_KEY"), "workflow must not reference Supabase Secret key.");
  assert(!workflow.includes("CLORE_API_KEY"), "workflow must not reference Clore API key.");
  assert(!workflow.includes("MODEL_CACHE_SECRET_ACCESS_KEY"), "workflow must not reference R2 credentials.");
  console.log("Runtime image tests passed.");
}

void main();
