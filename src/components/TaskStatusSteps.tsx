import type { TaskStatus } from "@/types/demo";

const steps = [
  { key: "queued", label: "排队中" },
  { key: "generating", label: "生成中" },
  { key: "completed", label: "生成完成" },
] as const;

type TaskStatusStepsProps = {
  status: TaskStatus;
};

export function TaskStatusSteps({ status }: TaskStatusStepsProps) {
  const activeIndex = steps.findIndex((step) => step.key === status);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {steps.map((step, index) => {
        const isActive = index === activeIndex;
        const isDone = activeIndex > index || status === "completed";
        return (
          <div
            className={`rounded-lg border p-4 ${
              isActive || isDone
                ? "border-teal-300 bg-teal-50 text-teal-900"
                : "border-stone-200 bg-white text-stone-500"
            }`}
            key={step.key}
          >
            <div className="flex items-center gap-3">
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                  isActive || isDone ? "bg-teal-600 text-white" : "bg-stone-200 text-stone-600"
                }`}
              >
                {index + 1}
              </span>
              <span className="font-semibold">{step.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
