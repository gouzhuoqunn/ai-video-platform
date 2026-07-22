import { readFileSync } from "node:fs";
import path from "node:path";
import { loadModelAvailabilityRegistry } from "./model-availability";

export const PRODUCTION_IMAGE_MODEL = "ultrareal-flux1-dev-fp8";
export const PRODUCTION_VIDEO_MODEL = "wan22-remix-14b-i2v-fp8";
export const PRODUCTION_NATIVE_AUDIO_MODEL = "ltx23_sulphur_native_audio_fp8";
export const PRODUCTION_GPU_CLASSES = ["rtx4090", "rtx5090"] as const;

type ProductionFamily = {
  id: string;
  generationType: "image" | "video";
  displayName: string;
  adultModel: boolean;
  status: string;
  currentKey: string;
  revision: string;
  restoreBytes: number;
  uniqueRestoreBytes: number;
  sharedBytes: number;
  parallelDownloads: number;
  objects: Array<{ role: string; path: string; source: string; bytes: number; sha256: string }>;
};

type ProductionRegistry = {
  schemaVersion: 1;
  families: ProductionFamily[];
  profiles: Array<{ id: string; familyId: string; gpuClass: string; workflow: string; capabilities: Array<"first_frame_text" | "first_last_frame" | "text_only">; width?: number; height?: number; frames?: number }>;
};

export function loadProductionModelRegistry(filePath = path.join(process.cwd(), "comfy-runtime", "production-model-registry.json")) {
  const registry = JSON.parse(readFileSync(filePath, "utf8")) as ProductionRegistry;
  if (registry.schemaVersion !== 1 || registry.families.length !== 2 || registry.profiles.length !== 4) throw new Error("production_model_registry_invalid");
  return registry;
}

export function productionModelSummary() {
  const availability = new Map(loadModelAvailabilityRegistry().models.map((model) => [model.modelProfile, model]));
  return Object.fromEntries(loadProductionModelRegistry().families.map((family) => [family.generationType, {
    modelProfile: family.id,
    displayName: family.displayName,
    cacheStatus: family.status,
    cacheReady: availability.get(family.id)?.cached === true && availability.get(family.id)?.restoreReady === true,
    inferenceVerified: availability.get(family.id)?.inferenceVerified === true,
    workflowReady: availability.get(family.id)?.executableWorkflow === true,
    currentKey: family.currentKey,
    restoreBytes: family.restoreBytes,
    uniqueRestoreBytes: family.uniqueRestoreBytes,
    sharedBytes: family.sharedBytes,
    revision: family.revision,
    gpuProfiles: [...PRODUCTION_GPU_CLASSES],
    workflowCapabilities: [...new Set(loadProductionModelRegistry().profiles.filter((profile) => profile.familyId === family.id).flatMap((profile) => profile.capabilities))],
  }]));
}
