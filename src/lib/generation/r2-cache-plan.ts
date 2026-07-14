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
export const PRODUCTION_CURRENT_JSON_KEYS = [
  "production/rtx4090/image/current.json",
  "production/rtx4090/video/current.json",
  "production/rtx5090/image/current.json",
  "production/rtx5090/video/current.json",
] as const;

export const R2_SHARED_COMPONENT_PREFIXES = ["shared/vae", "shared/text-encoders", "shared/clip-vision", "shared/loras", "workflows", "custom-node-locks"] as const;

export const BENCHMARK_CACHE_LIFECYCLE = {
  rejectedCandidates: "delete staging model objects after the audit record and small metrics are retained",
  benchmarkOutputs: "retain metrics and thumbnails; remove large raw outputs by a future approved retention policy",
  publishRule: "stage files, validate the revision manifest, then publish current.json last",
} as const;

export type CapacityPlan = {
  allBaselinesGb: number;
  verifiedDedupGb: number;
  conservativeCacheGb: number;
  session4090Gb: number;
  session5090Gb: number;
  requiredDisk4090Gb: number;
  requiredDisk5090Gb: number;
  notes: string[];
};

export function withDiskReserve(gb: number) {
  return Math.ceil(gb * 1.2 * 100) / 100;
}

export const FIRST_ROUND_CAPACITY_PLAN: CapacityPlan = {
  allBaselinesGb: 173.93,
  verifiedDedupGb: 0,
  conservativeCacheGb: 173.93,
  session4090Gb: 38.28,
  session5090Gb: 135.65,
  requiredDisk4090Gb: withDiskReserve(38.28),
  requiredDisk5090Gb: withDiskReserve(135.65),
  notes: [
    "Figures are publisher-reported repository totals, not downloaded-byte measurements.",
    "No shared component is deducted until matching content hashes are verified.",
    "The 9B Flux candidate is gated and its auxiliary component inventory is incomplete; these numbers are a conservative registry baseline, not an approval to sync.",
  ],
};

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
  for (const entry of Object.values(manifest.production)) {
    if (entry.manifestKey.startsWith("benchmark-staging/")) errors.push("production manifests must not read benchmark-staging");
  }
  return errors;
}
