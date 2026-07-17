import { loadR2Credentials, createPresignedGetUrl } from "./r2-presign";
import { buildProductionManifest, loadProductionFamilies } from "./production-model-cache";

export function buildRestoreBundle(familyId: string, expiresSeconds = 7200) {
  const family = loadProductionFamilies().find((entry) => entry.id === familyId);
  if (!family) throw new Error(`unknown_family:${familyId}`);
  const creds = loadR2Credentials("model-cache-readonly.env");
  const manifest = buildProductionManifest(family);
  const manifestKey = `${family.r2Prefix}/manifests/${family.revision}.json`;
  const sign = (key: string) => createPresignedGetUrl({ creds, key, expiresSeconds });
  return {
    schemaVersion: 1,
    familyId,
    expiresSeconds,
    currentUrl: sign(family.currentKey),
    expectedCurrentKey: family.currentKey,
    expectedManifestKey: manifestKey,
    manifestUrl: sign(manifestKey),
    objectUrls: Object.fromEntries(manifest.files.map((file) => [file.objectKey, sign(file.objectKey)])),
    parallelDownloads: family.parallelDownloads,
    destinationRoot: "/workspace/ComfyUI/models",
    progressPath: `/workspace/logs/restore-${familyId}.json`,
    restoreBytes: family.restoreBytes,
    minimumFreeDiskBytes: family.restoreBytes + 10 * 1024 ** 3,
    objectPathMapping: Object.fromEntries(manifest.files.map((file) => [file.objectKey, `/workspace/ComfyUI/models/${file.path}`])),
  };
}

if (process.argv[1]?.endsWith("production-restore-bundle.ts")) {
  const familyId = process.argv[2];
  if (!familyId) throw new Error("usage: production-restore-bundle.ts <family-id>");
  console.log(JSON.stringify(buildRestoreBundle(familyId), null, 2));
}
