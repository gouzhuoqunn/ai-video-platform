import type { SignedVideoResponse } from "@/types/video-jobs";

export async function requestSignedVideoUrl(jobId: string): Promise<SignedVideoResponse> {
  const response = await fetch(`/api/video-jobs/${jobId}/signed-url`, {
    method: "GET",
  });

  const payload = (await response.json()) as Partial<SignedVideoResponse> & { error?: string };

  if (!response.ok || !payload.signedUrl || !payload.filename || !payload.mimeType || !payload.expiresIn) {
    throw new Error(payload.error ?? "获取视频临时链接失败。");
  }

  return {
    signedUrl: payload.signedUrl,
    expiresIn: payload.expiresIn,
    mimeType: payload.mimeType,
    filename: payload.filename,
  };
}
