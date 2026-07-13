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
  status: ModelCandidateStatus;
  sha256: string;
  slot: ModelSlotKey;
  origin: "official" | "community";
};

export const MODEL_SLOTS: ModelSlotKey[] = ["rtx4090_image", "rtx4090_video", "rtx5090_image", "rtx5090_video"];

export const MODEL_CANDIDATES: ModelCandidate[] = [
  {
    key: "flux2-klein-4b-official",
    display_name: "FLUX.2 Klein 4B",
    task_type: "image",
    gpu_profiles: ["rtx4090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "planned",
    workflow_key: "image_t2i",
    required_custom_nodes: [],
    minimum_vram: 24,
    minimum_ram: 64,
    estimated_disk: 24,
    license_note: "Official baseline candidate; metadata still needs verification before download.",
    status: "planned",
    sha256: "",
    slot: "rtx4090_image",
    origin: "official",
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
    status: "metadata_verified",
    sha256: "",
    slot: "rtx4090_video",
    origin: "official",
  },
  {
    key: "flux2-klein-9b-official",
    display_name: "FLUX.2 Klein 9B",
    task_type: "image",
    gpu_profiles: ["rtx5090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "planned",
    workflow_key: "image_t2i",
    required_custom_nodes: [],
    minimum_vram: 31,
    minimum_ram: 80,
    estimated_disk: 42,
    license_note: "Official baseline candidate; metadata still needs verification before download.",
    status: "planned",
    sha256: "",
    slot: "rtx5090_image",
    origin: "official",
  },
  {
    key: "flux2-dev-quant-5090",
    display_name: "FLUX.2 Dev Quantized Candidate",
    task_type: "image",
    gpu_profiles: ["rtx5090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "quantized",
    workflow_key: "image_t2i",
    required_custom_nodes: [],
    minimum_vram: 31,
    minimum_ram: 80,
    estimated_disk: 36,
    license_note: "Quantized official-family candidate; requires metadata and license verification.",
    status: "planned",
    sha256: "",
    slot: "rtx5090_image",
    origin: "official",
  },
  {
    key: "wan22-a14b-i2v-fp8-official",
    display_name: "Wan2.2 A14B I2V FP8",
    task_type: "video",
    gpu_profiles: ["rtx5090"],
    source_repository: "",
    revision: "",
    expected_files: [],
    quantization: "fp8",
    workflow_key: "video_i2v",
    required_custom_nodes: [],
    minimum_vram: 31,
    minimum_ram: 80,
    estimated_disk: 70,
    license_note: "Official 5090 video baseline; repository metadata still needs verification.",
    status: "planned",
    sha256: "",
    slot: "rtx5090_video",
    origin: "official",
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
    status: "planned",
    sha256: "",
    slot: "rtx4090_video",
    origin: "community",
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
    status: "planned",
    sha256: "",
    slot: "rtx4090_image",
    origin: "community",
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
    status: "planned",
    sha256: "",
    slot: "rtx5090_video",
    origin: "community",
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
    status: "planned",
    sha256: "",
    slot: "rtx5090_video",
    origin: "community",
  },
];

export function validateModelCandidate(candidate: ModelCandidate) {
  const errors: string[] = [];
  if (!candidate.key) errors.push("key is required");
  if (!candidate.display_name) errors.push("display_name is required");
  if (!["image", "video"].includes(candidate.task_type)) errors.push("task_type is invalid");
  if (candidate.gpu_profiles.length === 0) errors.push("gpu_profiles must not be empty");
  if (!candidate.workflow_key) errors.push("workflow_key is required");
  if (!MODEL_SLOTS.includes(candidate.slot)) errors.push("slot is invalid");
  if (!["planned", "metadata_verified", "runnable", "benchmarked", "rejected", "production"].includes(candidate.status)) {
    errors.push("status is invalid");
  }
  if (candidate.sha256 !== "" && !/^[a-f0-9]{64}$/.test(candidate.sha256)) errors.push("sha256 must be empty or a real hex digest");
  if (candidate.status === "production" && candidate.origin !== "official") errors.push("community candidates cannot be production");
  return errors;
}

export function getCandidatesForSlot(slot: ModelSlotKey) {
  return MODEL_CANDIDATES.filter((candidate) => candidate.slot === slot);
}
