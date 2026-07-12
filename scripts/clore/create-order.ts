import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadCloreConfig, PROJECT_TAG } from "./config";
import { assertNoSecretOutput } from "./client";
import { verifyDockerImage } from "./docker-image";
import { readLiveMarketplace, readWalletSummary } from "./live";
import { applyWalletBalance, evaluateMarketplace, summarizeCandidate } from "./marketplace";
import { loadCloreExecutionConfig } from "./execution-config";
import { buildCreateOrderBody, createCloreOrder, prepareCreateOrderFromLive } from "./order-execution";
import { inspectSshPublicKey } from "./ssh";
import type { OrderPlan } from "./types";
import { loadModelCacheConfig } from "../model-cache/config";

const PLAN_PATH = path.join(process.cwd(), ".secrets", "clore-order-plan.json");

function getArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function getLifecycleCommand() {
  return process.env.npm_lifecycle_event ?? "";
}

function assertExecuteGuards(configProjectTag: string) {
  const execute = process.argv.includes("--execute");
  if (!execute) {
    return false;
  }

  if (getLifecycleCommand() === "clore:create:dry") {
    throw new Error("clore:create:dry never accepts --execute. Use npm run clore:create for the future real entry point.");
  }

  const serverId = getArg("server-id");
  const maxPrice = getArg("max-price");
  const confirmProject = getArg("confirm-project");
  if (!serverId || !maxPrice || confirmProject !== PROJECT_TAG || configProjectTag !== PROJECT_TAG) {
    throw new Error(
      "Future execute mode requires --server-id, --max-price, --confirm-project ai-video-platform-wan22, and matching CLORE_PROJECT_TAG.",
    );
  }

  return true;
}

async function buildPlan(): Promise<OrderPlan> {
  const config = loadCloreConfig();
  assertExecuteGuards(config.projectTag);
  const wallet = await readWalletSummary(config);
  const { matches } = evaluateMarketplace(await readLiveMarketplace(config), config);
  const selected = applyWalletBalance(matches, wallet.availableUsdBalance)[0] ?? null;
  const image = await verifyDockerImage(config.dockerImage);
  const ssh = inspectSshPublicKey(config.sshPublicKeyPath ?? "");

  const now = new Date();
  const expires = new Date(now.getTime() + 10 * 60 * 1000);
  return {
    dryRun: true,
    selected,
    dockerImage: config.dockerImage,
    dockerImageVerified: image.exists && image.linuxAmd64,
    dockerImagePlatform: image.linuxAmd64 ? "linux/amd64" : "not verified",
    sshPublicKeyPath: ssh.path,
    sshPublicKeyExists: ssh.exists,
    sshPublicKeyFormatValid: ssh.formatValid,
    currency: config.rentalCurrency,
    availableUsdBalance: wallet.availableUsdBalance,
    minimumRentalHours: config.assumedMinimumRentalHours,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

function writePlan(plan: OrderPlan) {
  mkdirSync(path.dirname(PLAN_PATH), { recursive: true });
  const minimumBillingConfirmed = plan.selected?.minRentalHours !== null && plan.selected?.minRentalHours !== undefined;
  const safePlan = {
    plan_status: "dry_run_only",
    selected_server_id: plan.selected?.serverId ?? null,
    gpu: plan.selected?.gpu ?? null,
    order_type: "on-demand",
    spot: false,
    usd_per_hour: plan.selected?.priceUsdPerHour ?? null,
    original_price_amount: plan.selected?.priceOriginalAmount ?? null,
    original_price_currency: plan.selected?.priceOriginalCurrency ?? null,
    original_price_unit: plan.selected?.priceOriginalUnit ?? null,
    original_price_label: plan.selected?.priceOriginalLabel ?? null,
    normalized_usd_per_hour: plan.selected?.priceUsdPerHour ?? null,
    minimum_rental_hours: plan.minimumRentalHours,
    minimum_billing_source: minimumBillingConfirmed ? "marketplace_field" : "api_not_confirmed",
    one_hour_cost_usd: plan.selected?.priceUsdPerHour ?? null,
    six_hour_cost_usd: plan.selected?.sixHourCostUsd ?? null,
    platform_total_price: plan.selected?.platformTotalPrice ?? null,
    platform_total_price_status: plan.selected?.platformTotalPrice === null ? "api_not_confirmed" : "provided_by_api",
    gpu_memory_raw_value: plan.selected?.gpuMemoryRawValue ?? null,
    gpu_memory_raw_unit: plan.selected?.gpuMemoryRawUnit ?? null,
    gpu_memory_mib: plan.selected?.gpuMemoryMiB ?? null,
    gpu_memory_accepted: plan.selected?.gpuMemoryAccepted ?? null,
    gpu_memory_note: plan.selected?.gpuMemoryNote ?? null,
    ram_gb: plan.selected?.ramGb ?? null,
    cpu_cores: plan.selected?.cpuCores ?? null,
    disk_gb: plan.selected?.diskGb ?? null,
    download_mbps: plan.selected?.downloadMbps ?? null,
    upload_mbps: plan.selected?.uploadMbps ?? null,
    reliability: plan.selected?.reliability ?? null,
    rating: plan.selected?.rating ?? null,
    rating_count: plan.selected?.ratingCount ?? null,
    country: plan.selected?.country ?? null,
    available_usd_balance: plan.availableUsdBalance,
    usable_balance_after_1_usd_reserve:
      plan.availableUsdBalance === null ? null : Number(Math.max(0, plan.availableUsdBalance - 1).toFixed(4)),
    docker_image: plan.dockerImage,
    docker_image_verified: plan.dockerImageVerified,
    ports: ["ssh/tcp"],
    project_tag: PROJECT_TAG,
    ssh_public_key_path: plan.sshPublicKeyPath,
    created_at: plan.createdAt,
    expires_at: plan.expiresAt,
  };
  writeFileSync(PLAN_PATH, `${JSON.stringify(safePlan, null, 2)}\n`, "utf8");
}

async function main() {
  const config = loadCloreConfig();
  const execute = assertExecuteGuards(config.projectTag);
  if (execute) {
    const execution = loadCloreExecutionConfig();
    if (!execution.enabled) {
      throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false. Refusing real create_order.");
    }
    const serverId = getArg("server-id") ?? "";
    const maxPrice = Number(getArg("max-price"));
    const queuedJobs = Number(getArg("queued-jobs") ?? 1);
    const prepared = await prepareCreateOrderFromLive({
      config,
      execution,
      serverId,
      maxPriceUsdPerHour: maxPrice,
      queuedJobCount: queuedJobs,
    });
    const result = await createCloreOrder({
      config,
      execution,
      candidate: prepared.candidate,
      requestBody: prepared.requestBody,
    });
    const output = JSON.stringify(
      {
        banner: "REAL CREATE ORDER EXECUTED",
        ...result,
        server_id: prepared.candidate.serverId,
        sends_clore_api_key_to_gpu: false,
        sends_supabase_secret_key_to_gpu: false,
        open_ports: ["ssh/tcp"],
      },
      null,
      2,
    );
    assertNoSecretOutput(output);
    console.log(output);
    return;
  }
  const plan = await buildPlan();
  const modelCache = loadModelCacheConfig();
  const minimumBillingConfirmed = plan.selected?.minRentalHours !== null && plan.selected?.minRentalHours !== undefined;
  writePlan(plan);
  const payload = {
    banner: "DRY RUN - NO ORDER CREATED",
    order_action: "no create_order call was made",
    selected: plan.selected ? summarizeCandidate(plan.selected) : null,
    estimated_costs: {
      one_hour_usd: plan.selected?.priceUsdPerHour ?? null,
      six_hours_usd: plan.selected?.sixHourCostUsd === null || plan.selected?.sixHourCostUsd === undefined ? null : Number(plan.selected.sixHourCostUsd.toFixed(2)),
      available_usd_balance: plan.availableUsdBalance,
      usable_after_1_usd_reserve: plan.availableUsdBalance === null ? null : Number(Math.max(0, plan.availableUsdBalance - 1).toFixed(2)),
      balance_sufficient_for_6h: plan.selected?.balanceSufficientForSixHours ?? "unknown",
      theoretical_hours_from_balance:
        plan.availableUsdBalance !== null && plan.selected?.priceUsdPerHour ? Number((plan.availableUsdBalance / plan.selected.priceUsdPerHour).toFixed(2)) : null,
      theoretical_hours_after_1_usd_reserve:
        plan.availableUsdBalance !== null && plan.selected?.priceUsdPerHour ? Number((Math.max(0, plan.availableUsdBalance - 1) / plan.selected.priceUsdPerHour).toFixed(2)) : null,
      two_six_hour_sessions_usd:
        plan.selected?.sixHourCostUsd === null || plan.selected?.sixHourCostUsd === undefined ? null : Number((plan.selected.sixHourCostUsd * 2).toFixed(2)),
      estimated_balance_after_two_6h_sessions:
        plan.availableUsdBalance !== null && plan.selected?.sixHourCostUsd ? Number((plan.availableUsdBalance - plan.selected.sixHourCostUsd * 2).toFixed(2)) : null,
      minimum_billing: {
        hours: plan.minimumRentalHours,
        source: minimumBillingConfirmed ? "marketplace field" : "API not confirmed; verify on Clore order confirmation screen before real create.",
        billing_models_shown: ["actual minutes if Clore bills by elapsed time", "6 hour planning session"],
      },
    },
    runtime: {
      docker_image: plan.dockerImage,
      docker_image_tag_verified: plan.dockerImageVerified,
      docker_image_platform: plan.dockerImagePlatform,
      currency: plan.currency,
      project_tag: PROJECT_TAG,
      ssh_public_key_path: plan.sshPublicKeyPath,
      ssh_public_key_configured: plan.sshPublicKeyExists,
      ssh_public_key_format_valid: plan.sshPublicKeyFormatValid,
      open_ports: ["ssh/tcp"],
      blocked_ports: ["http", "jupyter", "gradio", "comfyui", "8888", "8188", "7860", "8000"],
      sends_clore_api_key_to_gpu: false,
      sends_supabase_secret_key_to_gpu: false,
      sends_r2_write_credentials_to_gpu: false,
      sends_env_local_to_gpu: false,
      uploads_ssh_private_key: false,
      sends_limited_gpu_worker_env_later: true,
      startup_mode: "official CUDA base image plus SSH/bootstrap",
      wan_model_dir: "/workspace/models/Wan2.2-TI2V-5B",
      worker_code_dir: "/workspace/app/gpu-worker",
      temp_job_dir: "/workspace/jobs",
      first_model_source: "official Hugging Face fallback",
      r2_configured_now: modelCache.provider === "r2" && modelCache.r2Enabled && Boolean(modelCache.bucket) && Boolean(modelCache.endpoint),
      r2_bucket_configured: Boolean(modelCache.bucket),
      r2_prefix: modelCache.prefix,
      estimated_model_disk_gb: "80-120",
      estimated_first_bootstrap_time: "30-90 minutes depending on network and Hugging Face download speed",
      create_order_body_shape: buildCreateOrderBody({
        serverId: plan.selected?.serverId ?? "0",
        image: plan.dockerImage,
        currency: plan.currency,
        sshPublicKey: "ssh-ed25519 <public-key-redacted>",
        maxPriceUsdPerHour: plan.selected?.priceUsdPerHour ?? 0,
      }),
    },
    first_run_notes: [
      "Model download must happen only on the rented GPU/model volume after an intentional rental.",
      "Plan expires quickly; re-query before any future real rental.",
      "Stop if no reliable RTX 5090 is available. Do not auto-fallback to spot or 4090.",
      "After order creation, run npm run clore:status and keep the cancel command ready: npm run clore:cancel -- --execute --order-id=<id>.",
    ],
    plan_created_at: plan.createdAt,
    plan_expires_at: plan.expiresAt,
    plan_file: ".secrets/clore-order-plan.json",
  };
  const output = JSON.stringify(payload, null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "clore create dry-run failed");
  process.exitCode = 1;
});
