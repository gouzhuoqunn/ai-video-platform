import { NextResponse, type NextRequest } from "next/server";
import { guardLocalLabMutation } from "@/lib/local-lab/route-guard";
import { persistLongVideoUpload } from "@/lib/long-video/uploads";

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "请选择首帧图片。" }, { status: 400 });
    const upload = persistLongVideoUpload(new Uint8Array(await file.arrayBuffer()));
    return NextResponse.json({ ...upload, url: `/api/local-lab/long-video/uploads/${upload.uploadId}` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "上传失败。" }, { status: 400 });
  }
}
