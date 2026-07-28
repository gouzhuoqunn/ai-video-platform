import { NextResponse, type NextRequest } from "next/server";
import {
  listRegisteredLoras,
  registerLoraFromUrl,
  updateRegisteredLora,
} from "@/lib/image-generation/local-lora-registry";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export const dynamic = "force-dynamic";

function publicError(error: unknown) {
  const code = error instanceof Error ? error.message.split(":")[0] : "lora_registry_failed";
  const messages: Record<string, string> = {
    unsupported_lora_source_url: "只支持 Civitai 或 HuggingFace 的 HTTPS 模型页/下载链接。",
    invalid_lora_display_name: "LoRA 名称不能为空，且最多 80 个字符。",
    invalid_lora_registration: "请填写有效的链接、名称和 0.0～1.5 的默认强度。",
    invalid_lora_strength: "LoRA 默认强度必须在 0.0～1.5 之间。",
    civitai_lora_version_missing: "没有从该 Civitai 链接找到明确的模型版本。",
    civitai_lora_file_ambiguous_or_missing: "该 Civitai 版本没有唯一可识别的 safetensors 文件，请粘贴具体版本或下载链接。",
    civitai_lora_identity_incomplete: "Civitai 没有提供该文件的完整 SHA-256 身份，已拒绝注册。",
    civitai_model_is_not_lora: "该 Civitai 页面不是 LoRA 模型，已拒绝注册。",
    huggingface_repository_missing: "HuggingFace 仓库地址不完整。",
    huggingface_lora_file_url_required: "该 HuggingFace 仓库含多个文件，请粘贴具体 safetensors 文件链接。",
    huggingface_lora_file_ambiguous_or_missing: "没有找到唯一的 HuggingFace safetensors 文件。",
    huggingface_lora_identity_incomplete: "HuggingFace 文件缺少可验证的 LFS SHA-256 或大小。",
    huggingface_immutable_revision_missing: "无法把 HuggingFace 链接解析到不可变提交。",
    lora_source_content_length_missing: "下载源没有返回可验证的文件大小。",
    lora_source_size_out_of_range: "LoRA 文件大小不在允许范围内。",
    lora_source_nonpublic_address: "下载来源解析到了非公网地址，已拒绝访问。",
    lora_source_dns_timeout: "下载来源 DNS 校验超时，没有注册任何文件。",
    lora_filename_identity_conflict: "已有同名文件但 SHA-256 不同；为保护排队任务，不能覆盖原记录。",
    lora_digest_identity_conflict: "已有相同 SHA-256 但来源身份不同；为保护排队任务，不能原地替换。",
    invalid_safetensors_header_length: "文件不是有效的 safetensors，或头部大小异常。",
    lora_safetensors_header_invalid_json: "文件的 safetensors 头部不是有效 JSON。",
    lora_safetensors_header_incomplete: "下载源没有返回完整的 safetensors 头部。",
    huggingface_lora_size_mismatch: "HuggingFace 元数据大小与实际下载响应不一致。",
    lora_registry_capacity_exceeded: "LoRA 注册表已达到 64 项上限。",
    lora_registry_item_not_found: "没有找到要更新的 LoRA。",
    lora_registry_lock_timeout: "LoRA 注册表正被另一个本地操作占用，请稍后重试。",
  };
  if (code.startsWith("lora_metadata_http_") || code.startsWith("lora_source_http_")) {
    return { code, message: "模型来源暂时无法访问，请检查链接或本地 Civitai/HuggingFace 凭据。" };
  }
  if (code === "AbortError" || /abort|timeout/i.test(code)) {
    return { code: "lora_source_timeout", message: "模型来源响应超时，没有注册任何文件。" };
  }
  return { code, message: messages[code] ?? "LoRA 校验或注册失败，没有保存未验证的文件。" };
}

export function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  try {
    return NextResponse.json(
      { items: listRegisteredLoras() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const failure = publicError(error);
    return NextResponse.json({ error: failure.message, code: failure.code }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guard = guardLocalLabMutation(request);
  if (guard) return guard;
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return NextResponse.json({ error: "LoRA 操作必须使用 JSON。", code: "invalid_content_type" }, { status: 415 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
    return NextResponse.json({ error: "LoRA 请求内容过大。", code: "lora_request_too_large" }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "LoRA 请求 JSON 无效。", code: "invalid_json" }, { status: 400 });
  }
  try {
    if (body.action === "add") {
      const result = await registerLoraFromUrl({
        name: body.name,
        sourceUrl: body.sourceUrl,
        defaultStrength: body.defaultStrength,
        presetId: body.presetId,
      });
      return NextResponse.json({
        item: result.item,
        items: result.items,
        verification: result.verification,
        message: "已固定来源、文件大小和平台 SHA-256 身份；下次生成时会下载到云端并逐字节校验后放入 ComfyUI 的 loras 目录。",
      });
    }
    if (body.action === "update") {
      const result = updateRegisteredLora({
        id: body.id,
        name: body.name,
        defaultStrength: body.defaultStrength,
      });
      return NextResponse.json({ ...result, message: "LoRA 名称和默认强度已保存。" });
    }
    return NextResponse.json({ error: "不支持的 LoRA 操作。", code: "unsupported_lora_action" }, { status: 400 });
  } catch (error) {
    const failure = publicError(error);
    return NextResponse.json({ error: failure.message, code: failure.code }, { status: 400 });
  }
}
