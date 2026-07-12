import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ModelCacheManifestFile = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type ModelCacheManifest = {
  model?: "Wan-AI/Wan2.2-TI2V-5B";
  modelRepo: "Wan-AI/Wan2.2-TI2V-5B";
  expectedSizeGb: number;
  generatedAt: string;
  files: ModelCacheManifestFile[];
};

export function buildMockManifest(): ModelCacheManifest {
  const payload = "mock Wan2.2 model cache manifest, no model weights included";
  return {
    model: "Wan-AI/Wan2.2-TI2V-5B",
    modelRepo: "Wan-AI/Wan2.2-TI2V-5B",
    expectedSizeGb: 34.2,
    generatedAt: "2026-07-11T00:00:00.000Z",
    files: [
      {
        path: "README.md",
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
  return {
    model: "Wan-AI/Wan2.2-TI2V-5B",
    modelRepo: "Wan-AI/Wan2.2-TI2V-5B",
    expectedSizeGb,
    generatedAt: new Date().toISOString(),
    files: listFiles(modelDir),
  };
}

export function writeManifest(modelDir: string, manifest: ModelCacheManifest) {
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(path.join(modelDir, "model-cache-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function totalManifestBytes(manifest: ModelCacheManifest) {
  return manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

export function validateManifest(manifest: ModelCacheManifest) {
  const errors: string[] = [];
  if (manifest.modelRepo !== "Wan-AI/Wan2.2-TI2V-5B") {
    errors.push("manifest must target Wan-AI/Wan2.2-TI2V-5B");
  }
  if (manifest.expectedSizeGb !== 34.2) {
    errors.push("manifest expected size must stay 34.2GB");
  }
  if (manifest.files.length === 0) {
    errors.push("manifest must contain at least one file");
  }
  for (const file of manifest.files) {
    if (file.path.startsWith("/") || file.path.includes("..")) {
      errors.push(`unsafe relative path: ${file.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      errors.push(`invalid sha256 for ${file.path}`);
    }
  }
  return errors;
}
