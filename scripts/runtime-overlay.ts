import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const RUNTIME_OVERLAY_FILES = [
  "controller.py",
  "healthcheck.py",
  "supervisor.py",
  "launch_comfy.py",
  "extras_extractor.py",
  "profile_audit.py",
  "entrypoint.sh",
  "requirements.lock",
  "custom-node-locks.json",
  "comfyui-source-audit.json",
  "node-profiles/production-minimal.json",
  "workflows/official/manifest.json",
  "workflows/bootstrap/flux2-klein-4b-t2i-api.json",
] as const;

export function buildRuntimeOverlay(outputPath = path.join(process.cwd(), ".secrets", "runtime-overlay.tgz")) {
  const runtimeDir = path.join(process.cwd(), "comfy-runtime");
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const tar = spawnSync("tar", ["-czf", outputPath, "-C", runtimeDir, ...RUNTIME_OVERLAY_FILES], { encoding: "utf8", timeout: 120_000 });
  if (tar.status !== 0) throw new Error(`runtime_overlay_pack_failed:${String(tar.stderr).trim()}`);
  const bytes = readFileSync(outputPath);
  const manifest = {
    schema_version: 1,
    profile: "clore_light_bootstrap",
    archive: path.basename(outputPath),
    size_bytes: statSync(outputPath).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    files: [...RUNTIME_OVERLAY_FILES],
    permanent_image_rebuilt: false,
  };
  const manifestPath = path.join(path.dirname(outputPath), "runtime-overlay-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { outputPath, manifestPath, manifest };
}

if (process.argv[1]?.endsWith("runtime-overlay.ts")) {
  console.log(JSON.stringify(buildRuntimeOverlay(), null, 2));
}
