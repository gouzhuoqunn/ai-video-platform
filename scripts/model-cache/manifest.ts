import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WAN_CODE_REVISION, WAN_MODEL_REVISION } from "./model-version";

export type ModelCacheManifestFile = {
  path: string;
  relativePath?: string;
  sizeBytes: number;
  sha256: string;
};

export type ModelCacheManifest = {
  schemaVersion?: 1;
  model?: "Wan-AI/Wan2.2-TI2V-5B";
  modelId?: "Wan-AI/Wan2.2-TI2V-5B";
  modelRepo: "Wan-AI/Wan2.2-TI2V-5B";
  modelRevision?: string;
  runtimeImageDigest?: string;
  wanCodeRevision?: string;
  expectedSizeGb: number;
  generatedAt: string;
  fileCount?: number;
  totalSizeBytes?: number;
  files: ModelCacheManifestFile[];
};

export const MODEL_CACHE_PREFIX = "wan22-ti2v-5b";
export const MODEL_CACHE_FILES_PREFIX = `${MODEL_CACHE_PREFIX}/files/`;
export const MODEL_CACHE_MANIFESTS_PREFIX = `${MODEL_CACHE_PREFIX}/manifests/`;
export const MODEL_CACHE_CURRENT_KEY = `${MODEL_CACHE_PREFIX}/current.json`;
export const MODEL_CACHE_STAGING_PREFIX = `${MODEL_CACHE_PREFIX}/staging/`;

export function buildMockManifest(): ModelCacheManifest {
  const payload = "mock Wan2.2 model cache manifest, no model weights included";
  return {
    schemaVersion: 1,
    model: "Wan-AI/Wan2.2-TI2V-5B",
    modelId: "Wan-AI/Wan2.2-TI2V-5B",
    modelRepo: "Wan-AI/Wan2.2-TI2V-5B",
    modelRevision: "mock-revision",
    runtimeImageDigest: "sha256:fd03ef72d7369f59b3af9e535d9f6a75add9430a5c1ef4e7fd5853be0e4c060a",
    wanCodeRevision: "mock-wan-code-revision",
    expectedSizeGb: 34.2,
    generatedAt: "2026-07-11T00:00:00.000Z",
    fileCount: 1,
    totalSizeBytes: Buffer.byteLength(payload),
    files: [
      {
        path: "README.md",
        relativePath: "README.md",
        sizeBytes: Buffer.byteLength(payload),
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
    ],
  };
}

function listFiles(dir: string, root = dir): ModelCacheManifestFile[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: ModelCacheManifestFile[] = [];
  for (const entry of entries) {
    if (entry.name === "model-cache-manifest.json") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath, root));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const content = readFileSync(fullPath);
    files.push({
      path: path.relative(root, fullPath).replaceAll("\\", "/"),
      relativePath: path.relative(root, fullPath).replaceAll("\\", "/"),
      sizeBytes: statSync(fullPath).size,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function generateManifest(modelDir: string, expectedSizeGb = 34.2): Promise<ModelCacheManifest> {
  if (!existsSync(modelDir)) {
    throw new Error(`Model directory does not exist: ${modelDir}`);
  }
  const files = listFiles(modelDir);
  return {
    schemaVersion: 1,
    model: "Wan-AI/Wan2.2-TI2V-5B",
    modelId: "Wan-AI/Wan2.2-TI2V-5B",
    modelRepo: "Wan-AI/Wan2.2-TI2V-5B",
    modelRevision: process.env.WAN_MODEL_REVISION || WAN_MODEL_REVISION,
    runtimeImageDigest: process.env.CLORE_DOCKER_IMAGE?.split("@")[1] || "unknown",
    wanCodeRevision: process.env.WAN_CODE_REVISION || WAN_CODE_REVISION,
    expectedSizeGb,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files,
  };
}

export function writeManifest(modelDir: string, manifest: ModelCacheManifest) {
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(path.join(modelDir, "model-cache-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function totalManifestBytes(manifest: ModelCacheManifest) {
  return manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

export function validateRelativeModelPath(relativePath: string) {
  if (!relativePath || relativePath.trim() !== relativePath) {
    return "relative path must be non-empty and trimmed";
  }
  if (relativePath.includes("\\")) {
    return "relative path must use forward slashes";
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
    return "relative path must not be absolute";
  }
  if (relativePath.split("/").some((part) => part === ".." || part === "")) {
    return "relative path must not contain traversal or empty segments";
  }
  return null;
}

export function r2FileKey(relativePath: string) {
  const error = validateRelativeModelPath(relativePath);
  if (error) {
    throw new Error(error);
  }
  return `${MODEL_CACHE_FILES_PREFIX}${relativePath}`;
}

export function r2ManifestKey(modelRevision: string) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(modelRevision)) {
    throw new Error("unsafe model revision");
  }
  return `${MODEL_CACHE_MANIFESTS_PREFIX}${modelRevision}.json`;
}

export function validateManifest(manifest: ModelCacheManifest) {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) {
    errors.push("manifest schema_version must be 1");
  }
  if (manifest.modelId && manifest.modelId !== "Wan-AI/Wan2.2-TI2V-5B") {
    errors.push("manifest model_id must target Wan-AI/Wan2.2-TI2V-5B");
  }
  if (manifest.modelRepo !== "Wan-AI/Wan2.2-TI2V-5B") {
    errors.push("manifest must target Wan-AI/Wan2.2-TI2V-5B");
  }
  if (manifest.expectedSizeGb !== 34.2) {
    errors.push("manifest expected size must stay 34.2GB");
  }
  if (manifest.files.length === 0) {
    errors.push("manifest must contain at least one file");
  }
  if (manifest.fileCount !== undefined && manifest.fileCount !== manifest.files.length) {
    errors.push("manifest file count mismatch");
  }
  if (manifest.totalSizeBytes !== undefined && manifest.totalSizeBytes !== totalManifestBytes(manifest)) {
    errors.push("manifest total size mismatch");
  }
  if (manifest.modelRevision !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(manifest.modelRevision)) {
    errors.push("manifest model revision is unsafe");
  }
  if (manifest.runtimeImageDigest !== undefined && !/^sha256:[a-f0-9]{64}$|^unknown$/.test(manifest.runtimeImageDigest)) {
    errors.push("manifest runtime image digest is invalid");
  }
  for (const file of manifest.files) {
    const relativePath = file.relativePath ?? file.path;
    const pathError = validateRelativeModelPath(relativePath);
    if (pathError) {
      errors.push(`unsafe relative path: ${relativePath}`);
    }
    if (file.path !== relativePath && file.relativePath !== undefined) {
      errors.push(`path and relativePath mismatch: ${relativePath}`);
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      errors.push(`invalid sha256 for ${relativePath}`);
    }
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) {
      errors.push(`invalid size for ${relativePath}`);
    }
  }
  return errors;
}
