import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

export type PersistedImageResult = {
  imagePath: string;
  thumbnailPath: string;
  sha256: string;
  width: number;
  height: number;
  metadataPath: string;
  persistedAt: string;
};

function safeTaskId(taskId: string) {
  if (!/^[a-z0-9-]{36}$/i.test(taskId)) throw new Error("invalid_task_id");
  return taskId;
}

export async function persistImageResult(input: { taskId: string; expectedWidth: number; expectedHeight: number; png: Buffer; resultsDir: string }): Promise<PersistedImageResult> {
  const taskId = safeTaskId(input.taskId);
  if (input.png.length < 24 || input.png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("invalid_png_signature");
  }

  const metadata = await sharp(input.png).metadata();
  if (metadata.format !== "png" || metadata.width !== input.expectedWidth || metadata.height !== input.expectedHeight) {
    throw new Error(`png_dimension_mismatch:${metadata.width ?? 0}x${metadata.height ?? 0}`);
  }

  mkdirSync(input.resultsDir, { recursive: true });
  const imagePath = path.join(input.resultsDir, `${taskId}.png`);
  const thumbnailPath = path.join(input.resultsDir, `${taskId}.thumb.png`);
  const metadataPath = path.join(input.resultsDir, `${taskId}.json`);
  const sha256 = createHash("sha256").update(input.png).digest("hex");
  const persistedAt = new Date().toISOString();

  writeFileSync(imagePath, input.png);
  await sharp(input.png).resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true }).png().toFile(thumbnailPath);
  writeFileSync(metadataPath, JSON.stringify({ taskId, width: metadata.width, height: metadata.height, sha256, persistedAt }, null, 2), "utf8");

  return {
    imagePath,
    thumbnailPath,
    metadataPath,
    sha256,
    width: metadata.width,
    height: metadata.height,
    persistedAt,
  };
}
