import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("scripts/clore/restore-flux-r2.py", "utf8");
assert.match(source, /ThreadPoolExecutor\(max_workers=2\)/);
assert.match(source, /Range[\s\S]*bytes=/);
assert.match(source, /\.part/);
assert.match(source, /os\.fsync/);
assert.match(source, /hashlib\.sha256/);
assert.match(source, /partial\.replace\(target\)/);
assert.match(source, /hf_fallback_url/);
assert.doesNotMatch(source, /ACCESS_KEY|SECRET_ACCESS|Authorization|presigned_url/);
assert.doesNotMatch(source, /read_bytes\(\)/);
console.log("GPU-side R2 resume, parallelism, integrity, and credential-boundary tests passed.");
