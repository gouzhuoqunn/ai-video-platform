import type { RequiredGpuClass } from "@/lib/generation/gpu-execution-state";
import type { LtxAudioConditionedRequest, LtxModelManifest } from "./index";

export type LtxExecutionPreset = {
  id: LtxAudioConditionedRequest["executionPreset"];
  gpuClass: RequiredGpuClass;
  width: number;
  height: number;
  executableStatus: "blocked";
  blockerReason: string;
  requiredModelRoles: LtxModelManifest["modelRole"][];
  packageContents: readonly ["request.json", "dialogue.json", "input.wav", "first-frame(optional)", "model-manifest-references.json"];
};

export const LTX_AUDIO_CONDITIONED_PRESETS: LtxExecutionPreset[] = [
  { id: "ltx_audible_fast_720p_4090", gpuClass: "rtx4090", width: 1280, height: 720, executableStatus: "blocked", blockerReason: "sulphur_4090_compatibility_evidence_incomplete", requiredModelRoles: ["sulphur_distilled", "auxiliary_lora"], packageContents: ["request.json", "dialogue.json", "input.wav", "first-frame(optional)", "model-manifest-references.json"] },
  { id: "ltx_audible_quality_720p_5090", gpuClass: "rtx5090", width: 1280, height: 720, executableStatus: "blocked", blockerReason: "sulphur_5090_quality_workflow_evidence_incomplete", requiredModelRoles: ["sulphur_full", "auxiliary_lora"], packageContents: ["request.json", "dialogue.json", "input.wav", "first-frame(optional)", "model-manifest-references.json"] },
  { id: "ltx_audible_quality_1080p_5090", gpuClass: "rtx5090", width: 1920, height: 1080, executableStatus: "blocked", blockerReason: "1080p_upscaler_and_audio_preservation_evidence_incomplete", requiredModelRoles: ["sulphur_full", "auxiliary_lora"], packageContents: ["request.json", "dialogue.json", "input.wav", "first-frame(optional)", "model-manifest-references.json"] },
];

export function getLtxAudioConditionedPreset(id: LtxAudioConditionedRequest["executionPreset"]) {
  return LTX_AUDIO_CONDITIONED_PRESETS.find((preset) => preset.id === id) ?? null;
}
