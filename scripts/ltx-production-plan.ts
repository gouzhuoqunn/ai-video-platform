import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

type Manifest = { modelKey: string; manifestSha256: string; executableStatus: string; blockerReason?: string; immutableRevision: string | null; files: Array<{ path: string; sizeBytes: number | null; sha256: string | null; required: boolean }>; cacheNamespace: string; compatibility: { required: string[]; unresolved: string[] } };
const manifestDir = path.join(process.cwd(), "ltx-runtime", "manifests", "production");
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "manifestSha256").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  return value;
}
const canonical = (value: Record<string, unknown>) => JSON.stringify(normalize(value));
export const manifestSha256 = (value: Record<string, unknown>) => createHash("sha256").update(canonical(value)).digest("hex");
export function buildLtxProductionPlan() {
  const manifests = readdirSync(manifestDir).filter((file) => file.endsWith(".json")).sort().map((file) => JSON.parse(readFileSync(path.join(manifestDir, file), "utf8")) as Manifest);
  const invalid = manifests.filter((manifest) => manifest.manifestSha256 !== manifestSha256(manifest as unknown as Record<string, unknown>)).map((manifest) => manifest.modelKey);
  const selected = manifests.find((manifest) => manifest.modelKey === "sulphur2_distilled_fp8");
  const blocked = !selected || selected.executableStatus !== "executable" || !selected.immutableRevision || selected.files.some((file) => file.required && (!file.sha256 || !file.sizeBytes));
  return {
    dry_run: true,
    provider_calls: 0,
    model_downloads: 0,
    inference_submissions: 0,
    cache_mutations: 0,
    selected_candidate: selected?.modelKey ?? null,
    status: blocked || invalid.length ? "blocked" : "ready",
    reason: invalid.length ? "manifest_integrity_failure" : selected?.blockerReason ?? "selected_candidate_not_executable",
    invalid_manifest_keys: invalid,
    cache_prefixes: manifests.map((manifest) => manifest.cacheNamespace.replace("<manifest-sha256>", manifest.manifestSha256)),
    required_evidence: selected?.compatibility.required ?? [],
    unresolved: selected?.compatibility.unresolved ?? [],
  };
}
if (process.argv[1]?.endsWith("ltx-production-plan.ts")) console.log(JSON.stringify(buildLtxProductionPlan(), null, 2));
