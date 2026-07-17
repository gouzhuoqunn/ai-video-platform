import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { loadProductionFamilies } from "./production-model-cache";

function secretFromFile(filePath: string, name: string) {
  if (!existsSync(filePath)) return "";
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

async function headStatus(url: string, token: string) {
  if (process.platform === "win32") {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        const status = Number(stdout.trim().split(/\r?\n/).at(-1));
        if (code === 0 && Number.isInteger(status)) resolve(status);
        else reject(new Error(`metadata_head_transport_failed:${code}:${stderr.trim().split(/\r?\n/)[0] ?? "unknown"}`));
      });
      const literal = (value: string) => value.replaceAll("'", "''");
      child.stdin.end([
        "Add-Type -AssemblyName System.Net.Http",
        "$handler=[System.Net.Http.HttpClientHandler]::new()",
        "$handler.AllowAutoRedirect=$false",
        "$client=[System.Net.Http.HttpClient]::new($handler)",
        "$client.Timeout=[TimeSpan]::FromSeconds(30)",
        `$request=[System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head,'${literal(url)}')`,
        "$request.Headers.UserAgent.ParseAdd('ai-video-platform-stage3y')",
        ...(token ? [`$request.Headers.Authorization=[System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer','${literal(token)}')`] : []),
        "$response=$client.SendAsync($request).GetAwaiter().GetResult()",
        "Write-Output ([int]$response.StatusCode)",
        "$response.Dispose();$request.Dispose();$client.Dispose();$handler.Dispose()",
        "",
      ].join("\n"));
    });
  }
  return await new Promise<number>((resolve, reject) => {
    const child = spawn("curl", ["--config", "-", "--silent", "--show-error", "--head", "--max-redirs", "0", "--output", os.devNull, "--write-out", "%{http_code}"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      const status = Number(stdout.trim());
      if ((code === 0 || status > 0) && Number.isInteger(status)) resolve(status);
      else reject(new Error(`metadata_head_transport_failed:${code}:${stderr.trim().split(/\r?\n/)[0] ?? "unknown"}`));
    });
    child.stdin.end([
      `url = "${url}"`,
      'user-agent = "ai-video-platform-stage3y"',
      ...(token ? [`header = "Authorization: Bearer ${token}"`] : []),
      "",
    ].join("\n"));
  });
}

async function main() {
  const allFiles = process.argv.includes("--all");
  const civitaiToken = process.env.CIVITAI_API_TOKEN?.trim() || secretFromFile(path.join(process.cwd(), ".secrets", "civitai.env"), "CIVITAI_API_TOKEN");
  if (!civitaiToken) throw new Error("missing_file_or_variable:.secrets/civitai.env:CIVITAI_API_TOKEN");
  const hfToken = process.env.HF_TOKEN?.trim() || secretFromFile(path.join(process.cwd(), ".secrets", "huggingface.env"), "HF_TOKEN");
  const files = loadProductionFamilies().flatMap((family) => family.objects).filter((file) => allFiles || file.source.includes("civitai.com"));
  const results = [];
  for (const file of files) {
    const civitai = file.source.includes("civitai.com");
    const status = await headStatus(file.source, civitai ? civitaiToken : hfToken);
    results.push({
      provider: civitai ? "civitai" : "huggingface",
      fileId: file.sourceFileId ?? null,
      filename: path.posix.basename(file.path),
      expectedSize: file.bytes,
      sha256: file.sha256.toUpperCase(),
      httpStatus: status,
      accessOk: [200, 206, 302, 303, 307, 308].includes(status),
    });
  }
  console.log(JSON.stringify({ civitaiTokenPresent: true, hfTokenPresent: Boolean(hfToken), results }, null, 2));
  if (results.some((result) => !result.accessOk)) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
