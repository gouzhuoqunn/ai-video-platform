import assert from "node:assert/strict";
import { findBootstrapImageCandidates } from "./bootstrap-image-profile";

const config = {
  targetGpu: "NVIDIA GeForce RTX 4090" as const,
  minGpuVramGb: 24,
  maxGpuPricePerHour: 0.7,
  minReliability: 0.99,
  minRating: 4.7,
  minRatingCount: 3,
  minRamGb: 64,
  minCpuCores: 8,
  minDiskGb: 200,
  minDownloadMbps: 300,
  minUploadMbps: 100,
  allowedCountries: [],
  rentalCurrency: "USD-Blockchain",
  dockerImage: "ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime@sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137",
  orderType: "on-demand" as const,
  projectTag: "ai-video-platform-wan22",
  assumedMinimumRentalHours: 6,
  excludedServerIds: ["91005"],
  apiBaseUrl: "https://example.test",
};
const candidates = findBootstrapImageCandidates([
  { id: 91005, gpu_name: "NVIDIA GeForce RTX 4090", gpu_memory_gb: 24, ram_gb: 64, disk_gb: 200, supports_docker: true, supports_ssh: true, rentable: true, type: "on-demand", price_usd_per_hour: 0.5 },
  { id: 20001, gpu_name: "NVIDIA GeForce RTX 3090", gpu_memory_gb: 24, ram_gb: 32, disk_gb: 120, supports_docker: true, supports_ssh: true, rentable: true, type: "on-demand", price_usd_per_hour: 0.5, rating: 4.8, reliability: 0.98 },
  { id: 20002, gpu_name: "NVIDIA A40", gpu_memory_gb: 48, ram_gb: 64, disk_gb: 240, supports_docker: true, supports_ssh: true, rentable: true, type: "on-demand", price_usd_per_hour: 0.5, rating: 4.9, reliability: 0.99 },
  { id: 20004, gpu_name: "NVIDIA RTX A6000", gpu_memory_gb: 48, ram_gb: 64, disk_gb: 240, supports_docker: true, supports_ssh: true, rentable: true, type: "on-demand", price_usd_per_hour: 0.5, rating: 5, reliability: 0.999 },
  { id: 20003, gpu_name: "NVIDIA RTX 3080", gpu_memory_gb: 10, ram_gb: 64, disk_gb: 200, supports_docker: true, supports_ssh: true, rentable: true, type: "on-demand", price_usd_per_hour: 0.5 },
] as never, config);
assert.equal(candidates.length, 3);
assert.equal(candidates[0].serverId, "20002");
assert.equal(candidates[0].runtimeGpuProfile, "ampere_image_gpu");
assert.equal(candidates[1].serverId, "20004");
assert.equal(candidates[2].serverId, "20001");
assert.ok(candidates.every((candidate) => candidate.projectedFirstImageCostUsd !== null && candidate.projectedFirstImageCostUsd <= 2.5));
console.log("Bootstrap first-image GPU profile tests passed.");
