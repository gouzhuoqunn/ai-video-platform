import { readFileSync } from "node:fs";
import path from "node:path";

export const PRODUCTION_IMAGE_MODEL = "ultrareal-flux1-dev-fp8";
export const PRODUCTION_VIDEO_MODEL = "wan22-remix-14b-i2v-fp8";
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
  parallelDownloads: number;
  objects: Array<{ role: string; path: string; source: string; bytes: number; sha256: string }>;
};

type ProductionRegistry = {
  schemaVersion: 1;
  families: ProductionFamily[];
  profiles: Array<{ id: string; familyId: string; gpuClass: string; workflow: string; width?: number; height?: number; frames?: number }>;
};

export function loadProductionModelRegistry(filePath = path.join(process.cwd(), "comfy-runtime", "production-model-registry.json")) {
  const registry = JSON.parse(readFileSync(filePath, "utf8")) as ProductionRegistry;
  if (registry.schemaVersion !== 1 || registry.families.length !== 2 || registry.profiles.length !== 4) throw new Error("production_model_registry_invalid");
  return registry;
}

export function productionModelSummary() {
  return Object.fromEntries(loadProductionModelRegistry().families.map((family) => [family.generationType, {
    modelProfile: family.id,
    displayName: family.displayName,
    cacheStatus: family.status,
    cacheReady: false,
    restoreBytes: family.restoreBytes,
    revision: family.revision,
    gpuProfiles: [...PRODUCTION_GPU_CLASSES],
  }]));
}
