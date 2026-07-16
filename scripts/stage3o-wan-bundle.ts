import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPresignedGetUrl } from "./first-image-colab-bundle";
import { currentKey, finalKey, wanFiles } from "./model-cache/wan-stage3m-cache";
import { loadR2Credentials } from "./model-cache/r2-presign";

export const STAGE3O_WAN_BUNDLE_PATH = path.join(process.cwd(), ".secrets", "stage3o-wan-r2-bundle.json");

export function buildStage3OWanBundle(now = new Date(), expiresSeconds = 7200) {
  const credentials = loadR2Credentials("model-cache-readonly.env");
  return {
    schema_version: 1,
    purpose: "stage3o_wan_readonly_restore",
    generated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + expiresSeconds * 1000).toISOString(),
    current_key: currentKey,
    parallelism: 2,
    files: wanFiles.map((file) => ({ relative_path: file.targetPath, size_bytes: file.sizeBytes, sha256: file.sha256, download_url: createPresignedGetUrl(credentials, finalKey(file), expiresSeconds, now) })),
  };
}

export function writeStage3OWanBundle(filePath = STAGE3O_WAN_BUNDLE_PATH) {
  const bundle = buildStage3OWanBundle();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { filePath, bundle };
}
