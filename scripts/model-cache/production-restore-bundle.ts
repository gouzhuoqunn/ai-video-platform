import { loadR2Credentials, createPresignedGetUrl } from "./r2-presign";
import { readPublishedProductionManifest } from "./production-model-cache";

export async function buildRestoreBundle(familyId: string, expiresSeconds = 7200) {
  const { family, current, manifest } = await readPublishedProductionManifest(familyId);
  const creds = loadR2Credentials("model-cache-readonly.env");
  const sign = (key: string) => createPresignedGetUrl({ creds, key, expiresSeconds });
  const sharedFiles = manifest.files.filter((file) => file.shared);
  return {
    schemaVersion: 1,
    familyId,
    expiresSeconds,
    currentUrl: sign(family.currentKey),
    expectedCurrentKey: family.currentKey,
    expectedManifestKey: current.manifestKey,
    manifestUrl: sign(current.manifestKey),
    objectUrls: Object.fromEntries(manifest.files.map((file) => [file.objectKey, sign(file.objectKey)])),
    parallelDownloads: family.parallelDownloads,
    destinationRoot: "/workspace/ComfyUI/models",
    progressPath: `/workspace/logs/restore-${familyId}.json`,
    restoreBytes: family.restoreBytes,
    uniqueBytes: manifest.files.filter((file) => !file.shared).reduce((total, file) => total + file.bytes, 0),
    sharedBytes: sharedFiles.reduce((total, file) => total + file.bytes, 0),
    sharedObjectKeys: sharedFiles.map((file) => file.objectKey),
    minimumFreeDiskBytes: family.restoreBytes + 10 * 1024 ** 3,
    objectPathMapping: Object.fromEntries(manifest.files.map((file) => [file.objectKey, `/workspace/ComfyUI/models/${file.path}`])),
  };
}

if (process.argv[1]?.endsWith("production-restore-bundle.ts")) {
  const familyId = process.argv[2];
  if (!familyId) throw new Error("usage: production-restore-bundle.ts <family-id>");
  void buildRestoreBundle(familyId).then((bundle) => console.log(JSON.stringify(bundle, null, 2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
