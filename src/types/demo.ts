export type TaskStatus = "idle" | "queued" | "generating" | "completed" | "failed";

export type DemoTask = {
  id: string;
  prompt: string;
  status: Exclude<TaskStatus, "idle">;
  createdAt: string;
  completedAt?: string;
  durationSeconds: number;
  resolution: "720P";
  modelName: string;
  creditCost: number;
};

export type HistoryRecord = {
  id: string;
  prompt: string;
  status: "生成完成" | "生成中" | "生成失败";
  createdAt: string;
  creditCost: number;
};
