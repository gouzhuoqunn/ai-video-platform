import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import {
  buildRunPodDirectPodPayload,
  buildRunPodDirectTemplatePayload,
  buildRunPodPriceBreakdown,
  candidatesFromAvailability,
  evaluateRunPodBudget,
  RUNPOD_DIRECT_LAUNCH_MODE,
  RUNPOD_DIRECT_SSH_COMMAND,
  RUNPOD_GPU_PRIORITY,
  RunPodProvider,
  RunPodRestClient,
  runPodCandidates,
  runPodWatchdogPlan,
  validateRunPodDirectTemplate,
  type RunPodConfig,
} from "./gpu-providers/runpod";
import { FIXED_RUNTIME_DIGEST } from "./gpu-providers/common";
import { CloreProvider } from "./gpu-providers/clore";

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFN0YWdlM0tUZXN0S2V5 test";

function config(overrides: Partial<RunPodConfig> = {}): RunPodConfig {
  return {
    apiKey: "test-only-token",
    keySource: "environment",
    maxGpuHourlyUsd: 0.7,
    maxTotalHourlyUsd: 0.75,
    maxSessionUsd: 2.5,
    sshPublicKeyPath: "test.pub",
    sshPrivateKeyPath: "test",
    bootstrapImage: "ghcr.io/example/bootstrap:fallback",
    launchMode: RUNPOD_DIRECT_LAUNCH_MODE,
    directTemplateName: "ai-video-first-image-direct-v1",
    ...overrides,
  };
}

async function main() {
  const candidate = runPodCandidates(0.69)[0];
  const input = { sessionId: "stage3k-test", candidate, sshPublicKey: PUBLIC_KEY, bootstrapImage: FIXED_RUNTIME_DIGEST, dryRun: false };
  const template = buildRunPodDirectTemplatePayload({ sshPublicKey: PUBLIC_KEY });
  const pod = buildRunPodDirectPodPayload(input, "template-1");
  assert.equal(template.imageName, FIXED_RUNTIME_DIGEST);
  assert.match(template.imageName, /@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(template.dockerEntrypoint, ["/bin/bash", "-lc"]);
  assert.match(template.dockerStartCmd[0], /apt-get install -y --no-install-recommends openssh-server/);
  assert.match(template.dockerStartCmd[0], /sshd -D -e/);
  assert.doesNotMatch(template.dockerStartCmd[0], /ComfyUI|comfy-runtime\/entrypoint/);
  assert.deepEqual(template.ports, ["22/tcp", "8080/http"]);
  assert.ok(!template.ports.some((port) => port.startsWith("8188/")));
  assert.deepEqual(Object.keys(template.env), ["PUBLIC_KEY"]);
  assert.ok(!JSON.stringify(template).includes("PRIVATE KEY"));
  assert.equal(template.volumeMountPath, "/workspace");
  assert.equal(template.isPublic, false);
  assert.equal(template.isServerless, false);
  assert.equal(pod.templateId, "template-1");
  assert.equal(pod.gpuCount, 1);
  assert.equal(pod.interruptible, false);
  assert.equal(pod.cloudType, "SECURE");
  assert.equal(pod.gpuTypePriority, "custom");
  assert.deepEqual(pod.gpuTypeIds, [candidate.id]);
  assert.deepEqual(runPodCandidates().map((item) => item.gpuType), RUNPOD_GPU_PRIORITY.map(([name]) => name));
  assert.throws(() => buildRunPodDirectTemplatePayload({ sshPublicKey: PUBLIC_KEY, runtimeImage: "ghcr.io/example/runtime:latest" }), /digest/);
  assert.throws(() => buildRunPodDirectTemplatePayload({ sshPublicKey: "-----BEGIN OPENSSH PRIVATE KEY-----" }), /public_key/);
  assert.throws(() => buildRunPodDirectPodPayload({ ...input, candidate: { ...candidate, interruptible: true as false } }, "template-1"), /spot/);
  assert.throws(() => buildRunPodDirectPodPayload({ ...input, candidate: { ...candidate, vramGb: 12 } }, "template-1"), /hardware/);
  assert.deepEqual(runPodWatchdogPlan("pod-1"), { provider: "runpod", session_id: "pod-1", action: "terminate", deadline_minutes: 15, terminate_priority: true });
  const price069 = buildRunPodPriceBreakdown({ costPerHr: 0.69, containerDiskInGb: 50, volumeInGb: 30 });
  assert.ok(Math.abs(price069.storageHourly - (8 / 730)) < 1e-12);
  assert.equal(evaluateRunPodBudget(price069, config()).accepted, true, "0.69 compute plus 80GB storage must pass");
  assert.equal(evaluateRunPodBudget(buildRunPodPriceBreakdown({ costPerHr: 0.70, containerDiskInGb: 50, volumeInGb: 30 }), config()).accepted, true, "0.70 compute plus reasonable storage must pass");
  assert.deepEqual(evaluateRunPodBudget({ computeHourly: 0.70, storageHourly: 0.06, totalHourly: 0.76, projectedSessionTotal: 2.49 }, config()), { accepted: false, reason: "totalHourly" });
  assert.deepEqual(evaluateRunPodBudget({ computeHourly: 0.71, storageHourly: 0, totalHourly: 0.71, projectedSessionTotal: 2.485 }, config()), { accepted: false, reason: "computeHourly" });
  assert.deepEqual(evaluateRunPodBudget({ computeHourly: 0.70, storageHourly: 0.02, totalHourly: 0.72, projectedSessionTotal: 2.52 }, config()), { accepted: false, reason: "projectedSessionTotal" });
  assert.equal(buildRunPodPriceBreakdown({ costPerHr: 0.99, adjustedCostPerHr: 0.69, containerDiskInGb: 50, volumeInGb: 30 }).computeHourly, 0.69);
  assert.throws(() => buildRunPodPriceBreakdown({ costPerHr: Number.NaN, containerDiskInGb: 50, volumeInGb: 30 }), /compute_price/);
  assert.throws(() => buildRunPodPriceBreakdown({ costPerHr: -1, containerDiskInGb: 50, volumeInGb: 30 }), /compute_price/);
  assert.throws(() => buildRunPodPriceBreakdown({ costPerHr: 0.69, containerDiskInGb: 50 }), /storage_fields/);
  await assert.rejects(() => new RunPodProvider({ config: config({ maxGpuHourlyUsd: 0.5 }) }).createSession(input), /estimated_budget.*computeHourly/);

  const availability = RUNPOD_GPU_PRIORITY.map(([id, memoryInGb]) => ({ id, memoryInGb, secureCloud: id === "NVIDIA A40", communityCloud: true, secure: id === "NVIDIA A40" ? { stockStatus: "High" as const, uninterruptablePrice: 0.69, availableGpuCounts: [1] } : { stockStatus: "None" as const, uninterruptablePrice: null, availableGpuCounts: [] }, community: { stockStatus: "High" as const, uninterruptablePrice: 0.5, availableGpuCounts: [1] } }));
  const availableCandidates = candidatesFromAvailability(availability);
  assert.deepEqual(availableCandidates[0] && [availableCandidates[0].gpuType, availableCandidates[0].cloudType], ["NVIDIA A40", "SECURE"], "Secure candidates must be ordered before Community fallback");
  assert.ok(availableCandidates.some((item) => item.cloudType === "COMMUNITY"), "Community fallback must remain selectable after Secure create failures");
  const communityOnly = availability.map((item) => ({ ...item, secureCloud: false, secure: { stockStatus: "None" as const, uninterruptablePrice: null, availableGpuCounts: [] } }));
  assert.equal(candidatesFromAvailability(communityOnly)[0]?.cloudType, "COMMUNITY");
  process.env.CLORE_DEPLOYMENT_HOLD = "true";
  await assert.rejects(() => new CloreProvider().createSession(input), /HOLD/);
  assert.equal((await new RunPodProvider({ config: config({ apiKey: "" }) }).inspectCredentials()).credentials_present, false);

  let retryCalls = 0;
  const retryClient = new RunPodRestClient(config(), async () => {
    retryCalls += 1;
    return retryCalls === 1 ? new Response("limited", { status: 429, headers: { "retry-after": "0.001" } }) : Response.json([]);
  });
  await retryClient.listPods();
  assert.equal(retryCalls, 2);

  let podCreates = 0;
  let templateCreates = 0;
  const fetchMock: typeof fetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    if (pathname.endsWith("/templates") && method === "POST") {
      templateCreates += 1;
      return Response.json({ id: "template-1", ...template });
    }
    if (pathname.endsWith("/pods") && method === "POST") {
      podCreates += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ id: "pod-1", name: "ai-video-first-image-stage3k-test", desiredStatus: "RUNNING", adjustedCostPerHr: 0.69, costPerHr: 0.70, containerDiskInGb: 50, volumeInGb: 30, machine: { secureCloud: true, gpuTypeId: candidate.id } });
    }
    return Response.json([]);
  };
  rmSync(path.join(process.cwd(), ".secrets", "runpod-create.lock"), { force: true });
  const provider = new RunPodProvider({ config: config(), fetchImpl: fetchMock });
  const [first, second] = await Promise.all([provider.createSession(input), provider.createSession(input)]);
  assert.equal(first.id, "pod-1");
  assert.equal(first.gpuType, candidate.id);
  assert.equal(first.cloudType, "SECURE");
  assert.equal(second.id, "pod-1");
  assert.equal(templateCreates, 1);
  assert.equal(podCreates, 1);

  let priceReads = 0;
  const delayedPriceFetch: typeof fetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    if (pathname.endsWith("/templates")) return Response.json([{ id: "template-2", ...template }]);
    if (pathname.endsWith("/pods") && method === "POST") {
      return Response.json({ id: "pod-delayed-price", name: "ai-video-first-image-stage3k-test", desiredStatus: "CREATED" });
    }
    if (pathname.endsWith("/pods/pod-delayed-price")) {
      priceReads += 1;
      return Response.json({ id: "pod-delayed-price", name: "ai-video-first-image-stage3k-test", desiredStatus: "RUNNING", adjustedCostPerHr: 0.69, costPerHr: 0.70, containerDiskInGb: 50, volumeInGb: 30, cloudType: "SECURE", gpuTypeId: candidate.id });
    }
    return Response.json([]);
  };
  const delayedPrice = await new RunPodProvider({ config: config(), fetchImpl: delayedPriceFetch }).createSession(input);
  assert.equal(delayedPrice.price?.computeHourly, 0.69);
  assert.equal(delayedPrice.hourlyUsd, delayedPrice.price?.totalHourly);
  assert.equal(priceReads, 1, "missing create-response price must be resolved through GET Pod");

  const reused = { id: "template-2", ...template };
  assert.deepEqual(validateRunPodDirectTemplate(reused, template), []);
  const { isPublic: _isPublic, isServerless: _isServerless, ...omittedFalseFields } = reused;
  assert.deepEqual(validateRunPodDirectTemplate(omittedFalseFields, template), []);
  assert.deepEqual(validateRunPodDirectTemplate({ ...reused, isPublic: true }, template), ["isPublic"]);
  assert.deepEqual(validateRunPodDirectTemplate({ ...reused, isServerless: true }, template), ["isServerless"]);
  assert.deepEqual(validateRunPodDirectTemplate({ ...reused, ports: ["22/tcp", "8188/http"] }, template), ["ports"]);

  let podLists = 0;
  const timeoutRecoveryFetch: typeof fetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    if (pathname.endsWith("/templates")) return Response.json([reused]);
    if (pathname.endsWith("/pods") && method === "POST") throw new DOMException("timeout", "AbortError");
    if (pathname.endsWith("/pods")) {
      podLists += 1;
      return Response.json(podLists >= 3 ? [{ id: "pod-recovered", name: "ai-video-first-image-stage3k-test", desiredStatus: "RUNNING", adjustedCostPerHr: 0.69, containerDiskInGb: 50, volumeInGb: 30, cloudType: "SECURE", gpuTypeId: candidate.id }] : []);
    }
    return Response.json({});
  };
  const recovered = await new RunPodProvider({ config: config(), fetchImpl: timeoutRecoveryFetch }).createSession(input);
  assert.equal(recovered.id, "pod-recovered");
  assert.ok(podLists >= 3, "create timeout must list Pods before recovery");
  console.log("RunPod direct template, API, payload, budget, retry, timeout recovery, idempotency, hold isolation, and watchdog tests passed.");
}
void main();
