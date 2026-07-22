import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";
import {
  cancelLongVideoProject,
  confirmLongVideoProject,
  deleteLongVideoProject,
  getLongVideoProject,
  resumeLongVideoProject,
  reviewLongVideoSegment,
  updateLongVideoSegmentPrompt,
  updateLongVideoProjectGpuPreference,
  deleteLongVideoProjectTasks,
} from "@/lib/long-video/store";
import { deleteLongVideoUploadRef } from "@/lib/long-video/uploads";
import { fastDeleteLongVideoProjectMedia, persistLongVideoProjectSnapshot } from "@/lib/long-video/media";
import { toPublicLongVideoProject } from "@/lib/long-video/domain";
import { validateProductionPrompt } from "@/lib/generation/production-prompt-safety";

type ActionPayload = {
  action?: "confirm" | "update_prompt" | "update_gpu_preference" | "accept" | "regenerate" | "pause" | "resume" | "cancel";
  expectedProjectVersion?: number;
  expectedSegmentVersion?: number;
  sequenceIndex?: number;
  prompt?: string;
  gpuPreference?: Array<"rtx4090" | "rtx5090">;
};

function projectIdFrom(value: string) {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error("长视频项目编号无效。");
  return value;
}

export async function GET(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  try {
    const project = getLongVideoProject(projectIdFrom((await context.params).projectId));
    return project ? NextResponse.json({ project: toPublicLongVideoProject(project) }) : NextResponse.json({ error: "长视频项目不存在。" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取失败。" }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;
  const payload = await request.json().catch(() => ({})) as ActionPayload;
  try {
    const projectId = projectIdFrom((await context.params).projectId);
    const version = Number(payload.expectedProjectVersion);
    let project;
    if (payload.action === "confirm") project = confirmLongVideoProject(projectId, version);
    else if (payload.action === "update_gpu_preference") project = updateLongVideoProjectGpuPreference(projectId, version, payload.gpuPreference ?? []);
    else if (payload.action === "resume") project = resumeLongVideoProject(projectId, version);
    else if (payload.action === "cancel") project = cancelLongVideoProject(projectId, version);
    else if (payload.action === "update_prompt") {
      const prompt = String(payload.prompt ?? "");
      const safety = validateProductionPrompt(prompt);
      if (!safety.allowed) return NextResponse.json({ error: safety.reason, code: safety.code }, { status: 400 });
      project = updateLongVideoSegmentPrompt(projectId, Number(payload.sequenceIndex), prompt, version, Number(payload.expectedSegmentVersion));
    } else if (["accept", "regenerate", "pause"].includes(String(payload.action))) {
      project = reviewLongVideoSegment({
        projectId,
        sequenceIndex: Number(payload.sequenceIndex),
        action: payload.action as "accept" | "regenerate" | "pause",
        expectedProjectVersion: version,
        expectedSegmentVersion: Number(payload.expectedSegmentVersion),
      });
    } else return NextResponse.json({ error: "长视频项目操作无效。" }, { status: 400 });
    persistLongVideoProjectSnapshot(project);
    return NextResponse.json({ project: toPublicLongVideoProject(project), create_order_called: false, provider_authorization_created: false, credit_charged: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "长视频项目操作失败。";
    return NextResponse.json({ error: message }, { status: message.includes("version_conflict") ? 409 : 400 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;
  try {
    const projectId = projectIdFrom((await context.params).projectId);
    const expectedVersion = Number(new URL(request.url).searchParams.get("version"));
    const project = getLongVideoProject(projectId);
    if (project) {
      if (project.version !== expectedVersion) throw new Error("long_video_project_version_conflict");
      const media = fastDeleteLongVideoProjectMedia(project);
      if (!media.removed) return NextResponse.json({ error: "项目媒体尚未清理完成，请重试。" }, { status: 409 });
    }
    const deleted = deleteLongVideoProject(projectId, expectedVersion);
    if (deleted && project) deleteLongVideoProjectTasks(project);
    if (deleted && project?.firstFrameSource === "upload") deleteLongVideoUploadRef(project.firstFrameRef);
    return NextResponse.json({ deleted, create_order_called: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除失败。";
    return NextResponse.json({ error: message }, { status: message.includes("version_conflict") ? 409 : 400 });
  }
}
