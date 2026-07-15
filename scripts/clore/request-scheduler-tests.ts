import assert from "node:assert/strict";
import { CloreRequestScheduler } from "./client";

const config = { apiBaseUrl: "https://clore.test", apiKey: "test-key" } as never;

function success() {
  return new Response(JSON.stringify({ code: 0, data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } });
}

async function main() {
  let now = 0;
  const waits: number[] = [];
  const calls: string[] = [];
  const scheduler = new CloreRequestScheduler({
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
    jitter: () => 0,
    log: () => undefined,
    fetch: async (url) => { calls.push(String(url)); return success(); },
  });
  await scheduler.request(config, "/marketplace");
  await scheduler.request(config, "/wallets");
  assert.ok(waits.some((value) => value >= 1100), "ordinary requests must not run faster than once per 1.1 seconds");
  await scheduler.request(config, "/marketplace");
  assert.equal(calls.filter((value) => value.endsWith("/marketplace")).length, 1, "marketplace must use the 60 second cache");

  now = 0;
  const createWaits: number[] = [];
  let createCalls = 0;
  const createScheduler = new CloreRequestScheduler({
    now: () => now,
    sleep: async (ms) => { createWaits.push(ms); now += ms; },
    jitter: () => 0,
    log: () => undefined,
    fetch: async () => { createCalls += 1; return success(); },
  });
  await Promise.all([createScheduler.request(config, "/create_order", { method: "POST" }), createScheduler.request(config, "/create_order", { method: "POST" })]);
  assert.equal(createCalls, 1, "concurrent create calls must share one request");
  await createScheduler.request(config, "/create_order", { method: "POST" });
  assert.ok(createWaits.some((value) => value >= 6000), "create requests must not run faster than six seconds");

  let limitedCalls = 0;
  const rateWaits: number[] = [];
  const limited = new CloreRequestScheduler({
    now: () => now,
    sleep: async (ms) => { rateWaits.push(ms); now += ms; },
    jitter: () => 0,
    log: () => undefined,
    fetch: async () => {
      limitedCalls += 1;
      return limitedCalls === 1 ? new Response(JSON.stringify({ code: 5 }), { status: 200, headers: { "content-type": "application/json" } }) : success();
    },
  });
  await limited.request(config, "/marketplace", {}, { forceRefresh: true });
  assert.equal(limitedCalls, 2, "rate limit must retry");
  assert.ok(rateWaits.some((value) => value >= 2000), "code 5 must use backoff");

  let uncertainChecks = 0;
  let timeoutCalls = 0;
  const timeoutScheduler = new CloreRequestScheduler({
    now: () => now,
    sleep: async () => undefined,
    jitter: () => 0,
    log: () => undefined,
    fetch: async () => {
      timeoutCalls += 1;
      if (timeoutCalls === 1) throw new Error("network timeout");
      return success();
    },
  });
  await timeoutScheduler.request(config, "/create_order", { method: "POST" }, { onCreateUncertain: async () => { uncertainChecks += 1; return false; } });
  assert.equal(uncertainChecks, 1, "timeout must check order state before a create retry");
  assert.equal(timeoutCalls, 2, "timeout without an active order may retry once");
  console.log("Clore request scheduler tests passed.");
}

void main();
