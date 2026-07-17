import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { validateProductionPrompt } from "@/lib/generation/production-prompt-safety";
import { listLocalImageResults } from "@/lib/local-lab/local-results";
import { listLongVideoProjects, persistLongVideoProject } from "@/lib/long-video/store";
import type { FirstFrameSource } from "@/lib/long-video/domain";

type CreatePayload = {
  action?: "create";
  title?: string;
  overallPrompt?: string;
  firstFrameSource?: FirstFrameSource;
  firstFrameRef?: string | null;
  targetDurationSeconds?: number;
  prompts?: string[];
  gpuPreference?: Array<"rtx4090" | "rtx5090">;
};

function safeProject(project: ReturnType<typeof listLongVideoProjects>[number]) {
  return {
    ...project,
    segments: project.segments.map((segment) => ({
      ...segment,
      inputFrameRef: segment.inputFrameRef ? "已准备" : null,
      outputVideoRef: segment.outputVideoRef ? `segment:${segment.sequenceIndex}:video` : null,
      lastFrameRef: segment.lastFrameRef ? `segment:${segment.sequenceIndex}:last-frame` : null,
      attempts: segment.attempts.map((attempt) => ({
        ...attempt,
        sourceWebmRef: attempt.sourceWebmRef ? `attempt:${attempt.id}:source` : null,
        outputVideoRef: attempt.outputVideoRef ? `attempt:${attempt.id}:video` : null,
        thumbnailRef: attempt.thumbnailRef ? `attempt:${attempt.id}:thumbnail` : null,
        lastFrameRef: attempt.lastFrameRef ? `attempt:${attempt.id}:last-frame` : null,
      })),
    })),
  };
}

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  return NextResponse.json({ projects: listLongVideoProjects().map(safeProject) });
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;
  const payload = await request.json().catch(() => ({})) as CreatePayload;
  if (payload.action !== "create") return NextResponse.json({ error: "长视频操作无效。" }, { status: 400 });
  const source = payload.firstFrameSource;
  const firstFrameRef = String(payload.firstFrameRef ?? "");
  if (!source || !["upload", "existing_image", "pure_prompt"].includes(source)) return NextResponse.json({ error: "请选择首帧来源。" }, { status: 400 });
  if (source === "upload" && !/^upload:[a-f0-9-]{36}$/.test(firstFrameRef)) return NextResponse.json({ error: "请先上传有效首帧图片。" }, { status: 400 });
  if (source === "existing_image") {
    const match = firstFrameRef.match(/^image:([A-Za-z0-9_-]{6,120})$/);
    if (!match || !listLocalImageResults().some((image) => image.sessionId === match[1])) return NextResponse.json({ error: "请选择已验证的本地图片。" }, { status: 400 });
  }
  const prompts = Array.isArray(payload.prompts) ? payload.prompts.map(String) : [];
  const allPrompts = [String(payload.overallPrompt ?? ""), ...prompts];
  const unsafe = allPrompts.map(validateProductionPrompt).find((result) => !result.allowed);
  if (unsafe) return NextResponse.json({ error: unsafe.reason, code: unsafe.code }, { status: 400 });
  try {
    const project = persistLongVideoProject({
      title: String(payload.title ?? ""),
      overallPrompt: String(payload.overallPrompt ?? ""),
      firstFrameSource: source,
      firstFrameRef: source === "pure_prompt" ? null : firstFrameRef,
      targetDurationSeconds: Number(payload.targetDurationSeconds),
      prompts,
      gpuPreference: payload.gpuPreference,
    });
    return NextResponse.json({
      project: safeProject(project),
      provider_authorization_created: false,
      credit_charged: false,
      create_order_called: false,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建长视频项目。" }, { status: 400 });
  }
}
