import type { GpuProfileKey } from "./gpu-profiles";

export type TaskType = "image" | "video";
export type ModelSlotKey = "rtx4090_image" | "rtx4090_video" | "rtx5090_image" | "rtx5090_video";
export type ModelCandidateStatus = "planned" | "metadata_verified" | "runnable" | "benchmarked" | "rejected" | "production";

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

export const MODEL_SLOTS: ModelSlotKey[] = ["rtx4090_image", "rtx4090_video", "rtx5090_image", "rtx5090_video"];

export const MODEL_CANDIDATES: ModelCandidate[] = [
  {
    key: "flux2-klein-4b-official",
    display_name: "FLUX.2 Klein 4B",
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
    estimated_disk: 6,
    license_note: "Apache-2.0 distilled FP8 baseline. ComfyUI auxiliary component hashes remain pending download verification.",
    license: "apache-2.0",
    status: "metadata_verified",
    sha256: "",
    slot: "rtx4090_image",
    origin: "official",
    benchmark_round: "first",
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
    license_note: "Official Wan baseline already pinned for the first GPU session.",
    license: "apache-2.0",
    status: "metadata_verified",
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
    revision: "",
    expected_files: [],
    quantization: "fp8",
    workflow_key: "image_t2i",
    required_custom_nodes: [],
    minimum_vram: 31,
    minimum_ram: 80,
    estimated_disk: 12,
    license_note: "Gated FLUX Non-Commercial baseline. Full revision and auxiliary component metadata require explicit license acceptance.",
    license: "flux-non-commercial-license",
    status: "planned",
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
    license_note: "Quantized official-family candidate; requires metadata and license verification.",
    license: "pending_metadata_verification",
    status: "planned",
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
    license_note: "Apache-2.0 official A14B I2V baseline. Native Wan README names 80GB VRAM for its reference runner; 5090 compatibility remains benchmark-only.",
    license: "apache-2.0",
    status: "metadata_verified",
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
    license_note: "Second-round community candidate only; not approved for production.",
    license: "pending_metadata_verification",
    status: "planned",
    sha256: "",
    slot: "rtx4090_video",
    origin: "community",
    benchmark_round: "second",
  },
  {
    key: "community-gguf-second-round",
    display_name: "GGUF community candidate",
    task_type: "image",
    gpu_profiles: ["rtx4090", "rtx5090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "gguf",
    workflow_key: "image_t2i",
    required_custom_nodes: [],
    minimum_vram: 24,
    minimum_ram: 64,
    estimated_disk: 30,
    license_note: "Second-round community candidate only; not approved for production.",
    license: "pending_metadata_verification",
    status: "planned",
    sha256: "",
    slot: "rtx4090_image",
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
    license_note: "Second-round community candidate only; not approved for production.",
    license: "pending_metadata_verification",
    status: "planned",
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
    license_note: "Second-round community candidate only; not approved for production.",
    license: "pending_metadata_verification",
    status: "planned",
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
    license_note: "Second-round community candidate only; not approved for production.",
    license: "pending_metadata_verification",
    status: "planned",
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
  if (!["planned", "metadata_verified", "runnable", "benchmarked", "rejected", "production"].includes(candidate.status)) {
    errors.push("status is invalid");
  }
  if (candidate.sha256 !== "" && !/^[a-f0-9]{64}$/.test(candidate.sha256)) errors.push("sha256 must be empty or a real hex digest");
  if (candidate.status === "production" && candidate.origin !== "official") errors.push("community candidates cannot be production");
  if (candidate.status === "metadata_verified" && !/^[a-f0-9]{40}$/.test(candidate.revision)) {
    errors.push("metadata_verified candidates require a full revision SHA");
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
