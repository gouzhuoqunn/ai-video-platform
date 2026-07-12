import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCloreConfig, PROJECT_TAG } from "./config";
import { assertNoSecretOutput, buildCloreUrl, createCloreHeaders, mapCloreCode } from "./client";
import { summarizeOrdersPayload } from "./live";
import { evaluateMarketplace, normalizeCloreServer } from "./marketplace";
import type { RawCloreServer } from "./types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function readMockMarketplace() {
  return JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "clore", "mock-marketplace.json"), "utf8")) as RawCloreServer[];
}

function main() {
  const config = loadCloreConfig();
  const headers = createCloreHeaders("test-key");
  assert(headers.auth === "test-key", "Clore auth header must be named auth.");
  assert(!("Authorization" in headers), "Clore client must not use Authorization Bearer.");
  assert(!buildCloreUrl(config, "/marketplace").includes("test-key"), "API key must not enter URL.");
  assert(mapCloreCode(0) === "success", "code 0 must map to success.");
  assert(mapCloreCode(5) === "rate_limited", "code 5 must map to rate limit.");
  assertNoSecretOutput(JSON.stringify({ safe: true }));
  const orderSummaries = summarizeOrdersPayload({ orders: [{ id: "active-1", status: "running" }, { id: "old-1", status: "canceled" }] });
  assert(orderSummaries.some((order) => order.orderId === "active-1" && order.active), "live active orders must be detected.");
  assert(orderSummaries.some((order) => order.orderId === "old-1" && !order.active), "canceled live orders must not block create.");

  const { candidates, matches } = evaluateMarketplace(readMockMarketplace(), config);
  assert(matches.length === 2, "mock marketplace should have two compliant RTX 5090 on-demand candidates.");
  assert(matches[0].serverId === "clore-5090-a", "candidates must sort by USD hourly price.");
  assert(matches.every((candidate) => /^NVIDIA GeForce RTX 5090$/i.test(candidate.gpu)), "matches must be exact RTX 5090.");
  assert(matches.every((candidate) => candidate.orderType === "on-demand"), "spot must be excluded.");
  assert(matches.every((candidate) => candidate.rentable), "unrentable servers must be excluded.");
  assert(matches.every((candidate) => (candidate.ramGb ?? 0) >= 64), "RAM filter must pass for matches.");
  assert(matches.every((candidate) => (candidate.cpuCores ?? 0) >= 8), "CPU filter must pass for matches.");
  assert(matches.every((candidate) => (candidate.diskGb ?? 0) >= 200), "disk filter must pass for matches.");
  assert(matches.every((candidate) => (candidate.downloadMbps ?? 0) >= 300), "download filter must pass for matches.");
  assert(matches.every((candidate) => (candidate.uploadMbps ?? 0) >= 100), "upload filter must pass for matches.");
  assert(matches.every((candidate) => (candidate.reliability ?? 0) >= 0.99), "reliability filter must pass for matches.");
  assert(matches.every((candidate) => (candidate.rating ?? 0) >= 4.7 && (candidate.ratingCount ?? 0) >= 3), "rating filters must pass.");
  assert(matches.every((candidate) => candidate.priceSource === "usd_per_hour"), "explicit hourly prices must stay hourly.");
  assert(matches.every((candidate) => candidate.priceOriginalUnit === "hour"), "explicit hourly prices must not be divided by 24.");
  assert(candidates.some((candidate) => candidate.priceSource === "btc_day_not_converted" && candidate.rejectionReasons.includes("missing USD hourly on-demand price")), "BTC daily price must not be treated as USD hourly.");
  assert(candidates.some((candidate) => candidate.riskTier === "A"), "risk tier A should be assigned for strong mock candidate.");
  assert(candidates.some((candidate) => candidate.riskTier === "B"), "risk tier B should be assigned for minimum mock candidate.");
  assert(candidates.some((candidate) => candidate.rejectionReasons.includes("spot or non-on-demand order is not allowed")), "spot candidate must be rejected.");
  assert(candidates.some((candidate) => candidate.rejectionReasons.includes("GPU is not exact RTX 5090")), "4090 fallback must be rejected.");

  const realCloreShape = normalizeCloreServer(
    {
      id: 95538,
      gpu_array: ["NVIDIA GeForce RTX 5090"],
      specs: {
        gpuram: 31,
        ram: 128.7286,
        cpu_cores: 24,
        disk: 970,
        net: { down: 2070.14, up: 881.23, cc: "CA" },
      },
      price: { usd: { on_demand_usd: 14.99 } },
      reliability: 0.9997,
      rating: { avg: 5, cnt: 10 },
      mrl: 6,
      rented: false,
    },
    config,
  );
  assert(realCloreShape.serverId === "95538", "real Clore id shape must normalize to a string server id.");
  assert(realCloreShape.gpu === "NVIDIA GeForce RTX 5090", "real Clore gpu_array shape must normalize GPU name.");
  assert(realCloreShape.gpuNormalizedName === "NVIDIA GeForce RTX 5090", "RTX 5090 name must normalize exactly.");
  assert(realCloreShape.gpuMemoryRawValue === 31 && realCloreShape.gpuMemoryRawUnit === "display_gb", "real Clore specs.gpuram must be preserved as raw display GB.");
  assert(realCloreShape.gpuMemoryAccepted, "exact RTX 5090 with API display 31GB must pass model-specific VRAM rule.");
  assert(realCloreShape.gpuMemoryNote.includes("API rounded/usable VRAM"), "31GB RTX 5090 acceptance must be explained.");
  assert(realCloreShape.priceOriginalAmount === 14.99 && realCloreShape.priceOriginalUnit === "day", "real Clore on_demand_usd must be preserved as USD/day.");
  assert(Math.abs((realCloreShape.priceUsdPerHour ?? 0) - 14.99 / 24) < 0.000001, "14.99 USD/day must normalize to about 0.624583 USD/hour.");
  assert(Math.abs((realCloreShape.sixHourCostUsd ?? 0) - (14.99 / 24) * 6) < 0.000001, "six-hour cost must use normalized hourly price.");
  assert(realCloreShape.downloadMbps === 2070.14 && realCloreShape.uploadMbps === 881.23, "real Clore specs.net shape must normalize bandwidth.");
  assert(realCloreShape.rating === 5 && realCloreShape.ratingCount === 10, "real Clore rating object must normalize rating fields.");
  assert(realCloreShape.rejectionReasons.length === 0, "server 95538 shape should pass after USD/day and RTX 5090 VRAM normalization.");

  const explicitHourly = normalizeCloreServer({ ...readMockMarketplace()[0], price_usd_per_hour: 0.62 }, config);
  assert(explicitHourly.priceUsdPerHour === 0.62 && explicitHourly.priceOriginalUnit === "hour", "0.62 explicit USD/hour must not be divided by 24.");

  const spotShape = normalizeCloreServer({ ...readMockMarketplace()[0], order_type: "spot", price_usd_per_hour: 0.1 }, config);
  assert(spotShape.rejectionReasons.includes("spot or non-on-demand order is not allowed"), "spot price must not be accepted as on-demand.");

  const bad4090 = normalizeCloreServer({ ...readMockMarketplace()[0], gpu_name: "NVIDIA GeForce RTX 4090", gpu_memory_gb: 24, price_usd_per_hour: 0.1 }, config);
  assert(bad4090.rejectionReasons.includes("GPU is not exact RTX 5090"), "RTX 4090 must not pass as 5090.");
  assert(bad4090.rejectionReasons.includes("GPU memory below RTX 5090 accepted threshold"), "24GB card must fail memory rule.");

  const unknown31 = normalizeCloreServer({ ...readMockMarketplace()[0], gpu_name: "Unknown RTX", gpu_memory_gb: 31, price_usd_per_hour: 0.1 }, config);
  assert(unknown31.rejectionReasons.includes("GPU is not exact RTX 5090"), "unknown GPU must not impersonate RTX 5090.");
  assert(unknown31.rejectionReasons.includes("GPU memory below RTX 5090 accepted threshold"), "unknown 31GB GPU must not use RTX 5090 tolerance.");

  const altered = normalizeCloreServer({ ...readMockMarketplace()[0], price_usd_per_hour: config.maxGpuPricePerHour + 0.01 }, config);
  assert(altered.rejectionReasons.includes("price above maximum"), "old candidate with increased price must be rejected.");
  assert(PROJECT_TAG === "ai-video-platform-wan22", "project tag must protect future create/cancel.");

  const createScript = readFileSync(path.join(process.cwd(), "scripts", "clore", "create-order.ts"), "utf8");
  const cancelScript = readFileSync(path.join(process.cwd(), "scripts", "clore", "cancel-order.ts"), "utf8");
  const uploadScript = readFileSync(path.join(process.cwd(), "scripts", "clore", "upload-worker.ps1"), "utf8");
  const sessionScript = readFileSync(path.join(process.cwd(), "scripts", "clore", "session-orchestrator.ts"), "utf8");
  const localCloreConsole = readFileSync(path.join(process.cwd(), "src", "lib", "local-lab", "clore-console.ts"), "utf8");
  const orderPlanRoute = readFileSync(path.join(process.cwd(), "src", "app", "api", "local-lab", "clore", "order-plan", "route.ts"), "utf8");
  const orderConfirmRoute = readFileSync(path.join(process.cwd(), "src", "app", "api", "local-lab", "clore", "order-confirm", "route.ts"), "utf8");
  const packageJson = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
  assert(createScript.includes("createCloreOrder"), "future create path should call the guarded execution helper.");
  assert(createScript.includes("CLORE_ORDER_EXECUTION_ENABLED=false"), "real create must remain blocked by the server-only execution flag.");
  assert(createScript.includes("clore:create:dry never accepts --execute"), "clore:create:dry must reject --execute.");
  assert(createScript.includes("--confirm-project ai-video-platform-wan22"), "future create needs explicit project confirmation.");
  assert(createScript.includes("create_order_body_shape"), "dry-run output should expose only the safe create_order body shape.");
  assert(packageJson.includes("\"clore:create\": \"tsx scripts/clore/create-order.ts\""), "future real create entry must be separated from clore:create:dry.");
  assert(packageJson.includes("\"clore:execution:test\""), "real execution guard tests must be registered.");
  assert(packageJson.includes("\"clore:ssh:test\""), "SSH safety tests must be registered.");
  assert(packageJson.includes("\"first-gpu-session:test\""), "first GPU session dry-run tests must be registered.");
  assert(cancelScript.includes("DRY RUN - NO ORDER CANCELED"), "cancel must default to dry-run.");
  assert(cancelScript.includes("verified_project_order"), "cancel must verify project order state.");
  assert(cancelScript.includes("cancelCloreOrder"), "future cancel path should use the guarded cancel helper.");
  assert(sessionScript.includes("Real Clore order execution is intentionally not implemented"), "session orchestrator must not execute real create_order.");
  assert(sessionScript.includes("Real Clore cancel_order execution is intentionally not implemented"), "session orchestrator must not execute real cancel_order.");
  assert(localCloreConsole.includes("readLiveMarketplace"), "local_lab web console must use read-only marketplace API helpers.");
  assert(localCloreConsole.includes("summarizeCandidate"), "local_lab web console must return sanitized candidate summaries.");
  assert(localCloreConsole.includes("raw_response_included: false"), "local_lab web console must not return raw marketplace responses.");
  assert(localCloreConsole.includes("CLORE_ORDER_EXECUTION_ENABLED"), "local_lab web confirm must be blocked by server-only execution flag.");
  assert(localCloreConsole.includes("expectedConfirmationText"), "local_lab web confirm must require exact server and price text.");
  assert(localCloreConsole.includes("createCloreOrder"), "local_lab web confirm should enter the guarded real path only after checks.");
  assert(orderPlanRoute.includes("guardLocalLabMutation"), "order-plan route must require local lab mutation guard.");
  assert(orderConfirmRoute.includes("guardLocalLabMutation"), "order-confirm route must require local lab mutation guard.");
  assert(uploadScript.includes(".secrets/gpu-worker.env"), "upload script should use limited Worker env.");
  assert(!uploadScript.includes(".env.local"), "upload script must not upload .env.local.");
  assert(!/id_rsa|\.pem/i.test(uploadScript), "upload script must not upload SSH private keys.");

  console.log("Clore tests passed.");
}

void main();
