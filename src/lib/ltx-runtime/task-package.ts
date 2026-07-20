import path from "node:path";
import type { LtxAudioConditionedRequest, LtxModelManifest } from "./index";
import { getLtxAudioConditionedPreset } from "./presets";

export type AudioConditionedTaskPackage = {
  schemaVersion: 1;
  taskId: string;
  executionPreset: LtxAudioConditionedRequest["executionPreset"];
  executableStatus: "blocked";
  blockerReason: string;
  files: { request: "request.json"; dialogue: "dialogue.json"; inputAudio: string; firstFrame: string | null; modelManifestReferences: "model-manifest-references.json" };
  modelManifestReferences: Array<Pick<LtxModelManifest, "modelKey" | "immutableRevision" | "modelRole" | "executableStatus">>;
};

export function buildAudioConditionedTaskPackage(request: LtxAudioConditionedRequest, manifests: LtxModelManifest[]): AudioConditionedTaskPackage {
  const preset = getLtxAudioConditionedPreset(request.executionPreset);
  if (!preset || preset.gpuClass !== request.gpuClass || preset.width !== request.width || preset.height !== request.height) throw new Error("ltx_preset_request_mismatch");
  const references = manifests.filter((manifest) => preset.requiredModelRoles.includes(manifest.modelRole)).map((manifest) => ({ modelKey: manifest.modelKey, immutableRevision: manifest.immutableRevision, modelRole: manifest.modelRole, executableStatus: manifest.executableStatus }));
  if (references.length !== preset.requiredModelRoles.length) throw new Error("ltx_model_manifest_reference_missing");
  return { schemaVersion: 1, taskId: request.taskId, executionPreset: preset.id, executableStatus: "blocked", blockerReason: preset.blockerReason, files: { request: "request.json", dialogue: "dialogue.json", inputAudio: path.basename(request.inputAudioPath), firstFrame: request.firstFrameReference ? path.basename(request.firstFrameReference) : null, modelManifestReferences: "model-manifest-references.json" }, modelManifestReferences: references };
}
