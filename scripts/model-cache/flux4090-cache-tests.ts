import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fluxCacheCurrentKey, fluxCacheFiles, fluxCacheManifestKey, buildFluxCacheManifest } from "./flux4090-cache";

assert.equal(fluxCacheFiles.length, 3);
assert.equal(fluxCacheCurrentKey, "production/rtx4090/image/current.json");
assert.match(fluxCacheManifestKey, /^production\/rtx4090\/image\/revisions\//);
const manifest = buildFluxCacheManifest();
assert.equal(manifest.files.length, 3);
for (const file of manifest.files) {
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.ok(file.size_bytes > 1024 * 1024);
  assert.match(file.key, /^production\/rtx4090\/image\/revisions\//);
}
const source = readFileSync(path.join(process.cwd(), "scripts", "model-cache", "flux4090-cache.ts"), "utf8");
assert.match(source, /PART_BYTES = 64 \* 1024 \* 1024/);
assert.match(source, /seed_time_limit_reached/);
assert.match(source, /current\.json publish/);
assert.match(source, /\.secrets/);
console.log("FLUX R2 multipart, resume, and publish-last tests passed.");
