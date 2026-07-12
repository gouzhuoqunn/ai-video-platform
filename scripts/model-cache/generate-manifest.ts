import { assertNoSecretOutput } from "../clore/client";
import { buildMockManifest } from "./manifest";

function main() {
  const output = JSON.stringify(buildMockManifest(), null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

void main();
