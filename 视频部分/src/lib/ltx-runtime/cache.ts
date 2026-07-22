import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { LtxModelManifest } from "./index";

export type CacheSource = "local_cache" | "r2_cache" | "upstream";
export type CacheRestorePlan = { source: CacheSource; files: Array<{ path: string; action: "reuse" | "resume" | "download" }>; totalBytes: number };
export type CacheRestoreResult = { source: CacheSource; restored: string[]; resumed: string[]; journalPath: string };
export type CacheRestoreOptions = { manifest: LtxModelManifest; cacheRoot: string; sourceRoot: string; source: CacheSource; cancel?: () => boolean };

const runningRestores = new Map<string, Promise<CacheRestoreResult>>();
function digest(filePath: string) { return createHash("sha256").update(readFileSync(filePath)).digest("hex"); }
function requiredFiles(manifest: LtxModelManifest) { return manifest.files.filter((file) => file.required); }
function finalPath(root: string, name: string) { return path.join(root, name); }
function ensureRelative(name: string) { if (!name || path.isAbsolute(name) || name.split(/[\\/]+/).includes("..")) throw new Error("cache_manifest_path_invalid"); }

export function planLtxCacheRestore(manifest: LtxModelManifest, cacheRoot: string, availability: Partial<Record<CacheSource, boolean>>): CacheRestorePlan {
  if (!/^[a-f0-9]{7,64}$/i.test(manifest.immutableRevision)) throw new Error("cache_manifest_revision_invalid");
  const source: CacheSource = availability.local_cache ? "local_cache" : availability.r2_cache ? "r2_cache" : "upstream";
  const files = requiredFiles(manifest).map((file) => {
    ensureRelative(file.path); const finalFile = finalPath(cacheRoot, file.path); const part = `${finalFile}.part`;
    return { path: file.path, action: existsSync(finalFile) ? "reuse" as const : existsSync(part) ? "resume" as const : "download" as const };
  });
  return { source, files, totalBytes: requiredFiles(manifest).reduce((sum, file) => sum + file.sizeBytes, 0) };
}

function writeJournal(root: string, body: Record<string, unknown>) {
  mkdirSync(root, { recursive: true }); const journal = path.join(root, ".restore-journal.json"); const part = `${journal}.part`;
  writeFileSync(part, `${JSON.stringify(body, null, 2)}\n`, "utf8"); renameSync(part, journal); return journal;
}

async function restore(options: CacheRestoreOptions): Promise<CacheRestoreResult> {
  const { manifest, cacheRoot, sourceRoot, source, cancel = () => false } = options;
  const plan = planLtxCacheRestore(manifest, cacheRoot, { [source]: true });
  const restored: string[] = []; const resumed: string[] = [];
  const journalPath = writeJournal(cacheRoot, { model_key: manifest.modelKey, revision: manifest.immutableRevision, source, status: "running", files: [] });
  for (const file of requiredFiles(manifest)) {
    ensureRelative(file.path); if (cancel()) throw new Error("cache_restore_canceled");
    const target = finalPath(cacheRoot, file.path); const part = `${target}.part`; const sourcePath = finalPath(sourceRoot, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    if (existsSync(target)) {
      if (statSync(target).size !== file.sizeBytes || (file.sha256 && digest(target) !== file.sha256)) throw new Error(`cache_checksum_mismatch:${file.path}`);
      restored.push(file.path); continue;
    }
    if (!existsSync(sourcePath)) throw new Error(`cache_required_file_missing:${file.path}`);
    if (existsSync(part)) {
      const partialSize = statSync(part).size;
      if (partialSize > file.sizeBytes) await rm(part, { force: true });
      else if (partialSize > 0) {
        resumed.push(file.path);
        writeFileSync(part, readFileSync(sourcePath).subarray(partialSize), { flag: "a" });
      }
    }
    if (!existsSync(part)) await copyFile(sourcePath, part);
    if (cancel()) { await rm(part, { force: true }); throw new Error("cache_restore_canceled"); }
    if (statSync(part).size !== file.sizeBytes || (file.sha256 && digest(part) !== file.sha256)) { await rm(part, { force: true }); throw new Error(`cache_checksum_mismatch:${file.path}`); }
    await rename(part, target); restored.push(file.path);
    writeJournal(cacheRoot, { model_key: manifest.modelKey, revision: manifest.immutableRevision, source, status: "running", completed: restored });
  }
  writeJournal(cacheRoot, { model_key: manifest.modelKey, revision: manifest.immutableRevision, source, status: "completed", completed: restored });
  return { source: plan.source, restored, resumed, journalPath };
}

export function restoreLtxCache(options: CacheRestoreOptions) {
  const key = `${path.resolve(options.cacheRoot)}:${options.manifest.modelKey}:${options.manifest.immutableRevision}`;
  const existing = runningRestores.get(key); if (existing) return existing;
  const pending = restore(options).finally(() => runningRestores.delete(key)); runningRestores.set(key, pending); return pending;
}

export function cleanupLtxPartFiles(cacheRoot: string, maxAgeMs: number, now = Date.now()) {
  const removed: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name); if (entry.isDirectory()) visit(filePath);
      else if (entry.name.endsWith(".part") && now - statSync(filePath).mtimeMs > maxAgeMs) { rmSync(filePath, { force: true }); removed.push(filePath); }
    }
  };
  if (existsSync(cacheRoot)) visit(cacheRoot); return removed;
}
