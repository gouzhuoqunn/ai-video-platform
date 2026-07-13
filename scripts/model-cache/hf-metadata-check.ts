import { assertNoSecretOutput } from "../clore/client";
import { WAN_MODEL_EXPECTED_SIZE_GB, WAN_MODEL_REPO, WAN_MODEL_REVISION } from "./model-version";

async function head(url: string) {
  const response = await fetch(url, {
    method: "HEAD",
    signal: AbortSignal.timeout(30000),
    headers: {
      "user-agent": "ai-video-platform-preflight/0.1",
    },
  });
  return { ok: response.ok, status: response.status };
}

async function main() {
  const readmeUrl = `https://huggingface.co/${WAN_MODEL_REPO}/resolve/${WAN_MODEL_REVISION}/README.md`;
  let reachable = false;
  let status: number | null = null;
  let errorName: string | null = null;

  try {
    const result = await head(readmeUrl);
    reachable = result.ok;
    status = result.status;
  } catch (error) {
    errorName = error instanceof Error ? error.name : "error";
  }

  const output = JSON.stringify(
    {
      repo: WAN_MODEL_REPO,
      revision_pinned: WAN_MODEL_REVISION,
      expected_size_gb: WAN_MODEL_EXPECTED_SIZE_GB,
      anonymous_head_attempted: true,
      downloads_weights: false,
      requires_hf_token_when_public: false,
      reachable,
      status,
      error_name: errorName,
      secrets_printed: false,
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Hugging Face metadata check failed");
  process.exitCode = 1;
});
