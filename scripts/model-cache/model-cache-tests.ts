import { readFileSync } from "node:fs";
import path from "node:path";
import { buildModelCachePlan } from "./plan-sync";
import { buildMockManifest, validateManifest } from "./manifest";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const plan = buildModelCachePlan();
  assert(plan.model_repo === "Wan-AI/Wan2.2-TI2V-5B", "fixed model repo must be Wan-AI/Wan2.2-TI2V-5B.");
  assert(plan.model_expected_size_gb === 34.2, "model size budget must be 34.2GB.");
  assert(plan.disk_reservation_gb >= 200, "GPU disk reservation must be at least 200GB.");
  assert(plan.lookup_order.map((entry) => entry.source).join(">") === "current_clore_instance_local_dir>clore_persistent_volume_if_available>cloudflare_r2_private_cache>official_hugging_face_fallback", "cache lookup order changed.");
  assert(plan.rules.model_weights_baked_into_docker_image === false, "model weights must not be baked into the runtime image.");
  assert(plan.rules.r2_write_creds_on_gpu === false, "GPU must not receive R2 write credentials.");

  const manifest = buildMockManifest();
  assert(validateManifest(manifest).length === 0, "mock manifest must validate.");

  const downloadScript = readFileSync(path.join(process.cwd(), "scripts", "model-cache", "r2-download.sh"), "utf8");
  const uploadScript = readFileSync(path.join(process.cwd(), "scripts", "model-cache", "r2-upload.sh"), "utf8");
  assert(downloadScript.includes("--dry-run"), "R2 download helper must default to dry-run.");
  assert(uploadScript.includes("--dry-run"), "R2 upload helper must default to dry-run.");
  assert(!downloadScript.includes("MODEL_CACHE_SECRET_ACCESS_KEY="), "download helper must not contain real secrets.");
  assert(!uploadScript.includes("MODEL_CACHE_SECRET_ACCESS_KEY="), "upload helper must not contain real secrets.");
  console.log("Model cache tests passed.");
}

void main();
