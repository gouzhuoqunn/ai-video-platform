import { NextResponse, type NextRequest } from "next/server";
import { openLocalFolderAsset, type LocalFolderAssetIdentity } from "@/lib/local-lab/open-local-folder";
import { guardLocalLabMutation } from "@/lib/local-lab/route-guard";

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;
  try {
    const identity = await request.json() as LocalFolderAssetIdentity;
    await openLocalFolderAsset(identity);
    return NextResponse.json({ opened: true, absolute_path_included: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法打开本地文件夹。", absolute_path_included: false }, { status: 400 });
  }
}
