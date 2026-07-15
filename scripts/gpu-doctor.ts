import { getGpuProvider } from "./gpu-providers";

async function main() {
  const providers = await Promise.all((["clore", "runpod", "manual_ssh"] as const).map(async (id) => {
    const provider = getGpuProvider(id);
    const credentials = await provider.inspectCredentials();
    let active_session = false;
    let read_only_probe: "passed" | "skipped" | "failed" = "skipped";
    if (credentials.safe_to_query) {
      try { active_session = Boolean(await provider.recoverExistingSession()); read_only_probe = "passed"; }
      catch { read_only_probe = "failed"; }
    }
    return { id, credentials_present: credentials.credentials_present, credential_source: credentials.source, read_only_probe, active_session };
  }));
  console.log(JSON.stringify({ providers, creates_session: false, exposes_credentials: false }, null, 2));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "gpu doctor failed"); process.exitCode = 1; });
