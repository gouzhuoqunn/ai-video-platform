export const FLUX_IMAGE_STACK = {
  textTransformer: "Fluxed Up 10.2 BF16",
  textTransformerRole: "complete FLUX.1-D transformer replacement (never load FLUX.1-dev FP8 alongside it)",
  lora: "AIDMA NSFW Unlock LoRA",
  referenceModel: "FLUX.1-Kontext-dev",
} as const;

export type ImageGpuClass = "rtx4090" | "rtx5090";

export type ImageTaskSettings = {
  prompt: string;
  steps: number;
  loraStrength: number;
  cfg: number;
  sampler: "Euler" | "FlowMatch";
  width: number;
  height: number;
};

export function classifyImageGpu(width: number, height: number): ImageGpuClass {
  return width <= 1280 && height <= 1280 ? "rtx4090" : "rtx5090";
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
