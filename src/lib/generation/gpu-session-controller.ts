import { randomUUID } from "node:crypto";
import {
  completeConfirmedQueueDeployment,
  completePoolGenerationStop,
  completePoolGpuCancellation,
  completePreviousFamilyUnload,
  readGenerationPool,
  requestPoolGenerationStop,
  requestPoolGpuCancellation,
} from "./task-pool";
import { idleCancellationDue, type GenerationFamily, type RequiredGpuClass } from "./gpu-execution-state";

export type SafeGpuSessionDriver = {
  stopClaiming(family: GenerationFamily): Promise<void>;
  interruptGeneration(input: { family: GenerationFamily; taskIds: string[] }): Promise<void>;
  unloadModelFamily(family: GenerationFamily): Promise<void>;
  ensureModelFamilyReady(input: { family: GenerationFamily; gpuClass: RequiredGpuClass; providerOrderId: string }): Promise<void>;
  safeCancelSession(input: { providerOrderId: string; hadActiveGeneration: boolean }): Promise<void>;
};

export class GpuSessionController {
  constructor(
    private readonly driver: SafeGpuSessionDriver,
    private readonly poolPath?: string,
  ) {}

  async deployActiveQueue() {
    let state = readGenerationPool(this.poolPath);
    const execution = state.execution;
    const active = execution.activeExecution;
    if (execution.activity !== "deploying" || !execution.providerOrderId || !active) {
      throw new Error("当前没有等待控制器部署的执行队列。");
    }
    if (execution.switchPhase === "unloading") {
      if (execution.deployedFamily !== "image" && execution.deployedFamily !== "video") throw new Error("待卸载模型族无效。");
      await this.driver.unloadModelFamily(execution.deployedFamily);
      state = completePreviousFamilyUnload(this.poolPath);
    }
    await this.driver.ensureModelFamilyReady({
      family: active.generationFamily,
      gpuClass: active.gpuClass,
      providerOrderId: state.execution.providerOrderId!,
    });
    return completeConfirmedQueueDeployment(this.poolPath);
  }

  async stopGeneration() {
    let state = readGenerationPool(this.poolPath);
    if (state.execution.activity === "running") state = requestPoolGenerationStop(randomUUID(), this.poolPath);
    if (state.execution.activity !== "stopping" || !state.execution.activeExecution) throw new Error("当前没有等待安全停止的生成任务。");
    const active = state.execution.activeExecution;
    await this.driver.stopClaiming(active.generationFamily);
    await this.driver.interruptGeneration({ family: active.generationFamily, taskIds: [...active.confirmedTaskIds] });
    return completePoolGenerationStop(this.poolPath);
  }

  async cancelGpu() {
    let state = readGenerationPool(this.poolPath);
    if (state.execution.activity !== "canceling") state = requestPoolGpuCancellation(randomUUID(), this.poolPath);
    if (state.execution.activity !== "canceling" || !state.execution.providerOrderId) throw new Error("当前没有等待安全退租的 GPU。");
    const active = state.execution.activeExecution;
    if (active) {
      await this.driver.stopClaiming(active.generationFamily);
      await this.driver.interruptGeneration({ family: active.generationFamily, taskIds: [...active.confirmedTaskIds] });
    }
    await this.driver.safeCancelSession({
      providerOrderId: state.execution.providerOrderId,
      hadActiveGeneration: Boolean(active),
    });
    return completePoolGpuCancellation(this.poolPath);
  }

  async cancelExpiredIdleSession(at = Date.now()) {
    const state = readGenerationPool(this.poolPath);
    if (!idleCancellationDue(state.execution, at)) return { canceled: false, state };
    return { canceled: true, state: await this.cancelGpu() };
  }
}
