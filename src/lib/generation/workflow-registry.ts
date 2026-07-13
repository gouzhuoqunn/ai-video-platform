import type { ModelSlotKey } from "./model-registry";

export type WorkflowKey = "image_t2i" | "video_ti2v" | "video_i2v" | "video_flf2v";
export type WorkflowOrigin = "official" | "community";

export type WorkflowParameter = "prompt" | "negative_prompt" | "seed" | "width" | "height" | "frames";

export type WorkflowTemplate = {
  key: WorkflowKey;
  version: string;
  origin: WorkflowOrigin;
  api_format: "comfy_api_json";
  required_model_slots: ModelSlotKey[];
  required_custom_nodes: string[];
  output_node: string;
  parameter_nodes: Record<WorkflowParameter, { node: string; input: string }>;
  template: Record<string, unknown>;
};

export type WorkflowInputs = Partial<Record<WorkflowParameter, string | number>>;

export const WORKFLOW_TEMPLATES: Record<WorkflowKey, WorkflowTemplate> = {
  image_t2i: {
    key: "image_t2i",
    version: "mock-2026-07-14",
    origin: "official",
    api_format: "comfy_api_json",
    required_model_slots: ["rtx4090_image", "rtx5090_image"],
    required_custom_nodes: [],
    output_node: "save_image",
    parameter_nodes: {
      prompt: { node: "positive_prompt", input: "text" },
      negative_prompt: { node: "negative_prompt", input: "text" },
      seed: { node: "sampler", input: "seed" },
      width: { node: "latent", input: "width" },
      height: { node: "latent", input: "height" },
      frames: { node: "latent", input: "frames" },
    },
    template: {
      positive_prompt: { class_type: "CLIPTextEncode", inputs: { text: "" } },
      negative_prompt: { class_type: "CLIPTextEncode", inputs: { text: "" } },
      latent: { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, frames: 1 } },
      sampler: { class_type: "KSampler", inputs: { seed: 1 } },
      save_image: { class_type: "SaveImage", inputs: { images: ["sampler", 0] } },
    },
  },
  video_ti2v: {
    key: "video_ti2v",
    version: "mock-2026-07-14",
    origin: "official",
    api_format: "comfy_api_json",
    required_model_slots: ["rtx4090_video"],
    required_custom_nodes: [],
    output_node: "save_video",
    parameter_nodes: {
      prompt: { node: "positive_prompt", input: "text" },
      negative_prompt: { node: "negative_prompt", input: "text" },
      seed: { node: "sampler", input: "seed" },
      width: { node: "latent", input: "width" },
      height: { node: "latent", input: "height" },
      frames: { node: "latent", input: "frames" },
    },
    template: {
      positive_prompt: { class_type: "CLIPTextEncode", inputs: { text: "" } },
      negative_prompt: { class_type: "CLIPTextEncode", inputs: { text: "" } },
      latent: { class_type: "EmptyVideoLatent", inputs: { width: 1280, height: 704, frames: 121 } },
      sampler: { class_type: "KSampler", inputs: { seed: 1 } },
      save_video: { class_type: "SaveVideo", inputs: { frames: ["sampler", 0] } },
    },
  },
  video_i2v: {
    key: "video_i2v",
    version: "mock-2026-07-14",
    origin: "official",
    api_format: "comfy_api_json",
    required_model_slots: ["rtx5090_video"],
    required_custom_nodes: [],
    output_node: "save_video",
    parameter_nodes: {
      prompt: { node: "positive_prompt", input: "text" },
      negative_prompt: { node: "negative_prompt", input: "text" },
      seed: { node: "sampler", input: "seed" },
      width: { node: "latent", input: "width" },
      height: { node: "latent", input: "height" },
      frames: { node: "latent", input: "frames" },
    },
    template: {
      positive_prompt: { class_type: "CLIPTextEncode", inputs: { text: "" } },
      negative_prompt: { class_type: "CLIPTextEncode", inputs: { text: "" } },
      latent: { class_type: "ImageToVideoLatent", inputs: { width: 1280, height: 704, frames: 121 } },
      sampler: { class_type: "KSampler", inputs: { seed: 1 } },
      save_video: { class_type: "SaveVideo", inputs: { frames: ["sampler", 0] } },
    },
  },
  video_flf2v: {
    key: "video_flf2v",
    version: "mock-2026-07-14",
    origin: "community",
    api_format: "comfy_api_json",
    required_model_slots: ["rtx5090_video"],
    required_custom_nodes: ["planned-flf2v-node"],
    output_node: "save_video",
    parameter_nodes: {
      prompt: { node: "positive_prompt", input: "text" },
      negative_prompt: { node: "negative_prompt", input: "text" },
      seed: { node: "sampler", input: "seed" },
      width: { node: "latent", input: "width" },
      height: { node: "latent", input: "height" },
      frames: { node: "latent", input: "frames" },
    },
    template: {
      positive_prompt: { class_type: "CLIPTextEncode", inputs: { text: "" } },
      negative_prompt: { class_type: "CLIPTextEncode", inputs: { text: "" } },
      latent: { class_type: "FirstLastFrameVideoLatent", inputs: { width: 1280, height: 704, frames: 121 } },
      sampler: { class_type: "KSampler", inputs: { seed: 1 } },
      save_video: { class_type: "SaveVideo", inputs: { frames: ["sampler", 0] } },
    },
  },
};

export function validateWorkflowTemplate(workflow: WorkflowTemplate) {
  const errors: string[] = [];
  if (!workflow.key) errors.push("workflow key is required");
  if (!workflow.version) errors.push("workflow version is required");
  if (workflow.api_format !== "comfy_api_json") errors.push("workflow API format must be comfy_api_json");
  if (!workflow.output_node || !(workflow.output_node in workflow.template)) errors.push("output node is missing from template");
  for (const parameter of ["prompt", "seed", "width", "height", "frames"] as const) {
    const mapping = workflow.parameter_nodes[parameter];
    if (!mapping) {
      errors.push(`${parameter} injection mapping is missing`);
      continue;
    }
    const node = workflow.template[mapping.node] as { inputs?: Record<string, unknown> } | undefined;
    if (!node?.inputs || !(mapping.input in node.inputs)) errors.push(`${parameter} target input is missing`);
  }
  return errors;
}

export function injectWorkflowParameters(workflow: WorkflowTemplate, inputs: WorkflowInputs) {
  const cloned = structuredClone(workflow.template) as Record<string, { inputs?: Record<string, unknown> }>;
  for (const [parameter, value] of Object.entries(inputs) as Array<[WorkflowParameter, string | number]>) {
    const mapping = workflow.parameter_nodes[parameter];
    if (!mapping) continue;
    const node = cloned[mapping.node];
    if (!node?.inputs || !(mapping.input in node.inputs)) {
      throw new Error(`workflow parameter target missing: ${parameter}`);
    }
    node.inputs[mapping.input] = value;
  }
  return cloned;
}
