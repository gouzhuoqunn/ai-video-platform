import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabMutation } from "@/lib/local-lab/route-guard";
import {
  commitLongVideoMerge,
  completeLongVideoSegmentCleanup,
  markLongVideoMergeFailed,
  markLongVideoMergeStarted,
} from "@/lib/long-video/store";
import { cleanupLongVideoSegmentMedia, mergeLongVideoProjectMedia, persistLongVideoProjectSnapshot } from "@/lib/long-video/media";
import { toPublicLongVideoProject } from "@/lib/long-video/domain";

export async function POST(request: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;
  const payload = await request.json().catch(() => ({})) as { expectedProjectVersion?: number };
  const { projectId } = await context.params;
  try {
    let project = markLongVideoMergeStarted(projectId, Number(payload.expectedProjectVersion));
    try {
      const merged = mergeLongVideoProjectMedia({ project });
      project = commitLongVideoMerge({
        projectId,
        expectedVersion: project.version,
        finalVideoRef: merged.finalVideoRef,
        finalThumbnailRef: merged.finalThumbnailRef,
        actualDurationSeconds: merged.evidence.output.durationSeconds,
      });
      const cleanup = cleanupLongVideoSegmentMedia(project);
      project = completeLongVideoSegmentCleanup(projectId, project.version, cleanup);
      persistLongVideoProjectSnapshot(project);
      return NextResponse.json({
        project: toPublicLongVideoProject(project),
        merge: {
          strategy: merged.strategy,
          durationSeconds: merged.evidence.output.durationSeconds,
          videoUrl: `/api/local-lab/long-video/${projectId}/media/video`,
          thumbnailUrl: `/api/local-lab/long-video/${projectId}/media/thumbnail`,
        },
        create_order_called: false,
      });
    } catch (error) {
      markLongVideoMergeFailed(projectId, project.version);
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "长视频合并失败。";
    return NextResponse.json({ error: message }, { status: message.includes("version_conflict") ? 409 : 400 });
  }
}
