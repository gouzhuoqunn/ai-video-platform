import crypto from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import workflowTemplate from "../comfy-runtime/workflows/bootstrap/flux2-klein-4b-t2i-api.json";

export const FLUX_FIRST_IMAGE_PROMPT =
  "A cinematic wide shot of a futuristic white research station beside a clear blue ocean at sunset, realistic architecture, warm sunlight, detailed clouds, clean composition, high detail";

export const FLUX_MODEL_FILES = [
  {
    repository: "black-forest-labs/FLUX.2-klein-4b-fp8",
    revision: "5b4408e59397a4a37ccb46afe426d8ed86379441",
    remotePath: "flux-2-klein-4b-fp8.safetensors",
    targetDirectory: "diffusion_models",
    filename: "flux-2-klein-4b-fp8.safetensors",
    size: 4070624520,
    sha256: "97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6",
  },
  {
    repository: "Comfy-Org/vae-text-encorder-for-flux-klein-4b",
    revision: "a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246",
    remotePath: "split_files/text_encoders/qwen_3_4b.safetensors",
    targetDirectory: "text_encoders",
    filename: "qwen_3_4b.safetensors",
    size: 8044982048,
    sha256: "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
  },
  {
    repository: "Comfy-Org/vae-text-encorder-for-flux-klein-4b",
    revision: "a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246",
    remotePath: "split_files/vae/flux2-vae.safetensors",
    targetDirectory: "vae",
    filename: "flux2-vae.safetensors",
    size: 336211292,
    sha256: "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
  },
] as const;

export type FluxFirstImageInput = {
  prompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
};

type WorkflowNode = { class_type: string; inputs: Record<string, unknown> };
export type FluxWorkflow = Record<string, WorkflowNode>;

export function buildFluxFirstImageWorkflow(input: FluxFirstImageInput = {}): FluxWorkflow {
  const prompt = input.prompt ?? FLUX_FIRST_IMAGE_PROMPT;
  const seed = input.seed ?? 20260715;
  const width = input.width ?? 1024;
  const height = input.height ?? 1024;
  const steps = input.steps ?? 4;
  if (!Number.isInteger(seed) || !Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(steps)) {
    throw new Error("Flux first-image inputs must be integers where applicable.");
  }
  if (width < 16 || height < 16 || width % 16 !== 0 || height % 16 !== 0 || steps < 1) {
    throw new Error("Flux first-image dimensions must be multiples of 16 and steps must be positive.");
  }

  const workflow = structuredClone(workflowTemplate) as FluxWorkflow;
  workflow["1"].inputs.unet_name = FLUX_MODEL_FILES[0].filename;
  workflow["2"].inputs.clip_name = FLUX_MODEL_FILES[1].filename;
  workflow["3"].inputs.text = prompt;
  workflow["5"].inputs.width = width;
  workflow["5"].inputs.height = height;
  workflow["6"].inputs.seed = seed;
  workflow["6"].inputs.steps = steps;
  workflow["7"].inputs.vae_name = FLUX_MODEL_FILES[2].filename;
  return workflow;
}

export function validateFluxFirstImageWorkflow(workflow: FluxWorkflow) {
  const errors: string[] = [];
  const allowed = new Set(["UNETLoader", "CLIPLoader", "CLIPTextEncode", "FluxGuidance", "EmptyFlux2LatentImage", "KSampler", "VAELoader", "VAEDecode", "SaveImage"]);
  for (const [id, node] of Object.entries(workflow)) {
    if (!allowed.has(node.class_type)) errors.push(`unsupported node class at ${id}: ${node.class_type}`);
  }
  for (const [id, classType] of Object.entries({ "1": "UNETLoader", "2": "CLIPLoader", "3": "CLIPTextEncode", "4": "FluxGuidance", "5": "EmptyFlux2LatentImage", "6": "KSampler", "7": "VAELoader", "8": "VAEDecode", "9": "SaveImage" })) {
    if (workflow[id]?.class_type !== classType) errors.push(`missing ${classType} node`);
  }
  if (workflow["2"]?.inputs.type !== "flux2") errors.push("FLUX.2 Qwen encoder requires CLIPLoader type=flux2");
  for (const [node, input] of [["1", "unet_name"], ["2", "clip_name"], ["7", "vae_name"], ["3", "text"], ["5", "width"], ["5", "height"], ["6", "seed"], ["6", "steps"], ["9", "images"]] as const) {
    if (!(input in (workflow[node]?.inputs ?? {}))) errors.push(`missing injectable input ${node}.${input}`);
  }
  if (workflow["9"]?.class_type !== "SaveImage") errors.push("SaveImage must remain the output node");
  return errors;
}

export function archiveFluxFirstImage(input: {
  sourcePng: string;
  sessionId: string;
  workflow: FluxWorkflow;
  metadata: Record<string, unknown>;
  evidence: Record<string, unknown>;
  libraryDir?: string;
}) {
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(input.sessionId)) throw new Error("Invalid first-image session id.");
  if (!existsSync(input.sourcePng)) throw new Error("Generated PNG is missing.");
  const date = new Date().toISOString().slice(0, 10);
  const libraryDir = input.libraryDir ?? "D:\\AI-Creative-Library";
  const archiveDir = path.join(libraryDir, date, input.sessionId);
  mkdirSync(archiveDir, { recursive: true });
  const outputPath = path.join(archiveDir, "output.png");
  const partialPath = `${outputPath}.part`;
  copyFileSync(input.sourcePng, partialPath);
  renameSync(partialPath, outputPath);
  const sha256 = crypto.createHash("sha256").update(readFileSync(outputPath)).digest("hex");
  writeFileSync(path.join(archiveDir, "workflow-api.json"), `${JSON.stringify(input.workflow, null, 2)}\n`, "utf8");
  writeFileSync(path.join(archiveDir, "metadata.json"), `${JSON.stringify({ ...input.metadata, output_sha256: sha256 }, null, 2)}\n`, "utf8");
  writeFileSync(path.join(archiveDir, "runtime-evidence.json"), `${JSON.stringify(input.evidence, null, 2)}\n`, "utf8");
  return { archiveDir, outputPath, sha256 };
}
