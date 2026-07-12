import { assertNoSecretOutput } from "../clore/client";
import { buildLocalResultsPlan } from "./plan";

function main() {
  const output = JSON.stringify(buildLocalResultsPlan(), null, 2);
  assertNoSecretOutput(output);
  console.log(output);
}

void main();
