import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import { validateProductionPrompt } from "@/lib/generation/production-prompt-safety";
import { listLocalImageResults } from "@/lib/local-lab/local-results";
import { listLongVideoProjects, persistLongVideoProject } from "@/lib/long-video/store";
import { persistLongVideoProjectSnapshot } from "@/lib/long-video/media";
import { toPublicLongVideoProject, validateLongVideoSegmentDrafts, type FirstFrameSource, type LongVideoSegmentDraft } from "@/lib/long-video/domain";
import { longVideoUploadExists } from "@/lib/long-video/uploads";

type CreatePayload = {
  action?: "create";
  title?: string;
  overallPrompt?: string;
  firstFrameSource?: FirstFrameSource;
  firstFrameRef?: string | null;
  targetDurationSeconds?: number;
  segments?: LongVideoSegmentDraft[];
  gpuPreference?: Array<"rtx4090" | "rtx5090">;
};

export async function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  return NextResponse.json({ projects: listLongVideoProjects().map(toPublicLongVideoProject) });
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;
  const payload = await request.json().catch(() => ({})) as CreatePayload;
  if (payload.action !== "create") return NextResponse.json({ error: "长视频操作无效。" }, { status: 400 });
  const source = payload.firstFrameSource;
  const firstFrameRef = String(payload.firstFrameRef ?? "");
  if (!source || !["upload", "existing_image", "pure_prompt"].includes(source)) return NextResponse.json({ error: "请选择首帧来源。" }, { status: 400 });
  if (source === "upload" && (!/^upload:[a-f0-9-]{36}$/.test(firstFrameRef) || !longVideoUploadExists(firstFrameRef))) return NextResponse.json({ error: "请先上传有效首帧图片。" }, { status: 400 });
  if (source === "existing_image") {
    const match = firstFrameRef.match(/^image:([A-Za-z0-9_-]{6,120})$/);
    if (!match || !listLocalImageResults().some((image) => image.sessionId === match[1])) return NextResponse.json({ error: "请选择已验证的本地图片。" }, { status: 400 });
  }
  let segments: LongVideoSegmentDraft[];
  try {
    if (!Array.isArray(payload.segments)) throw new Error("请提交完整的分段提示词。");
    segments = payload.segments.map((segment) => ({ sequenceIndex: Number(segment.sequenceIndex), startSecond: Number(segment.startSecond), endSecond: Number(segment.endSecond), prompt: String(segment.prompt ?? "") }));
    segments = validateLongVideoSegmentDrafts(Number(payload.targetDurationSeconds), segments);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "分段提示词无效。" }, { status: 400 });
  }
  const allPrompts = [String(payload.overallPrompt ?? ""), ...segments.map((segment) => segment.prompt)];
  const unsafe = allPrompts.map(validateProductionPrompt).find((result) => !result.allowed);
  if (unsafe) return NextResponse.json({ error: unsafe.reason, code: unsafe.code }, { status: 400 });
  try {
    const project = persistLongVideoProject({
      title: String(payload.title ?? ""),
      overallPrompt: String(payload.overallPrompt ?? ""),
      firstFrameSource: source,
      firstFrameRef: source === "pure_prompt" ? null : firstFrameRef,
      targetDurationSeconds: Number(payload.targetDurationSeconds),
      segments,
      gpuPreference: payload.gpuPreference,
    });
    persistLongVideoProjectSnapshot(project);
    return NextResponse.json({
      project: toPublicLongVideoProject(project),
      provider_authorization_created: false,
      credit_charged: false,
      create_order_called: false,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建长视频项目。" }, { status: 400 });
  }
}
