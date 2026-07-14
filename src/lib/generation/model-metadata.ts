import type { ModelCandidate } from "./model-registry";

export type MetadataVerification = "official_metadata_verified" | "gated_pending_acceptance" | "pending_download_verification";

export type ModelFileAudit = {
  path: string;
  reportedSizeGb: number | null;
  storage: "xet" | "lfs" | "git" | "unknown";
  xetHash: string | null;
  sha256: string | null;
  verification: MetadataVerification;
};

export type ModelMetadataAudit = {
  candidateKey: ModelCandidate["key"];
  repository: string;
  revision: string | null;
  license: string;
  access: "public" | "gated";
  anonymousReadable: boolean;
  lastUpdated: string;
  reportedTotalGb: number | null;
  files: ModelFileAudit[];
  configType: string;
  dtype: string;
  architecture: string;
  officialHardwareRequirement: string;
  benchmarkNote: string;
  officialWorkflowSource: string;
  requiredVae: string[];
  requiredTextEncoders: string[];
  requiredVisionEncoders: string[];
  requiredCustomNodes: string[];
  linuxAmd64: true;
  commercialUse: "allowed" | "non_commercial";
  inventoryComplete: boolean;
};

const UMT5_XXL_FILE: ModelFileAudit = {
  path: "models_t5_umt5-xxl-enc-bf16.pth",
  reportedSizeGb: 11.4,
  storage: "xet",
  xetHash: "3e714e0465e395272125efc1e40285f98f7db81956d921339db5938e2ec4f6f3",
  sha256: "7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d",
  verification: "official_metadata_verified",
};

export const FIRST_ROUND_METADATA_AUDITS: ModelMetadataAudit[] = [
  {
    candidateKey: "flux2-klein-4b-official",
    repository: "black-forest-labs/FLUX.2-klein-4b-fp8",
    revision: "5b4408e59397a4a37ccb46afe426d8ed86379441",
    license: "apache-2.0",
    access: "public",
    anonymousReadable: true,
    lastUpdated: "2026-02-24",
    reportedTotalGb: 4.08,
    files: [
      {
        path: "flux-2-klein-4b-fp8.safetensors",
        reportedSizeGb: 4.07,
        storage: "xet",
        xetHash: "15005cf50d1361f75c61f7d213d7969063e2aaea7523beefe5d1e085d173568d",
        sha256: "97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6",
        verification: "official_metadata_verified",
      },
    ],
    configType: "ComfyUI diffusion single-file",
    dtype: "FP8",
    architecture: "FLUX.2 Klein distilled 4B rectified-flow transformer",
    officialHardwareRequirement: "The BFL model card cites consumer hardware; ComfyUI's native guide lists this FP8 distilled workflow separately.",
    benchmarkNote: "Do not turn vendor speed claims into acceptance metrics.",
    officialWorkflowSource: "ComfyUI built-in Flux.2 Klein 4B Text-to-Image template",
    requiredVae: ["flux2-vae.safetensors"],
    requiredTextEncoders: ["qwen_3_4b.safetensors"],
    requiredVisionEncoders: [],
    requiredCustomNodes: [],
    linuxAmd64: true,
    commercialUse: "allowed",
    inventoryComplete: false,
  },
  {
    candidateKey: "wan22-ti2v-5b-official",
    repository: "Wan-AI/Wan2.2-TI2V-5B",
    revision: "921dbaf3f1674a56f47e83fb80a34bac8a8f203e",
    license: "apache-2.0",
    access: "public",
    anonymousReadable: true,
    lastUpdated: "2025-08-07",
    reportedTotalGb: 34.2,
    files: [
      { path: "Wan2.2_VAE.pth", reportedSizeGb: 2.82, storage: "xet", xetHash: null, sha256: null, verification: "pending_download_verification" },
      { path: "diffusion_pytorch_model-00001-of-00003.safetensors", reportedSizeGb: 9.83, storage: "xet", xetHash: null, sha256: null, verification: "pending_download_verification" },
      { path: "diffusion_pytorch_model-00002-of-00003.safetensors", reportedSizeGb: 10, storage: "xet", xetHash: null, sha256: null, verification: "pending_download_verification" },
      { path: "diffusion_pytorch_model-00003-of-00003.safetensors", reportedSizeGb: 0.179, storage: "xet", xetHash: null, sha256: null, verification: "pending_download_verification" },
      UMT5_XXL_FILE,
    ],
    configType: "Wan2.2 native checkpoint",
    dtype: "BF16 checkpoint with runtime conversion/offload options",
    architecture: "Wan2.2 TI2V dense 5B with high-compression VAE",
    officialHardwareRequirement: "Wan's native README names 24GB VRAM with offload, dtype conversion, and CPU T5 for 720P.",
    benchmarkNote: "The official 5-second 720P timing is a marketing/reference result, not a pass threshold.",
    officialWorkflowSource: "ComfyUI built-in Wan2.2 5B video generation template",
    requiredVae: ["wan2.2_vae.safetensors"],
    requiredTextEncoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
    requiredVisionEncoders: [],
    requiredCustomNodes: [],
    linuxAmd64: true,
    commercialUse: "allowed",
    inventoryComplete: true,
  },
  {
    candidateKey: "flux2-klein-9b-official",
    repository: "black-forest-labs/FLUX.2-klein-9b-fp8",
    revision: null,
    license: "flux-non-commercial-license",
    access: "gated",
    anonymousReadable: false,
    lastUpdated: "2026-02-24",
    reportedTotalGb: 9.44,
    files: [
      { path: "flux-2-klein-9b-fp8.safetensors", reportedSizeGb: 9.43, storage: "xet", xetHash: null, sha256: null, verification: "gated_pending_acceptance" },
    ],
    configType: "ComfyUI diffusion single-file",
    dtype: "FP8",
    architecture: "FLUX.2 Klein distilled 9B rectified-flow transformer",
    officialHardwareRequirement: "The public model card reports about 29GB VRAM; this is a vendor statement, not the profile hard gate.",
    benchmarkNote: "Acceptance of BFL terms and a complete revision SHA are required before any download or benchmark plan becomes runnable.",
    officialWorkflowSource: "ComfyUI built-in Flux.2 Klein 9B Text-to-Image template",
    requiredVae: ["flux2-vae.safetensors"],
    requiredTextEncoders: ["qwen_3_8b_fp8mixed.safetensors"],
    requiredVisionEncoders: [],
    requiredCustomNodes: [],
    linuxAmd64: true,
    commercialUse: "non_commercial",
    inventoryComplete: false,
  },
  {
    candidateKey: "wan22-a14b-i2v-fp8-official",
    repository: "Wan-AI/Wan2.2-I2V-A14B",
    revision: "206a9ee1b7bfaaf8f7e4d81335650533490646a3",
    license: "apache-2.0",
    access: "public",
    anonymousReadable: true,
    lastUpdated: "2025-08-07",
    reportedTotalGb: 126.21,
    files: [
      { path: "high_noise_model/", reportedSizeGb: null, storage: "xet", xetHash: null, sha256: null, verification: "pending_download_verification" },
      { path: "low_noise_model/", reportedSizeGb: null, storage: "xet", xetHash: null, sha256: null, verification: "pending_download_verification" },
      { path: "Wan2.1_VAE.pth", reportedSizeGb: 0.508, storage: "xet", xetHash: null, sha256: null, verification: "pending_download_verification" },
      UMT5_XXL_FILE,
    ],
    configType: "Wan2.2 native MoE checkpoint",
    dtype: "FP16 reference checkpoint",
    architecture: "Wan2.2 I2V A14B two-expert MoE",
    officialHardwareRequirement: "Wan's native README names at least 80GB VRAM for its single-GPU reference runner with offload and dtype conversion.",
    benchmarkNote: "A 5090 run is an unproven offload benchmark, not an official support claim.",
    officialWorkflowSource: "ComfyUI built-in Wan2.2 14B I2V template",
    requiredVae: ["wan_2.1_vae.safetensors"],
    requiredTextEncoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
    requiredVisionEncoders: [],
    requiredCustomNodes: [],
    linuxAmd64: true,
    commercialUse: "allowed",
    inventoryComplete: false,
  },
];

export function isFullRevision(revision: string | null): revision is string {
  return Boolean(revision && /^[a-f0-9]{40}$/.test(revision));
}

export function getMetadataAudit(candidateKey: string) {
  return FIRST_ROUND_METADATA_AUDITS.find((audit) => audit.candidateKey === candidateKey);
}

export function getReportedBaselineTotalGb() {
  return FIRST_ROUND_METADATA_AUDITS.reduce((total, audit) => total + (audit.reportedTotalGb ?? 0), 0);
}
