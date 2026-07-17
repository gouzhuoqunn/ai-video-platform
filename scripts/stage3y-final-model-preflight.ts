import { readFileSync } from "node:fs";
import path from "node:path";
import { loadModelAvailabilityRegistry } from "../src/lib/generation/model-availability";
import { loadProductionModelRegistry, PRODUCTION_GPU_CLASSES } from "../src/lib/generation/production-models";

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");
const registry = loadProductionModelRegistry();
const availability = loadModelAvailabilityRegistry();
const restoreSource = read("scripts/clore/restore-production-r2.py");
const controllerSource = read("scripts/clore/production-r2-restore.ts");

const requiredRestoreMarkers = [
  "ThreadPoolExecutor",
  "heartbeatAt",
  "STALL_TIMEOUT_SECONDS",
  "reconnecting",
  ".part",
  "os.replace",
  "size_mismatch",
  "sha256_mismatch",
];
for (const marker of requiredRestoreMarkers) {
  if (!restoreSource.includes(marker)) throw new Error(`restore_marker_missing:${marker}`);
}
if (!controllerSource.includes("nohup") || controllerSource.includes("spawnSync")) throw new Error("restore_controller_not_async_direct");

const familyById = new Map(registry.families.map((family) => [family.id, family]));
for (const profile of registry.profiles) {
  const family = familyById.get(profile.familyId);
  if (!family) throw new Error(`profile_family_missing:${profile.id}`);
  if (!PRODUCTION_GPU_CLASSES.includes(profile.gpuClass as (typeof PRODUCTION_GPU_CLASSES)[number])) throw new Error(`profile_gpu_invalid:${profile.id}`);
  const workflow = JSON.parse(read(profile.workflow)) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  if (family.generationType === "image") {
    if (!Object.values(workflow).some((node) => node.class_type === "DualCLIPLoader")) throw new Error(`image_dual_clip_missing:${profile.id}`);
    if (!Object.values(workflow).some((node) => node.class_type === "FluxGuidance")) throw new Error(`image_guidance_missing:${profile.id}`);
  } else {
    if (Object.values(workflow).filter((node) => node.class_type === "UNETLoader").length !== 2) throw new Error(`video_expert_pair_missing:${profile.id}`);
    if (!Object.values(workflow).some((node) => node.class_type === "WanImageToVideo")) throw new Error(`video_i2v_node_missing:${profile.id}`);
  }
}

const hardware = (JSON.parse(read("comfy-runtime/production-model-registry.json")) as { hardwarePolicy: { gpuClasses: string[]; minimumRamGb: number; minimumDiskGb: number; onDemandOnly: boolean } }).hardwarePolicy;
if (hardware.gpuClasses.join(",") !== "rtx4090,rtx5090" || hardware.minimumRamGb !== 32 || hardware.minimumDiskGb !== 200 || !hardware.onDemandOnly) {
  throw new Error("final_hardware_policy_invalid");
}

for (const family of registry.families) {
  if (![3, 4].includes(family.parallelDownloads)) throw new Error(`parallel_download_invalid:${family.id}`);
  if (family.objects.some((object) => !/^(diffusion_models|text_encoders|vae)\//.test(object.path))) throw new Error(`comfy_path_invalid:${family.id}`);
}

const cacheByProfile = new Map(availability.models.map((model) => [model.modelProfile, model]));
const image = familyById.get("ultrareal-flux1-dev-fp8")!;
const video = familyById.get("wan22-remix-14b-i2v-fp8")!;
const cacheReady = [image, video].every((family) => cacheByProfile.get(family.id)?.restoreReady === true);
const minimumRequiredDiskBytes = Math.max(image.restoreBytes, video.restoreBytes) + 10 * 1024 ** 3;
const uniqueRestoreBytes = image.uniqueRestoreBytes + video.uniqueRestoreBytes;
const sharedRestoreBytes = image.sharedBytes + video.sharedBytes;
const lastVerifiedCloreThroughputBytesPerSecond = 12_451_817_860 / (1_086_080 / 1000);
const expectedRestoreMinutes = (image.restoreBytes + video.restoreBytes) / lastVerifiedCloreThroughputBytesPerSecond / 60;

console.log(JSON.stringify({
  ultrareal_workflow_ready: true,
  wan_remix_i2v_workflow_ready: true,
  production_r2_direct_restore_contract_ready: true,
  final_model_session_ready: cacheReady,
  final_model_session_blocker: cacheReady ? null : "production_r2_cache_not_published",
  hardware_policy: { gpu_classes: hardware.gpuClasses, minimum_ram_gb: 32, maximum_ram_gb: null, minimum_disk_gb: 200, on_demand_only: true },
  restore: {
    ultrareal_bytes: image.restoreBytes,
    wan_remix_bytes: video.restoreBytes,
    unique_restore_bytes: uniqueRestoreBytes,
    shared_restore_bytes: sharedRestoreBytes,
    sequential_minimum_free_disk_bytes: minimumRequiredDiskBytes,
    last_verified_clore_throughput_bytes_per_second: Math.round(lastVerifiedCloreThroughputBytesPerSecond),
    expected_restore_minutes: Number(expectedRestoreMinutes.toFixed(1)),
    image_parallel_downloads: image.parallelDownloads,
    video_parallel_downloads: video.parallelDownloads,
  },
}, null, 2));
