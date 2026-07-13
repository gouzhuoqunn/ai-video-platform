export type ProductionProfilePath = "rtx4090/image" | "rtx4090/video" | "rtx5090/image" | "rtx5090/video";

export type R2CacheNamespace = "benchmark-staging" | "production" | "shared" | "workflows" | "manifests";

export type R2ProductionManifest = {
  schemaVersion: 1;
  shared: Record<string, { key: string; sha256: string }>;
  production: Record<ProductionProfilePath, { candidateKey: string; manifestKey: string; workflowKey: string }>;
  publishOrder: ["benchmark-staging", "shared", "workflows", "manifests", "current.json"];
};

export const R2_CACHE_NAMESPACES: R2CacheNamespace[] = ["benchmark-staging", "production", "shared", "workflows", "manifests"];
export const PRODUCTION_PROFILE_PATHS: ProductionProfilePath[] = ["rtx4090/image", "rtx4090/video", "rtx5090/image", "rtx5090/video"];

export function buildR2Key(namespace: R2CacheNamespace, relativePath: string) {
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("unsafe R2 cache key path");
  }
  return `${namespace}/${relativePath}`;
}

export function validateProductionManifest(manifest: R2ProductionManifest) {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  const productionKeys = Object.keys(manifest.production).sort();
  const expected = [...PRODUCTION_PROFILE_PATHS].sort();
  if (JSON.stringify(productionKeys) !== JSON.stringify(expected)) errors.push("production must contain exactly four profile pointers");
  for (const [name, shared] of Object.entries(manifest.shared)) {
    if (!name.trim()) errors.push("shared component name is empty");
    if (!shared.key.startsWith("shared/")) errors.push(`shared component ${name} must live under shared/`);
    if (shared.sha256 !== "" && !/^[a-f0-9]{64}$/.test(shared.sha256)) errors.push(`shared component ${name} sha256 is invalid`);
  }
  const sharedKeys = Object.values(manifest.shared).map((entry) => entry.key);
  if (new Set(sharedKeys).size !== sharedKeys.length) errors.push("shared components must be deduplicated by key");
  if (manifest.publishOrder.at(-1) !== "current.json") errors.push("current.json must be published last");
  return errors;
}
