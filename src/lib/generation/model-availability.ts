import { readFileSync } from "node:fs";
import path from "node:path";

export type ModelAvailability = {
  generationType: "image" | "video";
  modelProfile: string;
  displayName?: string;
  status?: string;
  defaultProduction?: boolean;
  cached: boolean;
  restoreReady: boolean;
  inferenceVerified: boolean;
  validatedFallback: boolean;
  executableWorkflow: boolean;
  currentKey: string;
  revision: string;
  restoreBytes?: number;
  uniqueRestoreBytes?: number;
  sharedBytes?: number;
  updatedAt: string;
};

export type ModelAvailabilityRegistry = {
  schemaVersion: 1 | 2;
  models: ModelAvailability[];
};

export const MODEL_AVAILABILITY_PATH = path.join(process.cwd(), "comfy-runtime", "model-availability.json");

export function loadModelAvailabilityRegistry(filePath = MODEL_AVAILABILITY_PATH): ModelAvailabilityRegistry {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as ModelAvailabilityRegistry;
  if (![1, 2].includes(parsed.schemaVersion) || !Array.isArray(parsed.models)) throw new Error("model_availability_registry_invalid");
  return parsed;
}

export function modelAvailabilityGate(modelProfile: string, registry = loadModelAvailabilityRegistry()) {
  const model = registry.models.find((entry) => entry.modelProfile === modelProfile);
  if (!model) return { allowed: false, reason: `模型配置 ${modelProfile} 尚未登记。`, model: null };
  if (!model.executableWorkflow) return { allowed: false, reason: "当前模型没有可执行工作流，调度器不会创建显卡订单。", model };
  if (!model.restoreReady && !model.validatedFallback) return { allowed: false, reason: "当前模型没有可恢复缓存，也没有经过验证的官方备用下载源。", model };
  return { allowed: true, reason: model.restoreReady ? "模型缓存已验证，可从 R2 恢复。" : "R2 缓存未就绪，将仅允许使用已锁定并验证的官方备用源。", model };
}
