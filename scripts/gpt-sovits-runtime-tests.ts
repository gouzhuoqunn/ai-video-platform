import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureLocalAudioDirectories } from "../src/lib/local-data/path-registry";

const root = path.join(os.tmpdir(), `gpt-sovits-paths-${process.pid}`);
try {
  const first = ensureLocalAudioDirectories(root);
  const second = ensureLocalAudioDirectories(root);
  assert.deepEqual(first.directories, second.directories);
  for (const directory of first.directories) assert.equal(existsSync(directory), true, directory);
  assert.ok(first.paths.gptSoVitsModelRoot.endsWith(path.join("voice", "base-models", "gpt-sovits")));
  assert.ok(first.paths.workerStateRoot.endsWith(path.join("voice", "worker-state")));
  assert.ok(first.paths.audioDownloadTempRoot.endsWith(path.join("temp", "audio-downloads")));
  console.log(JSON.stringify({ ok: true, directories: first.directories.length, idempotent: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
