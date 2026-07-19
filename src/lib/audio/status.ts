import type { AudioInferenceStatus } from "@/types/audio";

export type AudioCardStatus = { label: "生成声音" | "声音正在生成" | "声音生成成功" | "声音生成失败"; detail: string; canCancel: boolean; canAudition: boolean; canRegenerate: boolean };

export function getAudioCardStatus(status: AudioInferenceStatus | null, detail = "") : AudioCardStatus {
  if (!status) return { label: "生成声音", detail: "尚未创建声音任务", canCancel: false, canAudition: false, canRegenerate: false };
  if (status === "succeeded") return { label: "声音生成成功", detail: detail || "本地声音与视频版本已完成", canCancel: false, canAudition: true, canRegenerate: true };
  if (status === "failed" || status === "canceled") return { label: "声音生成失败", detail: detail || (status === "canceled" ? "声音任务已取消" : "声音任务失败"), canCancel: false, canAudition: false, canRegenerate: true };
  const details: Record<Exclude<AudioInferenceStatus, "succeeded" | "failed" | "canceled">, string> = {
    queued: "正在本地队列中等待",
    waiting_for_resources: "正在等待内存或 CPU 资源",
    loading_voice: "正在加载声音",
    generating: "正在生成语音",
    muxing: "正在混流视频",
  };
  return { label: "声音正在生成", detail: detail || details[status], canCancel: true, canAudition: false, canRegenerate: false };
}
