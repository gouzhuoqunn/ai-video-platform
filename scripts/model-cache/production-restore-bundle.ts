import { loadR2Credentials, createPresignedGetUrl } from "./r2-presign";
import { readPublishedProductionManifest } from "./production-model-cache";

export async function buildRestoreBundle(familyId: string, expiresSeconds = 7200) {
  const { family, current, manifest } = await readPublishedProductionManifest(familyId);
  const creds = loadR2Credentials("model-cache-readonly.env");
  const sign = (key: string) => createPresignedGetUrl({ creds, key, expiresSeconds });
  const sharedFiles = manifest.files.filter((file) => file.shared);
  return {
    schemaVersion: 2,
    familyId,
    expiresSeconds,
    currentUrl: sign(family.currentKey),
    expectedCurrentKey: family.currentKey,
    expectedManifestKey: current.manifestKey,
    manifestUrl: sign(current.manifestKey),
    objectUrls: Object.fromEntries(manifest.files.map((file) => [file.objectKey, sign(file.objectKey)])),
    parallelDownloads: Math.max(1, Math.min(3, family.parallelDownloads)),
    multistream: {
      enabled: true,
      streamsPerLargeObject: 8,
      minimumStreamsPerObject: 4,
      maximumStreamsPerObject: 12,
      maximumTotalStreams: 12,
      largeObjectThresholdBytes: 1024 ** 3,
      chunkDirectoryName: ".restore-chunks",
    },
    throughputProbe: {
      objectCount: 2,
      totalBytes: 384 * 1024 ** 2,
      streamCount: 8,
      deadlineSeconds: 90,
      minimumObjectBytes: 1024 ** 3,
      resultPath: `/workspace/logs/restore-probe-${familyId}.json`,
    },
    qualificationGate: {
      hourlyUsd: null as number | null,
      walletSpentUsd: 0,
      walletCapUsd: 1.25,
      elapsedSeconds: 0,
      fixedAllowanceSeconds: 55 * 60,
      wallClockCapSeconds: 240 * 60,
      drainingAtSeconds: 220 * 60,
    },
    destinationRoot: "/workspace/models",
    progressPath: `/workspace/logs/restore-${familyId}.json`,
    restoreBytes: family.restoreBytes,
    uniqueBytes: manifest.files.filter((file) => !file.shared).reduce((total, file) => total + file.bytes, 0),
    sharedBytes: sharedFiles.reduce((total, file) => total + file.bytes, 0),
    sharedObjectKeys: sharedFiles.map((file) => file.objectKey),
    minimumFreeDiskBytes: family.restoreBytes + 10 * 1024 ** 3,
    objectPathMapping: Object.fromEntries(manifest.files.map((file) => [file.objectKey, `/workspace/models/${file.path}`])),
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
