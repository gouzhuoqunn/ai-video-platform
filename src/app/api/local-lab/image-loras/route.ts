import { NextResponse, type NextRequest } from "next/server";
import {
  listRegisteredLoras,
  registerLoraFromUrl,
  updateRegisteredLora,
} from "@/lib/image-generation/local-lora-registry";
import type { RegisteredLora } from "@/lib/image-generation/image-loras";
import { guardLocalLabMutation, guardLocalLabRequest } from "@/lib/local-lab/route-guard";

export const dynamic = "force-dynamic";

function publicError(error: unknown) {
  const code = error instanceof Error ? error.message.split(":")[0] : "lora_registry_failed";
  const messages: Record<string, string> = {
    unsupported_lora_source_url: "无法识别此链接，请提供 Civitai 模型页、带 fileId 的下载链接，或 HuggingFace 模型地址。",
    unrecognized_lora_source_url: "无法识别此链接，请提供 Civitai 模型页、带 fileId 的下载链接，或 HuggingFace 模型地址。",
    lora_source_url_contains_credentials: "链接中包含令牌或签名参数。请改用不含凭据的 Civitai、HuggingFace 或公开下载地址。",
    direct_lora_source_identity_unavailable: "该直接下载地址缺少可信的文件大小和 SHA-256；请改用可解析的 Civitai 或 HuggingFace 模型地址。",
    invalid_lora_display_name: "LoRA 名称不能为空，且最多 80 个字符。",
    invalid_lora_registration: "请填写有效的链接、名称和 0.0～1.5 的默认强度。",
    invalid_lora_strength: "LoRA 默认强度必须在 0.0～1.5 之间。",
    civitai_lora_version_missing: "没有从该 Civitai 链接找到明确的模型版本。",
    civitai_lora_file_ambiguous_or_missing: "该 Civitai 版本没有唯一可识别的 safetensors 文件，请粘贴具体版本或下载链接。",
    civitai_lora_identity_incomplete: "Civitai 没有提供足够的模型文件信息，请尝试具体版本或带 fileId 的下载链接。",
    civitai_model_is_not_lora: "该 Civitai 页面不是 LoRA 模型，已拒绝注册。",
    huggingface_repository_missing: "HuggingFace 仓库地址不完整。",
    huggingface_lora_file_url_required: "该 HuggingFace 仓库含多个文件，请粘贴具体 safetensors 文件链接。",
    huggingface_lora_file_ambiguous_or_missing: "没有找到唯一的 HuggingFace safetensors 文件。",
    huggingface_lora_identity_incomplete: "HuggingFace 没有提供足够的模型文件信息，请尝试具体 safetensors 文件链接。",
    huggingface_immutable_revision_missing: "无法把 HuggingFace 链接解析到不可变提交。",
    lora_source_content_length_missing: "下载源没有返回可验证的文件大小。",
    lora_source_size_out_of_range: "LoRA 文件大小不在允许范围内。",
    lora_source_nonpublic_address: "下载来源解析到了非公网地址，已拒绝访问。",
    lora_source_dns_timeout: "下载来源 DNS 校验超时，请稍后重试。",
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
    return { code: "lora_source_timeout", message: "LoRA 注册请求超时，请检查网络后重试。" };
  }
  return { code, message: messages[code] ?? "LoRA 注册失败，请检查链接格式、模型访问权限或稍后重试。" };
}

/**
 * The registry retains the exact user-provided URL for deferred Agent
 * resolution. The browser only needs the selectable display projection and
 * must never receive that raw registration URL back from the API.
 */
function publicLora(item: RegisteredLora) {
  const projected = { ...item };
  delete projected.registrationSource;
  return projected;
}

export function GET(request: NextRequest) {
  const guard = guardLocalLabRequest(request);
  if (guard) return guard;
  try {
    return NextResponse.json(
      { items: listRegisteredLoras().map(publicLora) },
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
        item: publicLora(result.item),
        items: result.items.map(publicLora),
        verification: result.verification,
        message: result.item.availability === "registered"
          ? "已注册，生成时由云端 Agent 下载并校验大小、SHA-256 与 safetensors 结构。"
          : "已固定来源、文件大小和平台 SHA-256 身份；生成时会再次逐字节校验后放入 ComfyUI 的 loras 目录。",
      });
    }
    if (body.action === "update") {
      const result = updateRegisteredLora({
        id: body.id,
        name: body.name,
        defaultStrength: body.defaultStrength,
      });
      return NextResponse.json({
        item: publicLora(result.item),
        items: result.items.map(publicLora),
        message: "LoRA 名称和默认强度已保存。",
      });
    }
    return NextResponse.json({ error: "不支持的 LoRA 操作。", code: "unsupported_lora_action" }, { status: 400 });
  } catch (error) {
    const failure = publicError(error);
    return NextResponse.json({ error: failure.message, code: failure.code }, { status: 400 });
  }
}
