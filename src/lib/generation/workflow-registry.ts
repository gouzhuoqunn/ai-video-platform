import type { ModelSlotKey } from "./model-registry";
import ultraRealProductionApi from "../../../comfy-runtime/workflows/production/ultrareal-flux1-dev-fp8-rtx4090-api.json";
import wan22Ti2v5bApi from "../../../comfy-runtime/workflows/official/wan22-ti2v-5b-api.json";
import wanRemixProductionApi from "../../../comfy-runtime/workflows/production/wan22-remix-14b-i2v-fp8-rtx4090-api.json";

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
  parameter_nodes: Partial<Record<WorkflowParameter, { node: string; input: string }>>;
  template: Record<string, unknown>;
  execution_status?: "api_executable_when_models_present" | "subgraph_registration_required" | "mock_second_round_placeholder";
};

export type WorkflowInputs = Partial<Record<WorkflowParameter, string | number>>;

export const WORKFLOW_TEMPLATES: Record<WorkflowKey, WorkflowTemplate> = {
  image_t2i: {
    key: "image_t2i",
    version: "production-ultrareal-flux1-dev-fp8-stage4e",
    origin: "community",
    api_format: "comfy_api_json",
    required_model_slots: ["rtx4090_image"],
    required_custom_nodes: [],
    output_node: "10",
    parameter_nodes: {
      prompt: { node: "3", input: "text" },
      negative_prompt: { node: "4", input: "text" },
      seed: { node: "7", input: "seed" },
      width: { node: "6", input: "width" },
      height: { node: "6", input: "height" },
    },
    template: ultraRealProductionApi as Record<string, unknown>,
    execution_status: "api_executable_when_models_present",
  },
  video_ti2v: {
    key: "video_ti2v",
    version: "official-wan22-ti2v-5b-2026-07-14",
    origin: "official",
    api_format: "comfy_api_json",
    required_model_slots: ["rtx4090_video"],
    required_custom_nodes: [],
    output_node: "47",
    parameter_nodes: {
      prompt: { node: "6", input: "text" },
      negative_prompt: { node: "7", input: "text" },
      seed: { node: "3", input: "seed" },
      width: { node: "55", input: "width" },
      height: { node: "55", input: "height" },
      frames: { node: "55", input: "length" },
    },
    template: wan22Ti2v5bApi as Record<string, unknown>,
    execution_status: "api_executable_when_models_present",
  },
  video_i2v: {
    key: "video_i2v",
    version: "production-wan22-remix-14b-i2v-fp8-stage4e",
    origin: "community",
    api_format: "comfy_api_json",
    required_model_slots: ["rtx4090_video"],
    required_custom_nodes: [],
    output_node: "14",
    parameter_nodes: {
      prompt: { node: "6", input: "text" },
      negative_prompt: { node: "7", input: "text" },
      seed: { node: "11", input: "noise_seed" },
      width: { node: "8", input: "width" },
      height: { node: "8", input: "height" },
      frames: { node: "8", input: "length" },
    },
    template: wanRemixProductionApi as Record<string, unknown>,
    execution_status: "api_executable_when_models_present",
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
    execution_status: "mock_second_round_placeholder",
  },
};

export function validateWorkflowTemplate(workflow: WorkflowTemplate) {
  const errors: string[] = [];
  if (!workflow.key) errors.push("workflow key is required");
  if (!workflow.version) errors.push("workflow version is required");
  if (workflow.api_format !== "comfy_api_json") errors.push("workflow API format must be comfy_api_json");
  if (!workflow.output_node || !(workflow.output_node in workflow.template)) errors.push("output node is missing from template");
  const promptMapping = workflow.parameter_nodes.prompt;
  if (!promptMapping) errors.push("prompt injection mapping is missing");
  for (const parameter of Object.keys(workflow.parameter_nodes) as WorkflowParameter[]) {
    const mapping = workflow.parameter_nodes[parameter]!;
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
    if (workflow.key === "video_i2v" && parameter === "seed" && cloned["12"]?.inputs && "noise_seed" in cloned["12"].inputs) {
      cloned["12"].inputs.noise_seed = value;
    }
  }
  return cloned;
}
