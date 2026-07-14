import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type SourceAudit = {
  schemaVersion: 1;
  commit: string;
  routes: string[];
  coreNodeClasses: string[];
};

function main() {
  const audit = JSON.parse(readFileSync("comfy-runtime/comfyui-source-audit.json", "utf8")) as SourceAudit;
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.commit, "da2608926eaf68fd532bba4e1ace3402c5d21399");
  for (const route of ["/ws", "/system_stats", "/history", "/queue", "/prompt", "/interrupt", "/free", "/object_info"]) {
    assert.ok(audit.routes.includes(route), `${route} must be present in the pinned source audit`);
  }
  for (const nodeClass of [
    "CLIPLoader",
    "CLIPTextEncode",
    "DualCLIPLoader",
    "FluxGuidance",
    "FluxKontextImageScale",
    "KSampler",
    "KSamplerAdvanced",
    "LoadImage",
    "ModelSamplingSD3",
    "SaveAnimatedWEBP",
    "SaveImage",
    "SaveWEBM",
    "UNETLoader",
    "VAEDecode",
    "VAELoader",
    "Wan22ImageToVideoLatent",
    "WanImageToVideo",
  ]) {
    assert.ok(audit.coreNodeClasses.includes(nodeClass), `${nodeClass} must be present in the pinned source audit`);
  }
  console.log("ComfyUI source audit tests passed");
}

main();
