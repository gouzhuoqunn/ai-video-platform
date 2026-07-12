import type { DemoTask } from "@/types/demo";

type ResultPanelProps = {
  task: DemoTask;
};

export function ResultPanel({ task }: ResultPanelProps) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="flex min-h-56 flex-1 items-center justify-center rounded-lg border border-dashed border-teal-300 bg-teal-50 p-6 text-center">
          <div>
            <p className="text-lg font-bold text-teal-950">视频生成完成</p>
            <p className="mt-2 text-sm text-teal-800">这里是前端演示占位区域，尚未连接真实AI视频生成。</p>
          </div>
        </div>
        <div className="flex-1 space-y-4">
          <div>
            <p className="text-sm text-stone-500">提示词</p>
            <p className="mt-1 font-medium text-stone-950">{task.prompt}</p>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md bg-stone-50 p-3">
              <dt className="text-stone-500">生成时间</dt>
              <dd className="mt-1 font-semibold">{task.completedAt}</dd>
            </div>
            <div className="rounded-md bg-stone-50 p-3">
              <dt className="text-stone-500">时长</dt>
              <dd className="mt-1 font-semibold">{task.durationSeconds}秒</dd>
            </div>
            <div className="rounded-md bg-stone-50 p-3">
              <dt className="text-stone-500">分辨率</dt>
              <dd className="mt-1 font-semibold">{task.resolution}</dd>
            </div>
            <div className="rounded-md bg-stone-50 p-3">
              <dt className="text-stone-500">积分消耗</dt>
              <dd className="mt-1 font-semibold">{task.creditCost}积分</dd>
            </div>
          </dl>
          <button
            className="w-full rounded-md border border-stone-300 bg-stone-100 px-4 py-3 text-sm font-semibold text-stone-500"
            disabled
            type="button"
          >
            下载视频（后续版本开放）
          </button>
        </div>
      </div>
    </section>
  );
}
