import { assertNoSecretOutput } from "./clore/client";
import { firstImageRestorePreflight, sanitizeS3Error } from "./model-cache/flux4090-cache";

async function main() {
  const result = await firstImageRestorePreflight();
  const text = JSON.stringify(result, null, 2);
  assertNoSecretOutput(text);
  console.log(text);
}

void main().catch((error) => {
  console.error(JSON.stringify({ error: sanitizeS3Error(error), r2_restore_plan_valid: false }, null, 2));
  process.exitCode = 1;
});
