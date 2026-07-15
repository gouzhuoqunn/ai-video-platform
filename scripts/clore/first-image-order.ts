import { readFileSync } from "node:fs";
import { assertNoSecretOutput } from "./client";
import { loadCloreConfig, PROJECT_TAG } from "./config";
import { loadCloreExecutionConfig } from "./execution-config";
import { verifyDockerImage } from "./docker-image";
import { readLiveMarketplace, readLiveOrdersSummary, readWalletSummary } from "./live";
import { buildCreateOrderBody, createCloreOrder } from "./order-execution";
import { assertWatchdogsReadyForCreate } from "./watchdog-preflight";
import { findBootstrapImageCandidates, summarizeBootstrapImageCandidate } from "./bootstrap-image-profile";
import { inspectSshPublicKey } from "./ssh";

function argument(name: string) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (!process.argv.includes("--execute")) throw new Error("First-image order requires --execute.");
  const serverId = argument("server-id");
  if (!serverId || argument("confirm-project") !== PROJECT_TAG) {
    throw new Error("Use --server-id and --confirm-project ai-video-platform-wan22.");
  }
  const config = loadCloreConfig();
  const execution = loadCloreExecutionConfig();
  if (!execution.enabled) throw new Error("CLORE_ORDER_EXECUTION_ENABLED=false.");
  const forceRefresh = { forceRefresh: true };
  const [orders, wallet, marketplace] = await Promise.all([
    readLiveOrdersSummary(config, forceRefresh),
    readWalletSummary(config, forceRefresh),
    readLiveMarketplace(config, forceRefresh),
  ]);
  if (orders.some((order) => order.active)) throw new Error("An active Clore order already exists.");
  const candidate = findBootstrapImageCandidates(marketplace, config).find((value) => value.serverId === serverId);
  if (!candidate) throw new Error("Selected server is no longer an eligible bootstrap first-image candidate.");
  if ((candidate.projectedFirstImageCostUsd ?? Infinity) > 4.5) throw new Error("Projected first-image cost exceeds 4.50 USD.");
  if (wallet.availableUsdBalance === null || wallet.availableUsdBalance - (candidate.projectedFirstImageCostUsd ?? 0) < 1) {
    throw new Error("Wallet reserve would be violated.");
  }
  const image = await verifyDockerImage(config.dockerImage);
  if (!image.exists || !image.linuxAmd64) throw new Error("Fixed Runtime digest is not verified for linux/amd64.");
  const publicKey = inspectSshPublicKey(config.sshPublicKeyPath ?? "");
  if (!publicKey.exists || !publicKey.formatValid) throw new Error("Dedicated SSH public key is invalid.");
  await assertWatchdogsReadyForCreate(serverId);
  const key = readFileSync(config.sshPublicKeyPath ?? "", "utf8").split(/\r?\n/)[0].trim();
  const request = buildCreateOrderBody({
    serverId,
    image: config.dockerImage,
    currency: config.rentalCurrency,
    sshPublicKey: key,
    maxPriceUsdPerHour: candidate.priceUsdPerHour ?? 0,
    requiredPriceForApi:
      candidate.priceOriginalCurrency === "USD" && candidate.priceOriginalUnit === "day" && candidate.priceOriginalAmount !== null
        ? candidate.priceOriginalAmount
        : candidate.priceUsdPerHour ?? 0,
  });
  request.env.COMFY_GPU_PROFILE = candidate.runtimeGpuProfile;
  const result = await createCloreOrder({ config, execution, candidate, requestBody: request });
  const output = JSON.stringify({
    mode: "real_first_image_order",
    ...result,
    candidate: summarizeBootstrapImageCandidate(candidate),
    runtime_digest: request.image,
    ports: ["ssh/tcp", "controller/http:8080"],
    sends_api_key_to_gpu: false,
    sends_private_key_to_gpu: false,
    sends_model_cache_credentials_to_gpu: false,
  }, null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "first-image order failed");
  process.exitCode = 1;
});
