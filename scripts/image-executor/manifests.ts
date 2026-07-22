import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const IMAGE_MODEL_FAMILY = "fluxed-up-10.2-rtx4090-text";

export type SourceArtifact = {
  id: string;
  source: "civitai" | "huggingface";
  filename: string;
  runtime_path: string;
  r2_prefix: "fluxed-up-10.2" | "aidma-lora" | "shared-flux-components";
  auth: "civitai_token" | "huggingface_token" | "public";
  auth_env?: "CIVITAI_API_TOKEN" | "HF_TOKEN";
  size_bytes?: number;
  sha256?: string;
  model_id?: number;
  version_id?: number;
  file_id?: number;
  repository?: string;
  revision?: string;
  metadata_only?: boolean;
};

export type SourceAcquisitionManifest = {
  schema: 1;
  family: typeof IMAGE_MODEL_FAMILY;
  mode: "text_generation";
  artifacts: SourceArtifact[];
};

export type RestoreFile = {
  id: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  runtime_path: string;
  cache_object_key: string;
  download_url: string;
};

export type ValidatedRestoreManifest = {
  schema: 1;
  family: typeof IMAGE_MODEL_FAMILY;
  mode: "text_generation";
  files: RestoreFile[];
};

function isSha(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function positiveInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function safeRuntimePath(value: unknown) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("..") && !/[\\]/.test(value);
}

function safeDownloadUrl(value: unknown) {
  return typeof value === "string" && /^https:\/\/[^\s]+$/i.test(value);
}

function parseJson(filePath: string) {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

export function validateSourceAcquisitionManifest(value: unknown): SourceAcquisitionManifest {
  const manifest = value as Partial<SourceAcquisitionManifest>;
  if (!manifest || manifest.schema !== 1 || manifest.family !== IMAGE_MODEL_FAMILY || manifest.mode !== "text_generation" || !Array.isArray(manifest.artifacts)) {
    throw new Error("invalid_source_acquisition_manifest");
  }
  const ids = new Set<string>();
  for (const artifact of manifest.artifacts as SourceArtifact[]) {
    if (!artifact || typeof artifact.id !== "string" || ids.has(artifact.id)) throw new Error("invalid_source_artifact_id");
    ids.add(artifact.id);
    if (!["civitai", "huggingface"].includes(artifact.source)) throw new Error(`invalid_source:${artifact.id}`);
    if (typeof artifact.filename !== "string" || !artifact.filename.trim()) throw new Error(`invalid_filename:${artifact.id}`);
    if (!safeRuntimePath(artifact.runtime_path)) throw new Error(`invalid_runtime_path:${artifact.id}`);
    if (!["fluxed-up-10.2", "aidma-lora", "shared-flux-components"].includes(artifact.r2_prefix)) throw new Error(`invalid_r2_prefix:${artifact.id}`);
    if (!["civitai_token", "huggingface_token", "public"].includes(artifact.auth)) throw new Error(`invalid_auth:${artifact.id}`);
    if (artifact.auth_env !== undefined && !["CIVITAI_API_TOKEN", "HF_TOKEN"].includes(artifact.auth_env)) throw new Error(`invalid_auth_env:${artifact.id}`);
    if (artifact.auth === "civitai_token" && artifact.auth_env !== "CIVITAI_API_TOKEN") throw new Error(`invalid_auth_env:${artifact.id}`);
    if (artifact.auth === "huggingface_token" && artifact.auth_env !== "HF_TOKEN") throw new Error(`invalid_auth_env:${artifact.id}`);
    if (artifact.auth === "public" && artifact.auth_env !== undefined) throw new Error(`invalid_public_auth_env:${artifact.id}`);
    if (artifact.size_bytes !== undefined && !positiveInt(artifact.size_bytes)) throw new Error(`invalid_size:${artifact.id}`);
    if (artifact.sha256 !== undefined && !isSha(artifact.sha256)) throw new Error(`invalid_sha:${artifact.id}`);
    if (artifact.source === "civitai" && (!positiveInt(artifact.model_id) || !positiveInt(artifact.version_id) || !positiveInt(artifact.file_id))) {
      throw new Error(`invalid_civitai_ids:${artifact.id}`);
    }
    if (artifact.source === "huggingface" && (typeof artifact.repository !== "string" || typeof artifact.revision !== "string")) {
      throw new Error(`invalid_huggingface_source:${artifact.id}`);
    }
  }
  for (const required of ["fluxed-up-10.2", "aidma-lora", "flux-vae", "flux-clip-l", "flux-t5xxl-fp8", "flux-tokenizer-config"]) {
    if (!ids.has(required)) throw new Error(`missing_source_artifact:${required}`);
  }
  return manifest as SourceAcquisitionManifest;
}

export function validateValidatedRestoreManifest(value: unknown): ValidatedRestoreManifest {
  const manifest = value as Partial<ValidatedRestoreManifest>;
  if (!manifest || manifest.schema !== 1 || manifest.family !== IMAGE_MODEL_FAMILY || manifest.mode !== "text_generation" || !Array.isArray(manifest.files)) {
    throw new Error("invalid_restore_manifest");
  }
  const ids = new Set<string>();
  for (const file of manifest.files as RestoreFile[]) {
    if (!file || typeof file.id !== "string" || ids.has(file.id)) throw new Error("invalid_restore_file_id");
    ids.add(file.id);
    if (typeof file.filename !== "string" || !file.filename.trim()) throw new Error(`invalid_restore_filename:${file.id}`);
    if (!positiveInt(file.size_bytes)) throw new Error(`invalid_restore_size:${file.id}`);
    if (!isSha(file.sha256)) throw new Error(`invalid_restore_sha:${file.id}`);
    if (!safeRuntimePath(file.runtime_path)) throw new Error(`invalid_restore_runtime_path:${file.id}`);
    if (!safeRuntimePath(file.cache_object_key)) throw new Error(`invalid_restore_cache_key:${file.id}`);
    if (!safeDownloadUrl(file.download_url)) throw new Error(`invalid_restore_download_url:${file.id}`);
  }
  return manifest as ValidatedRestoreManifest;
}

export function readSourceAcquisitionManifest(filePath: string) {
  return validateSourceAcquisitionManifest(parseJson(filePath));
}

export function readValidatedRestoreManifest(filePath: string) {
  return validateValidatedRestoreManifest(parseJson(filePath));
}

export function sha256File(filePath: string) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

export function buildValidatedRestoreManifestFromFiles(input: { source: SourceAcquisitionManifest; downloadedRoot: string }): ValidatedRestoreManifest {
  return validateValidatedRestoreManifest({
    schema: 1,
    family: IMAGE_MODEL_FAMILY,
    mode: "text_generation",
    files: input.source.artifacts
      .filter((artifact) => !artifact.metadata_only)
      .map((artifact) => {
        const filePath = path.join(input.downloadedRoot, artifact.runtime_path);
        if (!existsSync(filePath)) throw new Error(`downloaded_file_missing:${artifact.id}`);
        const size = statSync(filePath).size;
        if (artifact.size_bytes !== undefined && artifact.size_bytes !== size) throw new Error(`downloaded_size_mismatch:${artifact.id}`);
        const sha256 = sha256File(filePath);
        if (artifact.sha256 !== undefined && artifact.sha256 !== sha256) throw new Error(`downloaded_sha_mismatch:${artifact.id}`);
        return {
          id: artifact.id,
          filename: artifact.filename,
          size_bytes: size,
          sha256,
          runtime_path: artifact.runtime_path,
          cache_object_key: `${artifact.r2_prefix}/${artifact.filename}`,
          download_url: `https://cache.invalid/${artifact.r2_prefix}/${encodeURIComponent(artifact.filename)}`,
        };
      }),
  });
}
