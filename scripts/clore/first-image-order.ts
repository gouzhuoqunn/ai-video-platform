import { assertNoSecretOutput } from "./client";
import { loadCloreConfig, PROJECT_TAG } from "./config";
import { loadCloreExecutionConfig } from "./execution-config";
import { readLiveMarketplace, readLiveOrdersSummary, readWalletSummary } from "./live";
import { buildCreateOrderBody, createCloreOrder } from "./order-execution";
import { assertWatchdogsReadyForCreate } from "./watchdog-preflight";
import { findBootstrapImageCandidates, summarizeBootstrapImageCandidate } from "./bootstrap-image-profile";
import { inspectSshPublicKey } from "./ssh";
import { assertCloreDeploymentAllowed } from "./deployment-hold";
import { CLORE_LIGHT_BOOTSTRAP_IMAGE, CLORE_LIGHT_BOOTSTRAP_PROFILE, loadVerifiedCloreLightBootstrapImage } from "./public-image";
import { ensureValidatedProjectSshKey } from "./ssh-key-validation";

function argument(name: string) {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  assertCloreDeploymentAllowed();
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
  if ((candidate.projectedFirstImageCostUsd ?? Infinity) > 2.5) throw new Error("Projected first-image cost exceeds 2.50 USD.");
  if (wallet.availableUsdBalance === null || wallet.availableUsdBalance - (candidate.projectedFirstImageCostUsd ?? 0) < 1) {
    throw new Error("Wallet reserve would be violated.");
  }
  const image = await loadVerifiedCloreLightBootstrapImage();
  const publicKey = inspectSshPublicKey(config.sshPublicKeyPath ?? "");
  if (!publicKey.exists || !publicKey.formatValid) throw new Error("Dedicated SSH public key is invalid.");
  await assertWatchdogsReadyForCreate(serverId);
  const key = ensureValidatedProjectSshKey().normalizedPublicKey;
  const request = buildCreateOrderBody({
    serverId,
    image: CLORE_LIGHT_BOOTSTRAP_IMAGE,
    currency: config.rentalCurrency,
    sshPublicKey: key,
    maxPriceUsdPerHour: candidate.priceUsdPerHour ?? 0,
    requiredPriceForApi:
      candidate.priceOriginalCurrency === "USD" && candidate.priceOriginalUnit === "day" && candidate.priceOriginalAmount !== null
        ? candidate.priceOriginalAmount
        : candidate.priceUsdPerHour ?? 0,
    bootstrapProfile: CLORE_LIGHT_BOOTSTRAP_PROFILE,
  });
  const result = await createCloreOrder({
    config,
    execution,
    candidate,
    requestBody: request,
    sessionMetadata: { gpuType: candidate.gpu, gpuProfile: candidate.runtimeGpuProfile, bootstrapImage: CLORE_LIGHT_BOOTSTRAP_IMAGE },
  });
  const output = JSON.stringify({
    mode: "real_first_image_order",
    ...result,
    candidate: summarizeBootstrapImageCandidate(candidate),
    bootstrap_profile: CLORE_LIGHT_BOOTSTRAP_PROFILE,
    bootstrap_image: request.image,
    bootstrap_manifest_digest: image.digest,
    ports: ["ssh/tcp"],
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
