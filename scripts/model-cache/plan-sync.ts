import { assertNoSecretOutput } from "../clore/client";
import { loadModelCacheConfig } from "./config";

export function buildModelCachePlan() {
  const config = loadModelCacheConfig();
  return {
    dry_run: true,
    model_repo: config.officialRepo,
    model_expected_size_gb: config.expectedSizeGb,
    disk_reservation_gb: 200,
    lookup_order: [
      { step: 1, source: "current_clore_instance_local_dir", path: config.localDir },
      { step: 2, source: "clore_persistent_volume_if_available", path: config.volumeDir },
      { step: 3, source: "cloudflare_r2_private_cache", enabled: config.provider === "r2" && config.r2Enabled, bucket_configured: Boolean(config.bucket), prefix: config.prefix },
      { step: 4, source: "official_hugging_face_fallback", enabled: config.hfFallbackEnabled, repo: config.officialRepo },
    ],
    rules: {
      model_weights_baked_into_docker_image: false,
      clore_volume_required: false,
      r2_write_creds_on_gpu: false,
      gpu_gets_read_only_model_cache_creds_only: true,
      fallback_when_clore_volume_missing: "use R2 cache, then official Hugging Face fallback when explicitly allowed",
    },
  };
}

function main() {
  const output = JSON.stringify(buildModelCachePlan(), null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

if (process.argv[1]?.endsWith("plan-sync.ts")) {
  main();
}
