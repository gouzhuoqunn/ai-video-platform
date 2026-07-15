import { getGpuProvider, parseProviderArg } from "./gpu-providers";

async function main() {
  const id = parseProviderArg();
  const provider = getGpuProvider(id);
  const credentials = await provider.inspectCredentials();
  const candidates = await provider.listCandidates();
  console.log(JSON.stringify({ provider: id, credentials_present: credentials.credentials_present, candidates, creates_session: false }, null, 2));
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "gpu candidates failed"); process.exitCode = 1; });
