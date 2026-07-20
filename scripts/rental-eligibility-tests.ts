import assert from "node:assert/strict";
import { defaultGpuExecutionState, rentalEligibilityFor, type QueueTaskLike } from "../src/lib/generation/gpu-execution-state";

type TestTask = QueueTaskLike & { audioBinding?: { status: string } | null; audioOrigin?: string | null; modelRevision?: string };

const silent = (overrides: Partial<TestTask> = {}): TestTask => ({ id: "silent", generationType: "video", modelKey: "video_wan_silent", soundMode: "silent", status: "waiting_for_gpu", requiredGpuClass: "rtx4090", ...overrides });
const audible = (overrides: Partial<TestTask> = {}): TestTask => ({ id: "audible", generationType: "video", modelKey: "video_ltx_native_audio", soundMode: "audible", status: "waiting_for_gpu", requiredGpuClass: "rtx4090", audioOrigin: "local_voice_conditioning", audioBinding: { status: "local_audio_ready" }, ...overrides });
const check = (name: string, overrides: Parameters<typeof rentalEligibilityFor>[0], code: string | null, eligible = code === null) => {
  const result = rentalEligibilityFor(overrides);
  assert.equal(result.reasonCode, code, name);
  assert.equal(result.eligible, eligible, name);
};

const base = { state: defaultGpuExecutionState(), tasks: [silent()], family: "video" as const, gpuClass: "rtx4090" as const, modelKey: "video_wan_silent", manualAuthorization: true };

check("no selected queue", { ...base, gpuClass: null }, "no_queue_selected");
check("empty selected queue", { ...base, gpuClass: "rtx5090" }, "queue_empty");
check("unconfirmed silent task", { ...base, tasks: [silent({ status: "pending_confirmation" })] }, "no_confirmed_tasks");
check("waiting audio reports audio readiness", { ...base, tasks: [audible({ status: "waiting_for_local_audio", audioBinding: { status: "waiting_for_local_audio" } })], modelKey: "video_ltx_native_audio" }, "audible_audio_not_ready");
check("confirmed audio binding cannot be missing", { ...base, tasks: [audible({ audioBinding: null })], modelKey: "video_ltx_native_audio" }, "task_binding_invalid");
check("ready audible task passes the local gate", { ...base, tasks: [audible()], modelKey: "video_ltx_native_audio" }, null);
check("silent task is independent of audio readiness", { ...base, tasks: [silent()], runtimeReady: true }, null);
check("GPU class conflict", { ...base, state: { ...defaultGpuExecutionState(), rentedGpuClass: "rtx5090", providerOrderId: "order" } }, "gpu_class_conflict");
check("existing search locks action", { ...base, state: { ...defaultGpuExecutionState(), activity: "searching" } }, "gpu_already_searching");
check("deployment locks action", { ...base, state: { ...defaultGpuExecutionState(), activity: "deploying" } }, "gpu_already_deploying");
check("running locks action", { ...base, state: { ...defaultGpuExecutionState(), activity: "running" } }, "gpu_already_running");
check("provider mutation locks action", { ...base, state: { ...defaultGpuExecutionState(), activity: "canceling", operationId: "op" } }, "provider_mutation_in_progress");
check("manual rental needs authorization", { ...base, manualAuthorization: false }, "authorization_missing");
check("runtime gate is explicit", { ...base, runtimeReady: false }, "runtime_not_ready");
check("model manifest gate is explicit", { ...base, modelManifestReady: false }, "model_manifest_blocked");
check("unknown execution error blocks action", { ...base, state: { ...defaultGpuExecutionState(), activity: "error" } }, "unknown_blocker");

console.log("Rental eligibility tests passed (16 focused scenarios).");
