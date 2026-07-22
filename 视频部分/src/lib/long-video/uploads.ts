import "server-only";

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const UPLOAD_ID = /^[a-f0-9-]{36}$/;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const LONG_VIDEO_UPLOAD_DIR = process.env.LONG_VIDEO_UPLOAD_DIR?.trim() || path.join(process.cwd(), ".secrets", "long-video-uploads");

function detectedExtension(bytes: Uint8Array) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { extension: "png", mime: "image/png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { extension: "jpg", mime: "image/jpeg" };
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") return { extension: "webp", mime: "image/webp" };
  throw new Error("只支持 PNG、JPEG 或 WebP 首帧图片。");
}

function findUpload(uploadId: string) {
  if (!UPLOAD_ID.test(uploadId)) return null;
  for (const extension of ["png", "jpg", "webp"]) {
    const filePath = path.join(LONG_VIDEO_UPLOAD_DIR, `${uploadId}.${extension}`);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

export function persistLongVideoUpload(bytes: Uint8Array) {
  if (bytes.byteLength < 16 || bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("首帧图片必须小于 20MB 且不能为空。");
  const detected = detectedExtension(bytes);
  const uploadId = randomUUID();
  mkdirSync(LONG_VIDEO_UPLOAD_DIR, { recursive: true });
  const filePath = path.join(LONG_VIDEO_UPLOAD_DIR, `${uploadId}.${detected.extension}`);
  const temporary = `${filePath}.${process.pid}.part`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, filePath);
  return { uploadId, ref: `upload:${uploadId}`, mime: detected.mime, sizeBytes: bytes.byteLength };
}

export function readLongVideoUpload(uploadId: string) {
  const filePath = findUpload(uploadId);
  if (!filePath) return null;
  const extension = path.extname(filePath);
  return {
    bytes: readFileSync(filePath),
    mime: extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg",
    sizeBytes: statSync(filePath).size,
  };
}

export function deleteLongVideoUploadRef(reference: string | null) {
  const match = reference?.match(/^upload:([a-f0-9-]{36})$/);
  if (!match) return false;
  const filePath = findUpload(match[1]);
  if (!filePath) return false;
  unlinkSync(filePath);
  if (existsSync(LONG_VIDEO_UPLOAD_DIR) && readdirSync(LONG_VIDEO_UPLOAD_DIR).length === 0) rmdirSync(LONG_VIDEO_UPLOAD_DIR);
  return true;
}

export function longVideoUploadExists(reference: string | null) {
  const match = reference?.match(/^upload:([a-f0-9-]{36})$/);
  return Boolean(match && findUpload(match[1]));
}
