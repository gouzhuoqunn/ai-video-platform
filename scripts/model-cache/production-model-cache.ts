import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ProductionObject = {
  role: string;
  path: string;
  source: string;
  bytes: number;
  sha256: string;
  sourceModelId?: number;
  sourceVersionId?: number;
  sourceFileId?: number;
};

export type ProductionFamily = {
  id: string;
  r2Prefix: string;
  currentKey: string;
  revision: string;
  restoreBytes: number;
  parallelDownloads: number;
  objects: ProductionObject[];
};

export type ProductionManifest = {
  schemaVersion: 1;
  familyId: string;
  revision: string;
  generatedAt: string;
  totalSizeBytes: number;
  files: Array<ProductionObject & { objectKey: string }>;
};

export function loadProductionFamilies(filePath = path.join(process.cwd(), "comfy-runtime", "production-model-registry.json")) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { families: ProductionFamily[] };
  return parsed.families;
}

export function buildProductionManifest(family: ProductionFamily, generatedAt = new Date().toISOString()): ProductionManifest {
  const files = family.objects.map((object) => ({ ...object, objectKey: `${family.r2Prefix}/objects/${object.sha256}` }));
  const totalSizeBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (totalSizeBytes !== family.restoreBytes) throw new Error(`restore_size_mismatch:${family.id}`);
  return { schemaVersion: 1, familyId: family.id, revision: family.revision, generatedAt, totalSizeBytes, files };
}

export function buildCurrentPointer(family: ProductionFamily, manifest: ProductionManifest) {
  return {
    schemaVersion: 1,
    familyId: family.id,
    revision: family.revision,
    manifestKey: `${family.r2Prefix}/manifests/${family.revision}.json`,
    manifestSha256Required: true,
    publishedAt: manifest.generatedAt,
  };
}

export function productionPublishPlan(family: ProductionFamily) {
  const manifest = buildProductionManifest(family);
  return {
    familyId: family.id,
    uploadOrder: [
      ...manifest.files.map((file) => ({ kind: "object", key: file.objectKey, verify: ["HEAD:size", "Range:bytes=0-0"] })),
      { kind: "manifest", key: `${family.r2Prefix}/manifests/${family.revision}.json`, verify: ["HEAD:size", "GET:sha256"] },
      { kind: "current", key: family.currentKey, verify: ["HEAD:size", "GET:json"] },
    ],
    currentPublishedLast: true,
    immutableObjects: true,
  };
}

export function assertProductionCredentialGate(env = process.env) {
  const token = env.CIVITAI_API_TOKEN?.trim();
  if (!token) throw new Error("CIVITAI_API_TOKEN_missing_download_and_dispatch_blocked");
  return token;
}

if (process.argv[1]?.endsWith("production-model-cache.ts")) {
  const command = process.argv[2] ?? "plan";
  const families = loadProductionFamilies();
  if (command === "credential-gate") {
    assertProductionCredentialGate();
    console.log(JSON.stringify({ ok: true }));
  } else if (command === "plan") {
    console.log(JSON.stringify(families.map(productionPublishPlan), null, 2));
  } else if (command === "emit") {
    const family = families.find((entry) => entry.id === process.argv[3]);
    const output = process.argv[4];
    if (!family || !output) throw new Error("usage: production-model-cache.ts emit <family-id> <output-dir>");
    const manifest = buildProductionManifest(family);
    const current = buildCurrentPointer(family, manifest);
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(path.join(output, "current.json"), `${JSON.stringify(current, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ manifestKey: current.manifestKey, currentKey: family.currentKey }));
  } else {
    throw new Error(`unsupported_command:${command}`);
  }
}
