import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CloreApiError, CloreRequestScheduler, CloreResponseError } from "./client";
import { parseMarketplacePayload, readLiveMarketplaceOutcome } from "./live";
import { rankFreshMarketplaceCandidates } from "./live-market-selection";
import type { CloreConfig, RawCloreServer } from "./types";

const config: CloreConfig = {
  apiBaseUrl: "https://clore.invalid",
  apiKey: "fixture",
  targetGpu: "NVIDIA GeForce RTX 4090",
  minGpuVramGb: 24,
  maxGpuPricePerHour: 0.6,
  minReliability: 0.9,
  minRating: 4,
  minRatingCount: 1,
  minRamGb: 31,
  minCpuCores: 8,
  minDiskGb: 200,
  minDownloadMbps: 100,
  minUploadMbps: 100,
  allowedCountries: [],
  rentalCurrency: "USD-Blockchain",
  dockerImage: "fixture",
  orderType: "on-demand",
  projectTag: "fixture",
  assumedMinimumRentalHours: 1,
  excludedServerIds: [],
};

function server(id: number, price: RawCloreServer = {}): RawCloreServer {
  return {
    id,
    gpu_name: "NVIDIA GeForce RTX 4090",
    gpu_memory_gb: 24,
    ram_gb: 64,
    cpu_cores: 16,
    disk_gb: 250,
    download_mbps: 500,
    upload_mbps: 300,
    price_usd_per_hour: 0.2,
    rentable: true,
    type: "on-demand",
    reliability: 0.99,
    rating: 4.8,
    rating_count: 10,
    supports_docker: true,
    supports_ssh: true,
    host_online: true,
    allowed_currencies: ["USD-Blockchain"],
    ...price,
  };
}

async function main() {
  const valid = [server(1), server(2, { price_usd_per_hour: 0.25 })];
  assert.equal(parseMarketplacePayload(valid).selectedListField, "array");
  assert.equal(parseMarketplacePayload({ servers: valid }).servers.length, 2);
  assert.equal(parseMarketplacePayload({ marketplace: [] }).selectedListField, "marketplace");
  assert.throws(() => parseMarketplacePayload({}), /schema_incompatible/);
  assert.throws(() => parseMarketplacePayload({ data: "not-a-list" }), /schema_incompatible/);
  assert.throws(() => parseMarketplacePayload("<html>proxy</html>"), /schema_incompatible/);
  assert.throws(() => parseMarketplacePayload(null), /schema_incompatible/);

  const ranked = rankFreshMarketplaceCandidates({ marketplace: [server(1), server(3, { gpu_name: "NVIDIA GeForce RTX 3090" }), server(4, { rentable: false })], config, attemptedServerIds: new Set(["1"]) });
  assert.equal(ranked.candidates.length, 0, "attempted candidates must be excluded from the next selection");
  assert.equal(ranked.evidence.filterCounts.totalProviderListings, 3);
  assert.equal(ranked.evidence.filterCounts.exactRtx4090Listings, 2);
  assert.ok(ranked.evidence.filterCounts.rejectionCounts.already_attempted >= 1);
  const hourly = rankFreshMarketplaceCandidates({ marketplace: [server(9, { price_usd_per_hour: 0.21 })], config, attemptedServerIds: new Set() });
  assert.equal(hourly.candidates[0]?.serverId, "9", "explicit USD/hour listings remain eligible");
  const offline = rankFreshMarketplaceCandidates({ marketplace: [server(10, { host_online: false })], config, attemptedServerIds: new Set() });
  assert.equal(offline.candidates.length, 0, "explicitly offline hosts must not be selected");
  const invalidId = rankFreshMarketplaceCandidates({ marketplace: [server(0)], config, attemptedServerIds: new Set() });
  assert.equal(invalidId.candidates.length, 0, "server IDs must be valid before numeric create serialization");

  let calls = 0;
  const evidence: Array<{ responseByteLength: number; bodySha256: string; responseKind: string }> = [];
  const scheduler = new CloreRequestScheduler({
    now: (() => { let value = 0; return () => value++; })(),
    sleep: async () => undefined,
    jitter: () => 0,
    log: () => undefined,
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? new Response("<html>proxy failure</html>", { status: 200, headers: { "content-type": "text/html" } })
        : new Response(JSON.stringify({ code: 0, data: { servers: valid } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(
    () => scheduler.request(config, "/marketplace", {}, { forceRefresh: true, maxNetworkRetries: 0, maxRateLimitRetries: 0, onResponse: (item) => { evidence.push(item); } }),
    (error: unknown) => error instanceof CloreResponseError && error.classification === "invalid_json",
  );
  assert.equal(evidence[0]?.responseKind, "non_json");
  assert.equal(evidence[0]?.responseByteLength, Buffer.byteLength("<html>proxy failure</html>"));
  assert.match(evidence[0]?.bodySha256 ?? "", /^[a-f0-9]{64}$/);
  const second = await scheduler.request<{ servers: RawCloreServer[] }>(config, "/marketplace", {}, { forceRefresh: true, maxNetworkRetries: 0, maxRateLimitRetries: 0 });
  assert.equal(calls, 2, "malformed responses must never populate the empty/listing cache");
  assert.equal(second.servers.length, 2);
  const httpFailureScheduler = new CloreRequestScheduler({
    sleep: async () => undefined,
    fetch: async () => new Response(JSON.stringify({ code: 0, data: { servers: [] } }), { status: 500, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    () => httpFailureScheduler.request(config, "/marketplace", {}, { forceRefresh: true, maxNetworkRetries: 0, maxRateLimitRetries: 0 }),
    (error: unknown) => error instanceof CloreApiError && error.failure.httpStatus === 500,
  );

  const responses: Array<{ status: number; contentType: string; body: string } | null> = [
    { status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { servers: [server(11)] } }) },
    { status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { servers: [] } }) },
    { status: 429, contentType: "application/json", body: JSON.stringify({ code: 5, message: "slow down" }) },
    { status: 401, contentType: "text/html", body: "<html>unauthorized</html>" },
    { status: 200, contentType: "text/html", body: "<html>proxy</html>" },
    { status: 200, contentType: "application/json", body: JSON.stringify({ code: 0, data: { unexpected: [] } }) },
    { status: 200, contentType: "application/json", body: JSON.stringify(null) },
    { status: 500, contentType: "application/json", body: JSON.stringify({ code: 9, message: "provider unavailable" }) },
  ];
  let responseIndex = 0;
  const localServer = createServer((_request: IncomingMessage, response: ServerResponse) => {
    const fixture = responses[responseIndex++];
    if (!fixture) {
      response.destroy();
      return;
    }
    response.statusCode = fixture.status;
    response.setHeader("content-type", fixture.contentType);
    response.end(fixture.body);
  });
  const localPort = await new Promise<number>((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", () => {
      const address = localServer.address();
      if (!address || typeof address === "string") reject(new Error("fixture_server_address_missing"));
      else resolve(address.port);
    });
  });
  try {
    const typedConfig = { ...config, apiBaseUrl: `http://127.0.0.1:${localPort}` };
    const expected = ["success_nonempty", "success_empty", "rate_limited", "authentication_failed", "invalid_json", "schema_incompatible", "schema_incompatible", "provider_error"] as const;
    for (const classification of expected) {
      const outcome = await readLiveMarketplaceOutcome(typedConfig, { forceRefresh: true, maxNetworkRetries: 0, maxRateLimitRetries: 0 });
      assert.equal(outcome.classification, classification);
      if (classification === "success_nonempty") {
        assert.equal(outcome.evidence.selectedListField, "servers");
        assert.equal(outcome.evidence.rawListingCount, 1);
        assert.equal(outcome.servers.length, 1);
      } else if (classification === "success_empty") {
        assert.equal(outcome.evidence.rawListingCount, 0);
        assert.equal(outcome.servers.length, 0);
      } else {
        assert.equal(outcome.evidence.rawListingCount, null);
        assert.equal(outcome.servers.length, 0, `${classification} must not become a listing`);
      }
    }
  } finally {
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  }
  const transport = await readLiveMarketplaceOutcome({ ...config, apiBaseUrl: `http://127.0.0.1:${localPort}` }, { forceRefresh: true, maxNetworkRetries: 0, maxRateLimitRetries: 0 });
  assert.equal(transport.classification, "transport_failed");
  assert.equal(transport.evidence.rawListingCount, null);
  console.log(JSON.stringify({ ok: true, typedClassifications: 8, parserOutcomes: 6, filterStages: 3, malformedNotEmpty: true, responseEvidence: true, providerMutationCount: 0 }));
}

void main();
