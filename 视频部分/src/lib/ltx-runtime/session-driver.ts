import type { SafeGpuSessionDriver } from "@/lib/generation/gpu-session-controller";
import type { DeployedModelKey, RequiredGpuClass } from "@/lib/generation/gpu-execution-state";

export type ModelRuntimeLifecycle = {
  prepare(input: { gpuClass: RequiredGpuClass; providerOrderId: string }): Promise<void>;
  cancelActiveTask(): Promise<void>;
  unload(): Promise<void>;
};

export function createModelScopedSessionDriver(input: {
  wan: ModelRuntimeLifecycle;
  ltx: ModelRuntimeLifecycle;
  provider: { safeCancelSession(input: { providerOrderId: string; hadActiveGeneration: boolean }): Promise<void> };
}): SafeGpuSessionDriver {
  let active: "wan" | "ltx" | null = null;
  const runtimeFor = (modelKey?: DeployedModelKey) => {
    if (modelKey === "video_ltx_native_audio") return "ltx" as const;
    if (modelKey === "video_wan_silent") return "wan" as const;
    throw new Error("模型运行环境尚未部署：缺少精确视频模型标识。");
  };
  const lifecycle = (name: "wan" | "ltx") => name === "ltx" ? input.ltx : input.wan;
  return {
    async stopClaiming() {},
    async interruptGeneration() { if (active) await lifecycle(active).cancelActiveTask(); },
    async unloadModelFamily() { if (active) { await lifecycle(active).unload(); active = null; } },
    async ensureModelFamilyReady(request) {
      if (request.family !== "video") throw new Error("LTX 会话驱动只处理视频模型。");
      const next = runtimeFor(request.modelKey); if (active && active !== next) { await lifecycle(active).unload(); active = null; }
      await lifecycle(next).prepare({ gpuClass: request.gpuClass, providerOrderId: request.providerOrderId }); active = next;
    },
    async safeCancelSession(request) { if (active) { await lifecycle(active).unload(); active = null; } await input.provider.safeCancelSession(request); },
  };
}
