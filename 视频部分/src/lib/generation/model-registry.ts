import type { GpuProfileKey } from "./gpu-profiles";

export type TaskType = "image" | "video";
export type ModelSlotKey = "rtx4090_image" | "rtx4090_video" | "rtx5090_image" | "rtx5090_video";
export type ModelCandidateStatus =
  | "unverified"
  | "public_verified"
  | "gated_user_action_required"
  | "metadata_incomplete"
  | "eligible_for_benchmark"
  | "rejected_before_benchmark";

export type ModelCandidate = {
  key: string;
  display_name: string;
  task_type: TaskType;
  gpu_profiles: GpuProfileKey[];
  source_repository: string;
  revision: string;
  expected_files: string[];
  quantization: string;
  workflow_key: string;
  required_custom_nodes: string[];
  minimum_vram: number;
  minimum_ram: number;
  estimated_disk: number;
  license_note: string;
  license: string;
  status: ModelCandidateStatus;
  sha256: string;
  slot: ModelSlotKey;
  origin: "official" | "community";
  benchmark_round: "first" | "second";
};

export type ModelCacheRegistryEntry = {
  candidate_key: string;
  cache_status: "ready";
  revision: string;
  current_key: string;
  manifest_key: string;
  total_size_bytes: number;
  github_actions_run_id: number;
  verified_at: string;
  gpu_restore_ready: true;
  gpu_inference_verified: false;
  production_ready: false;
  files: Array<{ filename: string; size_bytes: number; sha256: string }>;
};

export const MODEL_SLOTS: ModelSlotKey[] = ["rtx4090_image", "rtx4090_video", "rtx5090_image", "rtx5090_video"];

export const MODEL_CACHE_REGISTRY: Partial<Record<ModelSlotKey, ModelCacheRegistryEntry>> = {
  rtx4090_image: {
    candidate_key: "flux2-klein-4b-official",
    cache_status: "ready",
    revision: "flux2-klein-4b-5b4408e59397-a9e4ca87c16d",
    current_key: "production/rtx4090/image/current.json",
    manifest_key: "production/rtx4090/image/revisions/flux2-klein-4b-5b4408e59397-a9e4ca87c16d/manifest.json",
    total_size_bytes: 12_451_817_860,
    github_actions_run_id: 29431562820,
    verified_at: "2026-07-15T16:23:59Z",
    gpu_restore_ready: true,
    gpu_inference_verified: false,
    production_ready: false,
    files: [
      { filename: "flux-2-klein-4b-fp8.safetensors", size_bytes: 4_070_624_520, sha256: "97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6" },
      { filename: "qwen_3_4b.safetensors", size_bytes: 8_044_982_048, sha256: "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a" },
      { filename: "flux2-vae.safetensors", size_bytes: 336_211_292, sha256: "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3" },
    ],
  },
};

export const MODEL_CANDIDATES: ModelCandidate[] = [
  {
    key: "flux2-klein-4b-official",
    display_name: "FLUX.2 Klein 4B Distilled FP8",
    task_type: "image",
    gpu_profiles: ["rtx4090"],
    source_repository: "black-forest-labs/FLUX.2-klein-4b-fp8",
    revision: "5b4408e59397a4a37ccb46afe426d8ed86379441",
    expected_files: ["flux-2-klein-4b-fp8.safetensors", "qwen_3_4b.safetensors", "flux2-vae.safetensors"],
    quantization: "fp8",
    workflow_key: "image_t2i",
    required_custom_nodes: [],
    minimum_vram: 24,
    minimum_ram: 64,
    estimated_disk: 13,
    license_note: "Apache-2.0 distilled FP8 4090 baseline. Primary file plus Comfy auxiliary Qwen text encoder and VAE files are locked; official Comfy template still needs subgraph unpack/register before GPU smoke.",
    license: "apache-2.0",
    status: "eligible_for_benchmark",
    sha256: "",
    slot: "rtx4090_image",
    origin: "official",
    benchmark_round: "first",
  },
  {
    key: "flux2-klein-4b-base-fp8-challenge",
    display_name: "FLUX.2 Klein 4B Base FP8",
    task_type: "image",
    gpu_profiles: ["rtx4090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "fp8",
    workflow_key: "image_t2i",
    required_custom_nodes: [],
    minimum_vram: 24,
    minimum_ram: 64,
    estimated_disk: 6,
    license_note: "Optional 4090 challenger. No exact public repository/revision/file lock has been proven in this checkpoint.",
    license: "pending_metadata_verification",
    status: "unverified",
    sha256: "",
    slot: "rtx4090_image",
    origin: "official",
    benchmark_round: "second",
  },
  {
    key: "wan22-ti2v-5b-official",
    display_name: "Wan2.2 TI2V-5B",
    task_type: "video",
    gpu_profiles: ["rtx4090", "rtx5090"],
    source_repository: "Wan-AI/Wan2.2-TI2V-5B",
    revision: "921dbaf3f1674a56f47e83fb80a34bac8a8f203e",
    expected_files: ["config.json", "diffusion_pytorch_model*.safetensors"],
    quantization: "native",
    workflow_key: "video_ti2v",
    required_custom_nodes: [],
    minimum_vram: 24,
    minimum_ram: 64,
    estimated_disk: 35,
    license_note: "Apache-2.0 official Wan baseline. Public revision, core files, VAE, and text encoder metadata are locked for a future smoke benchmark.",
    license: "apache-2.0",
    status: "eligible_for_benchmark",
    sha256: "",
    slot: "rtx4090_video",
    origin: "official",
    benchmark_round: "first",
  },
  {
    key: "flux2-klein-9b-official",
    display_name: "FLUX.2 Klein 9B",
    task_type: "image",
    gpu_profiles: ["rtx5090"],
    source_repository: "black-forest-labs/FLUX.2-klein-9b-fp8",
    revision: "902d9d510b51533e07729f19211414a3648b77d2",
    expected_files: ["flux-2-klein-9b-fp8.safetensors"],
    quantization: "fp8",
    workflow_key: "image_t2i",
    required_custom_nodes: [],
    minimum_vram: 31,
    minimum_ram: 80,
    estimated_disk: 12,
    license_note: "Gated FLUX Non-Commercial 5090 image baseline. User must accept the Hugging Face/BFL terms before any sync or benchmark.",
    license: "flux-non-commercial-license",
    status: "gated_user_action_required",
    sha256: "",
    slot: "rtx5090_image",
    origin: "official",
    benchmark_round: "first",
  },
  {
    key: "flux2-dev-quant-5090",
    display_name: "FLUX.2 Dev Quantized Candidate",
    task_type: "image",
    gpu_profiles: ["rtx5090"],
    source_repository: "black-forest-labs/FLUX.2-dev-NVFP4",
    revision: "",
    expected_files: [],
    quantization: "quantized",
    workflow_key: "image_t2i",
    required_custom_nodes: [],
    minimum_vram: 31,
    minimum_ram: 80,
    estimated_disk: 36,
    license_note: "5090-only high-quality challenger placeholder. No official Blackwell/NVFP4 repository lock was proven in this checkpoint.",
    license: "pending_metadata_verification",
    status: "unverified",
    sha256: "",
    slot: "rtx5090_image",
    origin: "official",
    benchmark_round: "second",
  },
  {
    key: "wan22-a14b-i2v-fp8-official",
    display_name: "Wan2.2 A14B I2V FP8",
    task_type: "video",
    gpu_profiles: ["rtx5090"],
    source_repository: "Wan-AI/Wan2.2-I2V-A14B",
    revision: "206a9ee1b7bfaaf8f7e4d81335650533490646a3",
    expected_files: ["high_noise_model/", "low_noise_model/", "Wan2.1_VAE.pth", "models_t5_umt5-xxl-enc-bf16.pth"],
    quantization: "native-fp16",
    workflow_key: "video_i2v",
    required_custom_nodes: [],
    minimum_vram: 31,
    minimum_ram: 80,
    estimated_disk: 152,
    license_note: "Apache-2.0 official A14B I2V baseline. Public revision and sharded files are locked; 5090 compatibility remains an offload benchmark question.",
    license: "apache-2.0",
    status: "eligible_for_benchmark",
    sha256: "",
    slot: "rtx5090_video",
    origin: "official",
    benchmark_round: "first",
  },
  {
    key: "community-phr00t-aio-second-round",
    display_name: "Phr00t AIO community candidate",
    task_type: "video",
    gpu_profiles: ["rtx4090", "rtx5090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "community-aio",
    workflow_key: "video_ti2v",
    required_custom_nodes: [],
    minimum_vram: 24,
    minimum_ram: 64,
    estimated_disk: 60,
    license_note: "Second-round community candidate only. Exact Phr00t repository, revision, safetensors file, version directory, workflow, CLIP, and VAE are not locked.",
    license: "pending_metadata_verification",
    status: "unverified",
    sha256: "",
    slot: "rtx4090_video",
    origin: "community",
    benchmark_round: "second",
  },
  {
    key: "community-gguf-second-round",
    display_name: "Wan2.2 A14B GGUF community candidate",
    task_type: "video",
    gpu_profiles: ["rtx4090", "rtx5090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "gguf",
    workflow_key: "video_i2v",
    required_custom_nodes: ["comfyui_gguf"],
    minimum_vram: 24,
    minimum_ram: 64,
    estimated_disk: 30,
    license_note: "Second-round GGUF Q4/Q5/Q6 candidate only. Requires a fixed ComfyUI-GGUF commit and exact quantized files before benchmark.",
    license: "pending_metadata_verification",
    status: "unverified",
    sha256: "",
    slot: "rtx4090_video",
    origin: "community",
    benchmark_round: "second",
  },
  {
    key: "community-kijai-second-round",
    display_name: "Kijai workflow community candidate",
    task_type: "video",
    gpu_profiles: ["rtx4090", "rtx5090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "community",
    workflow_key: "video_i2v",
    required_custom_nodes: ["planned-kijai-node"],
    minimum_vram: 24,
    minimum_ram: 64,
    estimated_disk: 60,
    license_note: "Second-round Kijai WanVideoWrapper candidate only. Kijai is optional and cannot become a mandatory dependency for official native workflows.",
    license: "pending_metadata_verification",
    status: "unverified",
    sha256: "",
    slot: "rtx5090_video",
    origin: "community",
    benchmark_round: "second",
  },
  {
    key: "community-flf2v-second-round",
    display_name: "FLF2V community candidate",
    task_type: "video",
    gpu_profiles: ["rtx5090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "community",
    workflow_key: "video_flf2v",
    required_custom_nodes: ["planned-flf2v-node"],
    minimum_vram: 31,
    minimum_ram: 80,
    estimated_disk: 70,
    license_note: "Second-round FLF2V community workflow candidate only. I2V and FLF2V stay separate workflows until weights prove otherwise.",
    license: "pending_metadata_verification",
    status: "unverified",
    sha256: "",
    slot: "rtx5090_video",
    origin: "community",
    benchmark_round: "second",
  },
  {
    key: "community-wan22-fun-inp-second-round",
    display_name: "Wan2.2 Fun InP first/last-frame candidate",
    task_type: "video",
    gpu_profiles: ["rtx5090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "community",
    workflow_key: "video_flf2v",
    required_custom_nodes: ["planned-wan22-fun-node"],
    minimum_vram: 31,
    minimum_ram: 80,
    estimated_disk: 0,
    license_note: "Second-round first/last-frame candidate only. Not accepted into benchmark until exact model files and node dependencies are locked.",
    license: "pending_metadata_verification",
    status: "unverified",
    sha256: "",
    slot: "rtx5090_video",
    origin: "community",
    benchmark_round: "second",
  },
];

export function validateModelCandidate(candidate: ModelCandidate) {
  const errors: string[] = [];
  if (!candidate.key) errors.push("key is required");
  if (!candidate.display_name) errors.push("display_name is required");
  if (!["image", "video"].includes(candidate.task_type)) errors.push("task_type is invalid");
  if (candidate.gpu_profiles.length === 0) errors.push("gpu_profiles must not be empty");
  if (!candidate.workflow_key) errors.push("workflow_key is required");
  if (!candidate.license) errors.push("license is required");
  if (!MODEL_SLOTS.includes(candidate.slot)) errors.push("slot is invalid");
  if (!["unverified", "public_verified", "gated_user_action_required", "metadata_incomplete", "eligible_for_benchmark", "rejected_before_benchmark"].includes(candidate.status)) {
    errors.push("status is invalid");
  }
  if (candidate.sha256 !== "" && !/^[a-f0-9]{64}$/.test(candidate.sha256)) errors.push("sha256 must be empty or a real hex digest");
  if (candidate.status === "eligible_for_benchmark" && !/^[a-f0-9]{40}$/.test(candidate.revision)) {
    errors.push("eligible_for_benchmark candidates require a full revision SHA");
  }
  if (candidate.status === "eligible_for_benchmark" && candidate.expected_files.length === 0) {
    errors.push("eligible_for_benchmark candidates require expected files");
  }
  if (candidate.benchmark_round === "first" && candidate.origin !== "official") errors.push("first-round candidates must be official");
  return errors;
}

export function getCandidatesForSlot(slot: ModelSlotKey) {
  return MODEL_CANDIDATES.filter((candidate) => candidate.slot === slot);
}

export function getFirstRoundBaselines() {
  return MODEL_CANDIDATES.filter((candidate) => candidate.benchmark_round === "first");
}
