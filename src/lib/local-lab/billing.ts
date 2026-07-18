import "server-only";

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getLocalLabSessionSummary, getLocalLabWallet } from "./clore-console";
import { readGpuBillingStatus } from "../../../scripts/gpu-billing-status";
import { loadR2Credentials } from "../../../scripts/model-cache/r2-presign";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

export const R2_STANDARD_STORAGE_PRICING = { freeGbMonth: 10, usdPerGbMonth: 0.015, asOf: "2026-07-18" } as const;
const CACHE_TTL_MS = 60_000;
let cached: { expiresAt: number; value: BillingAggregate } | null = null;

export type BillingAggregate = {
  fetchedAt: string;
  clore: Record<string, unknown>;
  runpod: Record<string, unknown>;
  r2: Record<string, unknown>;
  supabase: Record<string, unknown>;
  github: Record<string, unknown>;
  modelSources: Record<string, unknown>;
};

function projectSpend() {
  const root = process.env.LOCAL_VIDEO_LIBRARY_DIR?.trim() || "D:\\AI-Video-Library";
  let spend = 0;
  if (!existsSync(root)) return 0;
  for (const date of readdirSync(root)) {
    const dateDir = path.join(root, date);
    if (!statSync(dateDir).isDirectory()) continue;
    for (const job of readdirSync(dateDir)) {
      const evidence = path.join(dateDir, job, "provider-session.json");
      if (!existsSync(evidence)) continue;
      try { const value = JSON.parse(readFileSync(evidence, "utf8")) as Record<string, unknown>; spend += Number(value.spendUsd ?? value.approximateSpendUsd ?? 0) || 0; } catch { /* ignore malformed evidence */ }
    }
  }
  return Number(spend.toFixed(4));
}

async function r2Summary() {
  try {
    const credentials = loadR2Credentials("model-cache-readonly.env");
    const client = new S3Client({ region: "auto", endpoint: credentials.endpoint, credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey } });
    const objects: Array<{ key: string; bytes: number }> = [];
    let continuationToken: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: credentials.bucket, ContinuationToken: continuationToken }));
      for (const object of page.Contents ?? []) if (object.Key) objects.push({ key: object.Key, bytes: Number(object.Size ?? 0) });
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    const total = objects.reduce((sum, object) => sum + object.bytes, 0);
    const production = objects.filter((object) => object.key.startsWith("production/")).reduce((sum, object) => sum + object.bytes, 0);
    const legacy = total - production;
    const billableGb = Math.max(0, total / 1024 ** 3 - R2_STANDARD_STORAGE_PRICING.freeGbMonth);
    return { connected: true, objectCount: objects.length, totalBytes: total, productionBytes: production, legacyBytes: legacy, estimatedMonthlyStorageUsd: Number((billableGb * R2_STANDARD_STORAGE_PRICING.usdPerGbMonth).toFixed(4)), operationCharges: "未估算（请求次数未统计）", pricing: R2_STANDARD_STORAGE_PRICING };
  } catch (error) {
    return { connected: false, error: error instanceof Error ? error.message : "R2 inventory unavailable", pricing: R2_STANDARD_STORAGE_PRICING };
  }
}

export async function getBillingAggregate(force = false): Promise<BillingAggregate> {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  const [cloreResult, gpuResult, r2Result] = await Promise.allSettled([getLocalLabWallet(), readGpuBillingStatus(), r2Summary()]);
  const session = getLocalLabSessionSummary();
  const cloreWallet = cloreResult.status === "fulfilled" ? cloreResult.value as Record<string, unknown> : { error: String(cloreResult.reason) };
  const gpu = gpuResult.status === "fulfilled" ? gpuResult.value as Record<string, unknown> : { error: String(gpuResult.reason) };
  const r2 = r2Result.status === "fulfilled" ? r2Result.value : { connected: false, error: String(r2Result.reason), pricing: R2_STANDARD_STORAGE_PRICING };
  const value: BillingAggregate = {
    fetchedAt: new Date().toISOString(),
    clore: { ...cloreWallet, activeOrderCount: (gpu.clore as Record<string, unknown> | undefined)?.activeOrders ?? 0, providerHold: (gpu.holds as Record<string, unknown> | undefined)?.clore ?? session.deploymentHold === true, currentSpendRate: null, knownProjectSpendUsd: projectSpend(), lastSessionSpendUsd: null },
    runpod: { activePods: (gpu.runpod as Record<string, unknown> | undefined)?.activePods ?? null, activeVolumes: (gpu.runpod as Record<string, unknown> | undefined)?.networkVolumes ?? null, providerHold: (gpu.holds as Record<string, unknown> | undefined)?.runpod ?? null, billing: "余额需登录查看" },
    r2,
    supabase: { connected: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL), billing: "账单与额度需登录查看", databaseHealth: "沿用现有认证路径" },
    github: { workflow: "需登录查看", billing: "账单用量需登录查看" },
    modelSources: { civitai: { configured: Boolean(process.env.CIVITAI_API_TOKEN), note: "本项目不维护该平台余额" }, huggingFace: { configured: Boolean(process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN), note: "本项目不维护该平台余额" } },
  };
  cached = { expiresAt: Date.now() + CACHE_TTL_MS, value };
  return value;
}
