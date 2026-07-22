import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildValidatedRestoreManifestFromFiles,
  readSourceAcquisitionManifest,
  readValidatedRestoreManifest,
  validateSourceAcquisitionManifest,
  validateValidatedRestoreManifest,
  type SourceAcquisitionManifest,
  type ValidatedRestoreManifest,
} from "./manifests";

export type BootstrapDeps = {
  downloadArtifact?: (artifact: SourceAcquisitionManifest["artifacts"][number], destination: string) => Promise<void>;
  uploadCache?: (manifest: ValidatedRestoreManifest, downloadedRoot: string) => Promise<void>;
  publishCurrentRestoreManifest?: (manifest: ValidatedRestoreManifest) => Promise<void>;
};

export async function resolveImageRestoreManifest(input: {
  restoreManifestPath: string;
  sourceManifestPath: string;
  workspaceDir: string;
  deps?: BootstrapDeps;
}) {
  if (existsSync(input.restoreManifestPath)) {
    return readValidatedRestoreManifest(input.restoreManifestPath);
  }

  const source = readSourceAcquisitionManifest(input.sourceManifestPath);
  const deps = input.deps ?? {};
  if (!deps.downloadArtifact || !deps.uploadCache || !deps.publishCurrentRestoreManifest) {
    throw new Error("validated_restore_manifest_missing_and_bootstrap_not_configured");
  }

  mkdirSync(input.workspaceDir, { recursive: true });
  for (const artifact of source.artifacts.filter((item) => !item.metadata_only)) {
    const destination = path.join(input.workspaceDir, artifact.runtime_path);
    mkdirSync(path.dirname(destination), { recursive: true });
    await deps.downloadArtifact(artifact, destination);
  }
  const validated = buildValidatedRestoreManifestFromFiles({ source, downloadedRoot: input.workspaceDir });
  await deps.uploadCache(validated, input.workspaceDir);
  await deps.publishCurrentRestoreManifest(validated);
  writeFileSync(input.restoreManifestPath, JSON.stringify(validated, null, 2), "utf8");
  return validateValidatedRestoreManifest(validated);
}

export function validateImageSourceManifest(value: unknown) {
  return validateSourceAcquisitionManifest(value);
}
