import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { assertNoSecretOutput } from "../clore/client";
import { buildMockManifest, totalManifestBytes, validateManifest, type ModelCacheManifest } from "./manifest";

function getArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readManifest() {
  const file = getArg("manifest");
  if (!file || process.argv.includes("--mock")) {
    return buildMockManifest();
  }
  return JSON.parse(readFileSync(file, "utf8")) as ModelCacheManifest;
}

function main() {
  const manifest = readManifest();
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`Model cache manifest verification failed:\n${errors.join("\n")}`);
  }

  const output = JSON.stringify(
    {
      verified: true,
      model_repo: manifest.modelRepo,
      expected_size_gb: manifest.expectedSizeGb,
      file_count: manifest.files.length,
      manifest_bytes: totalManifestBytes(manifest),
      uses_real_r2: false,
      downloads_model_weights: false,
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

export async function verifyModelCache(modelDir: string): Promise<{ ok: boolean; errors: string[]; checkedFiles: number }> {
  const manifestPath = path.join(modelDir, "model-cache-manifest.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: ["missing model-cache-manifest.json"], checkedFiles: 0 };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ModelCacheManifest;
  const errors = validateManifest(manifest);
  let checkedFiles = 0;
  for (const file of manifest.files) {
    const fullPath = path.join(modelDir, file.path);
    if (!existsSync(fullPath)) {
      errors.push(`missing file: ${file.path}`);
      continue;
    }
    const actualSize = statSync(fullPath).size;
    if (actualSize !== file.sizeBytes) {
      errors.push(`size mismatch: ${file.path}`);
    }
    const actualSha = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
    if (actualSha !== file.sha256) {
      errors.push(`sha256 mismatch: ${file.path}`);
    }
    checkedFiles += 1;
  }
  return { ok: errors.length === 0, errors, checkedFiles };
}

if (process.argv[1]?.endsWith("verify.ts")) {
  main();
}
