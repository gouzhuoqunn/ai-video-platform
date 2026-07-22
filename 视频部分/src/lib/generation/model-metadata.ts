import type { ModelCandidate } from "./model-registry";
import type { ModelCandidateStatus } from "./model-registry";

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
  metadataStatus: ModelCandidateStatus;
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
  workflowTask: "T2V" | "TI2V" | "I2V" | "FLF2V" | "T2I" | "image-editing";
  requiredVae: string[];
  requiredTextEncoders: string[];
  requiredVisionEncoders: string[];
  requiredCustomNodes: string[];
  linuxAmd64: true;
  commercialUse: "allowed" | "non_commercial";
  inventoryComplete: boolean;
  userActionRequired: string[];
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
    metadataStatus: "eligible_for_benchmark",
    repository: "black-forest-labs/FLUX.2-klein-4b-fp8",
    revision: "5b4408e59397a4a37ccb46afe426d8ed86379441",
    license: "apache-2.0",
    access: "public",
    anonymousReadable: true,
    lastUpdated: "2026-02-24",
    reportedTotalGb: 12.45,
    files: [
      {
        path: "flux-2-klein-4b-fp8.safetensors",
        reportedSizeGb: 4.07,
        storage: "xet",
        xetHash: "15005cf50d1361f75c61f7d213d7969063e2aaea7523beefe5d1e085d173568d",
        sha256: "97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6",
        verification: "official_metadata_verified",
      },
      {
        path: "Comfy-Org/vae-text-encorder-for-flux-klein-4b:split_files/text_encoders/qwen_3_4b.safetensors",
        reportedSizeGb: 8.04,
        storage: "lfs",
        xetHash: null,
        sha256: "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
        verification: "official_metadata_verified",
      },
      {
        path: "Comfy-Org/vae-text-encorder-for-flux-klein-4b:split_files/vae/flux2-vae.safetensors",
        reportedSizeGb: 0.336,
        storage: "lfs",
        xetHash: null,
        sha256: "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
        verification: "official_metadata_verified",
      },
    ],
    configType: "ComfyUI diffusion single-file",
    dtype: "FP8",
    architecture: "FLUX.2 Klein distilled 4B rectified-flow transformer",
    officialHardwareRequirement: "Comfy's 2026-01-16 Klein note cites 4B distilled at about 8.4GB VRAM on a 5090; the RTX 4090 run remains a benchmark question, not a support claim.",
    benchmarkNote: "The official template is subgraph-based and must be unpacked or registered before real GPU execution. Do not turn vendor speed claims into acceptance metrics.",
    officialWorkflowSource: "Comfy-Org/workflow_templates commit 192a158125390ce3caf4c64d38d406eaab85cd68 template templates/image_flux2_klein_image_edit_4b_distilled.json; auxiliary files locked from the actual public repository Comfy-Org/vae-text-encorder-for-flux-klein-4b commit a9e4ca87c16db4c4e1a16406a9ddb300ab0ae246.",
    workflowTask: "image-editing",
    requiredVae: ["flux2-vae.safetensors"],
    requiredTextEncoders: ["qwen_3_4b.safetensors"],
    requiredVisionEncoders: [],
    requiredCustomNodes: [],
    linuxAmd64: true,
    commercialUse: "allowed",
    inventoryComplete: true,
    userActionRequired: ["Before GPU execution, unpack or register the official ComfyUI subgraph template and run one smoke prompt only."],
  },
  {
    candidateKey: "wan22-ti2v-5b-official",
    metadataStatus: "eligible_for_benchmark",
    repository: "Wan-AI/Wan2.2-TI2V-5B",
    revision: "921dbaf3f1674a56f47e83fb80a34bac8a8f203e",
    license: "apache-2.0",
    access: "public",
    anonymousReadable: true,
    lastUpdated: "2025-08-07",
    reportedTotalGb: 34.2,
    files: [
      { path: "Wan2.2_VAE.pth", reportedSizeGb: 2.82, storage: "xet", xetHash: null, sha256: "20eb789667fa5e60e7516bf509512f6cb61f01b0aa0695eadaea930c13892b36", verification: "official_metadata_verified" },
      { path: "diffusion_pytorch_model-00001-of-00003.safetensors", reportedSizeGb: 9.83, storage: "xet", xetHash: null, sha256: "720b06c4ade5e87c1246bba8ac95b664c638749cd9b102cf84d823bb44c026a1", verification: "official_metadata_verified" },
      { path: "diffusion_pytorch_model-00002-of-00003.safetensors", reportedSizeGb: 10, storage: "xet", xetHash: null, sha256: "09ec5ef720d8396f6cfa51fbdcbdb2327e37722afd6e89fd38f1e7e5e782c283", verification: "official_metadata_verified" },
      { path: "diffusion_pytorch_model-00003-of-00003.safetensors", reportedSizeGb: 0.179, storage: "xet", xetHash: null, sha256: "6306f7894c345de9093ad588771c2abfaeb668a81f7a6d9a918bd26ba3568e49", verification: "official_metadata_verified" },
      UMT5_XXL_FILE,
    ],
    configType: "Wan2.2 native checkpoint",
    dtype: "BF16 checkpoint with runtime conversion/offload options",
    architecture: "Wan2.2 TI2V dense 5B with high-compression VAE",
    officialHardwareRequirement: "Wan's native README names 24GB VRAM with offload, dtype conversion, and CPU T5 for 720P.",
    benchmarkNote: "The official 5-second 720P timing is a marketing/reference result, not a pass threshold.",
    officialWorkflowSource: "ComfyUI built-in Wan2.2 5B video generation template",
    workflowTask: "TI2V",
    requiredVae: ["wan2.2_vae.safetensors"],
    requiredTextEncoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
    requiredVisionEncoders: [],
    requiredCustomNodes: [],
    linuxAmd64: true,
    commercialUse: "allowed",
    inventoryComplete: true,
    userActionRequired: [],
  },
  {
    candidateKey: "flux2-klein-9b-official",
    metadataStatus: "gated_user_action_required",
    repository: "black-forest-labs/FLUX.2-klein-9b-fp8",
    revision: "902d9d510b51533e07729f19211414a3648b77d2",
    license: "flux-non-commercial-license",
    access: "gated",
    anonymousReadable: false,
    lastUpdated: "2026-02-24",
    reportedTotalGb: 9.44,
    files: [
      { path: "flux-2-klein-9b-fp8.safetensors", reportedSizeGb: 9.43, storage: "xet", xetHash: null, sha256: "865ba09f5b4c3cbd3468a4bd3acb9fcb2f8740c54317482f0bcd4ed1d3655cee", verification: "gated_pending_acceptance" },
    ],
    configType: "ComfyUI diffusion single-file",
    dtype: "FP8",
    architecture: "FLUX.2 Klein distilled 9B rectified-flow transformer",
    officialHardwareRequirement: "The public model card reports about 29GB VRAM; this is a vendor statement, not the profile hard gate.",
    benchmarkNote: "Acceptance of BFL terms and a complete revision SHA are required before any download or benchmark plan becomes runnable.",
    officialWorkflowSource: "ComfyUI built-in Flux.2 Klein 9B Text-to-Image template",
    workflowTask: "T2I",
    requiredVae: ["flux2-vae.safetensors"],
    requiredTextEncoders: ["qwen_3_8b_fp8mixed.safetensors"],
    requiredVisionEncoders: [],
    requiredCustomNodes: [],
    linuxAmd64: true,
    commercialUse: "non_commercial",
    inventoryComplete: false,
    userActionRequired: ["Log in to Hugging Face and accept the FLUX Non-Commercial License Agreement and BFL acceptable-use prompt before any benchmark sync."],
  },
  {
    candidateKey: "wan22-a14b-i2v-fp8-official",
    metadataStatus: "eligible_for_benchmark",
    repository: "Wan-AI/Wan2.2-I2V-A14B",
    revision: "206a9ee1b7bfaaf8f7e4d81335650533490646a3",
    license: "apache-2.0",
    access: "public",
    anonymousReadable: true,
    lastUpdated: "2025-08-07",
    reportedTotalGb: 126.21,
    files: [
      { path: "high_noise_model/diffusion_pytorch_model-00001-of-00006.safetensors", reportedSizeGb: 9.99, storage: "xet", xetHash: null, sha256: "aeea563f9d38ec434b6761c497027ed2843220ee3efaf8c92c815255ade955e3", verification: "official_metadata_verified" },
      { path: "high_noise_model/diffusion_pytorch_model-00002-of-00006.safetensors", reportedSizeGb: 9.94, storage: "xet", xetHash: null, sha256: "fe3b3fcab2b50ff967d971eafbf45e24269c66adacc0881fd6e7f72cd24051e8", verification: "official_metadata_verified" },
      { path: "high_noise_model/diffusion_pytorch_model-00003-of-00006.safetensors", reportedSizeGb: 9.94, storage: "xet", xetHash: null, sha256: "c5d7ddaae0ef24ab452d852a7a53dde7bdad598cd8542e6824e65b0666f39e7f", verification: "official_metadata_verified" },
      { path: "high_noise_model/diffusion_pytorch_model-00004-of-00006.safetensors", reportedSizeGb: 9.84, storage: "xet", xetHash: null, sha256: "4e954c73022c0c8cfc09ebe1ad9aa069571af0c8954c0ed3a6b77c5c3d6b542d", verification: "official_metadata_verified" },
      { path: "high_noise_model/diffusion_pytorch_model-00005-of-00006.safetensors", reportedSizeGb: 9.84, storage: "xet", xetHash: null, sha256: "7c7328fa67ab849427db27145740a3b6531f915ae05f08c0b77c356fd1120be3", verification: "official_metadata_verified" },
      { path: "high_noise_model/diffusion_pytorch_model-00006-of-00006.safetensors", reportedSizeGb: 7.6, storage: "xet", xetHash: null, sha256: "a95d645bfdac3bf13f96d52299fac1a416c7a3bc8741a3ea58e5b7fd0eb3505f", verification: "official_metadata_verified" },
      { path: "low_noise_model/diffusion_pytorch_model-00001-of-00006.safetensors", reportedSizeGb: 9.99, storage: "xet", xetHash: null, sha256: "1127e3dea8c08cd746e36d1a7047a3197449adf13d90725ae0a276aeccaf8521", verification: "official_metadata_verified" },
      { path: "low_noise_model/diffusion_pytorch_model-00002-of-00006.safetensors", reportedSizeGb: 9.94, storage: "xet", xetHash: null, sha256: "8250fff242339c31ccb55236e3e1cc25566a2c1d777d1833f3231391fd7d0006", verification: "official_metadata_verified" },
      { path: "low_noise_model/diffusion_pytorch_model-00003-of-00006.safetensors", reportedSizeGb: 9.94, storage: "xet", xetHash: null, sha256: "d0f75d2f41fdab239dbc0624c13ca1c56d79196f2aa0ac57f5f5c68cb53220ea", verification: "official_metadata_verified" },
      { path: "low_noise_model/diffusion_pytorch_model-00004-of-00006.safetensors", reportedSizeGb: 9.84, storage: "xet", xetHash: null, sha256: "aa6119d3ebf5bae827a1fe19dc8e7cba9dbc5f798635a49f80cc0629ed8a74bf", verification: "official_metadata_verified" },
      { path: "low_noise_model/diffusion_pytorch_model-00005-of-00006.safetensors", reportedSizeGb: 9.84, storage: "xet", xetHash: null, sha256: "686cedb30b1696e1ba7034c9287cf1e96471aa997815bb6c183dff9fc7994663", verification: "official_metadata_verified" },
      { path: "low_noise_model/diffusion_pytorch_model-00006-of-00006.safetensors", reportedSizeGb: 7.6, storage: "xet", xetHash: null, sha256: "8b024bda8fb709ba69ec91f1efa5edc19e173d40dcb5b0936050c985167a1be9", verification: "official_metadata_verified" },
      { path: "Wan2.1_VAE.pth", reportedSizeGb: 0.508, storage: "xet", xetHash: null, sha256: "38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981", verification: "official_metadata_verified" },
      UMT5_XXL_FILE,
    ],
    configType: "Wan2.2 native MoE checkpoint",
    dtype: "FP16 reference checkpoint",
    architecture: "Wan2.2 I2V A14B two-expert MoE",
    officialHardwareRequirement: "Wan's native README names at least 80GB VRAM for its single-GPU reference runner with offload and dtype conversion.",
    benchmarkNote: "A 5090 run is an unproven offload benchmark, not an official support claim.",
    officialWorkflowSource: "ComfyUI built-in Wan2.2 14B I2V template",
    workflowTask: "I2V",
    requiredVae: ["wan_2.1_vae.safetensors"],
    requiredTextEncoders: ["umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
    requiredVisionEncoders: [],
    requiredCustomNodes: [],
    linuxAmd64: true,
    commercialUse: "allowed",
    inventoryComplete: true,
    userActionRequired: [],
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
