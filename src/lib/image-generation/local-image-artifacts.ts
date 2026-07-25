import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

export type LocalArtifactReference = {
  relativeDir: string;
  pngSha256: string;
  pngBytes: number;
  width: number;
  height: number;
  completedAt: string;
};

export type ImageArtifactTask = {
  id: string;
  prompt: string;
  mode: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  loraStrength: number;
  seed: number;
  sampler: string;
};

export function imageLibraryRoot(root = process.env.AI_IMAGE_LIBRARY_ROOT) {
  return path.resolve(root || "D:\\AI-Video-Library\\images");
}

function assertTaskId(taskId: string) {
  if (!TASK_ID.test(taskId)) throw new Error("invalid_image_task_id");
  return taskId.toLowerCase();
}

function digest(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function writeAtomic(filePath: string, data: Buffer | string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = openSync(temporary, "w");
  try {
    if (typeof data === "string") writeSync(descriptor, data);
    else writeSync(descriptor, data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, filePath);
}

function assertRelativeDir(relativeDir: string, taskId: string) {
  const normalized = relativeDir.replace(/\\/g, "/");
  if (!/^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}$/i.test(normalized) || !normalized.endsWith(`/${assertTaskId(taskId)}`)) {
    throw new Error("invalid_local_artifact_reference");
  }
  return normalized;
}

function resolveArtifactDir(root: string, reference: LocalArtifactReference, taskId: string) {
  const relative = assertRelativeDir(reference.relativeDir, taskId);
  const directory = path.resolve(root, ...relative.split("/"));
  if (path.relative(root, directory).startsWith("..") || path.isAbsolute(path.relative(root, directory))) throw new Error("artifact_path_outside_library");
  return directory;
}

function existingReference(root: string, taskId: string): LocalArtifactReference | null {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const metadataPath = path.join(root, entry.name, taskId, "metadata.json");
    if (!existsSync(metadataPath)) continue;
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      if (metadata.task_id === taskId && typeof metadata.png_sha256 === "string" && typeof metadata.png_byte_size === "number" && typeof metadata.width === "number" && typeof metadata.height === "number" && typeof metadata.completed_at === "string") {
        return { relativeDir: `${entry.name}/${taskId}`, pngSha256: metadata.png_sha256, pngBytes: metadata.png_byte_size, width: metadata.width, height: metadata.height, completedAt: metadata.completed_at };
      }
    } catch { throw new Error("local_artifact_metadata_invalid"); }
  }
  return null;
}

export async function verifyPublishedLocalImageArtifact(input: { taskId: string; artifact: LocalArtifactReference; root?: string }): Promise<LocalArtifactReference> {
  const taskId = assertTaskId(input.taskId);
  const root = imageLibraryRoot(input.root);
  const directory = resolveArtifactDir(root, input.artifact, taskId);
  const metadataPath = path.join(directory, "metadata.json");
  const outputPath = path.join(directory, "output.png");
  const thumbnailPath = path.join(directory, "thumbnail.webp");
  if (!existsSync(metadataPath) || !existsSync(outputPath) || !existsSync(thumbnailPath)) throw new Error("local_artifact_incomplete");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  const bytes = readFileSync(outputPath);
  const image = await sharp(bytes).metadata();
  if (metadata.task_id !== taskId || metadata.png_sha256 !== digest(bytes) || metadata.png_byte_size !== bytes.length || image.format !== "png" || image.width !== input.artifact.width || image.height !== input.artifact.height || metadata.width !== image.width || metadata.height !== image.height || metadata.png_sha256 !== input.artifact.pngSha256 || metadata.png_byte_size !== input.artifact.pngBytes || !SHA256.test(String(metadata.png_sha256))) {
    throw new Error("local_artifact_verification_failed");
  }
  return { relativeDir: input.artifact.relativeDir, pngSha256: String(metadata.png_sha256), pngBytes: bytes.length, width: image.width, height: image.height, completedAt: String(metadata.completed_at) };
}

export async function publishLocalImageArtifact(input: {
  task: ImageArtifactTask;
  png: Buffer;
  remote: { generationDurationSeconds: number; orderId: string; gpuModel: string; controllerPromptId: string | null };
  root?: string;
}): Promise<LocalArtifactReference> {
  const taskId = assertTaskId(input.task.id);
  const root = imageLibraryRoot(input.root);
  const image = await sharp(input.png).metadata();
  if (image.format !== "png" || image.width !== input.task.width || image.height !== input.task.height) throw new Error("png_dimension_mismatch");
  const pngSha256 = digest(input.png);
  const existing = existingReference(root, taskId);
  if (existing) {
    const verified = await verifyPublishedLocalImageArtifact({ taskId, artifact: existing, root });
    if (verified.pngSha256 !== pngSha256) throw new Error("local_artifact_conflict");
    return verified;
  }
  const date = new Date().toISOString().slice(0, 10);
  const reference: LocalArtifactReference = { relativeDir: `${date}/${taskId}`, pngSha256, pngBytes: input.png.length, width: image.width, height: image.height, completedAt: new Date().toISOString() };
  const directory = resolveArtifactDir(root, reference, taskId);
  const metadataPath = path.join(directory, "metadata.json");
  if (existsSync(directory)) throw new Error("local_artifact_incomplete_conflict");
  mkdirSync(directory, { recursive: true });
  const outputPath = path.join(directory, "output.png");
  const thumbnailPath = path.join(directory, "thumbnail.webp");
  writeAtomic(outputPath, input.png);
  const thumbnailTemp = `${thumbnailPath}.${process.pid}.${Date.now()}.tmp`;
  await sharp(input.png).resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(thumbnailTemp);
  renameSync(thumbnailTemp, thumbnailPath);
  const metadata = {
    task_id: taskId,
    prompt: input.task.prompt,
    mode: input.task.mode,
    model_filenames: { transformer: "fluxedUpFluxNSFW_102BF16.safetensors", lora: "aidmaNSFWunlock-FLUX-V0.2.safetensors", vae: "ae.safetensors", clip_l: "clip_l.safetensors", t5: "t5xxl_fp8_e4m3fn_scaled.safetensors" },
    width: image.width,
    height: image.height,
    steps: input.task.steps,
    cfg: input.task.cfg,
    lora_strength: input.task.loraStrength,
    seed: input.task.seed,
    sampler: input.task.sampler,
    png_byte_size: input.png.length,
    png_sha256: pngSha256,
    remote_generation_duration_seconds: input.remote.generationDurationSeconds,
    order_id: input.remote.orderId,
    gpu_model: input.remote.gpuModel,
    controller_prompt_id: input.remote.controllerPromptId,
    completed_at: reference.completedAt,
  };
  writeAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return await verifyPublishedLocalImageArtifact({ taskId, artifact: reference, root });
}

export function localArtifactFile(input: { taskId: string; artifact: LocalArtifactReference; kind: "output" | "thumbnail"; root?: string }) {
  const directory = resolveArtifactDir(imageLibraryRoot(input.root), input.artifact, input.taskId);
  return path.join(directory, input.kind === "output" ? "output.png" : "thumbnail.webp");
}
