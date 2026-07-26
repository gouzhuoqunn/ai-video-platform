export const FLUX_IMAGE_STACK = {
  textTransformer: "Fluxed Up 10.2 BF16",
  textTransformerRole: "complete FLUX.1-D transformer replacement (never load FLUX.1-dev FP8 alongside it)",
  lora: "AIDMA NSFW Unlock LoRA",
  referenceModel: "FLUX.1-Kontext-dev",
} as const;

export type ImageGpuClass = "rtx4090" | "rtx5090";
export const IMAGE_RESOLUTION_MIN = 768;
export const IMAGE_RESOLUTION_4090_MAX = 1280;
export const IMAGE_RESOLUTION_5090_MAX = 1536;
export const IMAGE_RESOLUTION_STEP = 256;

export type ImageTaskSettings = {
  prompt: string;
  steps: number;
  loraStrength: number;
  cfg: number;
  sampler: "Euler" | "FlowMatch";
  width: number;
  height: number;
};

export function classifyImageGpu(width: number, height: number): ImageGpuClass | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < IMAGE_RESOLUTION_MIN || height < IMAGE_RESOLUTION_MIN || width % IMAGE_RESOLUTION_STEP || height % IMAGE_RESOLUTION_STEP) return null;
  if (width <= IMAGE_RESOLUTION_4090_MAX && height <= IMAGE_RESOLUTION_4090_MAX) return "rtx4090";
  if (width <= IMAGE_RESOLUTION_5090_MAX && height <= IMAGE_RESOLUTION_5090_MAX) return "rtx5090";
  return null;
}

export function createFluxExecutionConfig(task: ImageTaskSettings & { referenceImage: string | null; gpuClass: ImageGpuClass }) {
  const mode = task.referenceImage ? "kontext_edit" : "text_generation";
  return {
    stack: FLUX_IMAGE_STACK,
    mode,
    prompt: task.prompt,
    referenceImage: task.referenceImage,
    referenceMode: task.referenceImage ? "flux_kontext_reference_aware" : "fluxed_up_text_to_image",
    steps: task.steps,
    loraStrength: task.loraStrength,
    cfg: task.cfg,
    sampler: task.sampler,
    resolution: { width: task.width, height: task.height },
    gpuClass: task.gpuClass,
  } as const;
}
