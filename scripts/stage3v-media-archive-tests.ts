import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { archiveStage3OWanVideo, buildStage3OWanWorkflow, validateStage3OWanWorkflow } from "./stage3o-wan-executor";
import { buildLocalJobPaths } from "./local-results/config";
import { STAGE3O_VIDEO_TASK_ID } from "./stage3o-batch";

const require = createRequire(import.meta.url);
const ffmpeg = (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
const root = mkdtempSync(path.join(os.tmpdir(), "stage3v-media-"));
const source = path.join(root, "source.webm");
try {
  const generated = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=blue:s=160x96:r=16:d=3", "-an", "-c:v", "libvpx-vp9", source], { encoding: "utf8", timeout: 60_000 });
  assert.equal(generated.status, 0, String(generated.error?.message ?? generated.stderr));
  const workflow = buildStage3OWanWorkflow(); const validation = validateStage3OWanWorkflow(workflow);
  const archived = archiveStage3OWanVideo({ sourceWebm: source, workflow, validation, promptId: "stage3v-local-test", oomFallbackUsed: false, libraryDir: root });
  assert.ok(existsSync(archived.outputPath)); assert.ok(existsSync(archived.thumbnailPath));
  const paths = buildLocalJobPaths(root, new Date().toISOString().slice(0, 10), STAGE3O_VIDEO_TASK_ID);
  assert.equal(existsSync(path.join(paths.jobDir, "source.webm")), false, "successful conversion must remove the preserved WebM");
  console.log("Bundled ffmpeg MP4 conversion, thumbnail, and successful-source cleanup passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
