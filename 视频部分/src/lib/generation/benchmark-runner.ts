import type { GpuProfileKey } from "./gpu-profiles";
import type { ModelCandidate } from "./model-registry";
import type { ComfyRuntimeClient } from "./comfy-runtime";
import type { WorkflowTemplate } from "./workflow-registry";

export type BenchmarkErrorClass = "none" | "timeout" | "oom" | "missing_node" | "missing_output" | "runtime_error";
export type BenchmarkStatus = "pending" | "runtime_starting" | "syncing_model" | "loading_model" | "generating_first" | "generating_hot" | "cleanup" | "succeeded" | "failed";

export type BenchmarkPlan = {
  candidate: ModelCandidate;
  gpuProfile: GpuProfileKey;
  workflow: WorkflowTemplate;
  sampleCount: number;
  timeoutSeconds: number;
  continueAfterFailure: boolean;
};

export type BenchmarkMetrics = {
  runtimeStartupMs: number | null;
  modelSyncMs: number | null;
  modelLoadMs: number | null;
  firstGenerationMs: number | null;
  hotGenerationMs: number | null;
  peakVramGb: number | null;
  peakRamGb: number | null;
  diskGb: number | null;
  outputPath: string | null;
  outputSha256: string;
  workflowVersion: string;
  modelRevision: string;
  gpuModel: string;
  driverVersion: string;
};

export type BenchmarkResult = {
  status: BenchmarkStatus;
  success: boolean;
  errorClass: BenchmarkErrorClass;
  errorMessage: string | null;
  metrics: BenchmarkMetrics;
};

export function classifyBenchmarkError(error: unknown): BenchmarkErrorClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/out of memory|cuda oom|oom/i.test(message)) return "oom";
  if (/missing node|node not found|unknown node/i.test(message)) return "missing_node";
  if (/missing output|no output|output not found/i.test(message)) return "missing_output";
  return "runtime_error";
}

export async function runMockBenchmark(plan: BenchmarkPlan, runtime: ComfyRuntimeClient): Promise<BenchmarkResult> {
  if (plan.sampleCount < 1) throw new Error("benchmark sampleCount must be at least 1");
  if (plan.sampleCount > 3) throw new Error("mock benchmark sampleCount is capped at 3");

  try {
    const startedAt = Date.now();
    await runtime.health();
    const runtimeStartupMs = Date.now() - startedAt;

    const first = await runtime.submitWorkflow(plan.workflow, {
      prompt: "mock benchmark prompt",
      seed: 1,
      width: plan.candidate.task_type === "image" ? 1024 : 1280,
      height: plan.candidate.task_type === "image" ? 1024 : 704,
      frames: plan.candidate.task_type === "image" ? 1 : 121,
    });
    await runtime.getPromptStatus(first.promptId);
    const firstStatus = await runtime.getPromptStatus(first.promptId);
    const outputs = await runtime.getOutputs(first.promptId);
    if (firstStatus.status !== "completed") throw new Error("missing output: prompt did not complete");
    if (outputs.length === 0) throw new Error("missing output: no ComfyUI output paths");

    let hotGenerationMs: number | null = null;
    if (plan.sampleCount > 1) {
      const hotStartedAt = Date.now();
      const hot = await runtime.submitWorkflow(plan.workflow, { prompt: "mock hot benchmark prompt", seed: 2 });
      await runtime.getPromptStatus(hot.promptId);
      await runtime.getPromptStatus(hot.promptId);
      hotGenerationMs = Date.now() - hotStartedAt;
    }

    await runtime.cleanupModelCache();
    return {
      status: "succeeded",
      success: true,
      errorClass: "none",
      errorMessage: null,
      metrics: {
        runtimeStartupMs,
        modelSyncMs: 0,
        modelLoadMs: 0,
        firstGenerationMs: 0,
        hotGenerationMs,
        peakVramGb: null,
        peakRamGb: null,
        diskGb: null,
        outputPath: outputs[0],
        outputSha256: "",
        workflowVersion: plan.workflow.version,
        modelRevision: plan.candidate.revision,
        gpuModel: plan.gpuProfile === "rtx4090" ? "NVIDIA GeForce RTX 4090" : "NVIDIA GeForce RTX 5090",
        driverVersion: "mock",
      },
    };
  } catch (error) {
    return {
      status: "failed",
      success: false,
      errorClass: classifyBenchmarkError(error),
      errorMessage: error instanceof Error ? error.message : String(error),
      metrics: {
        runtimeStartupMs: null,
        modelSyncMs: null,
        modelLoadMs: null,
        firstGenerationMs: null,
        hotGenerationMs: null,
        peakVramGb: null,
        peakRamGb: null,
        diskGb: null,
        outputPath: null,
        outputSha256: "",
        workflowVersion: plan.workflow.version,
        modelRevision: plan.candidate.revision,
        gpuModel: plan.gpuProfile,
        driverVersion: "mock",
      },
    };
  }
}
