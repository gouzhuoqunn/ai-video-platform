import { existsSync } from "node:fs";
import { assertNoSecretOutput } from "../clore/client";
import { loadLocalResultsConfig } from "./config";

function main() {
  const config = loadLocalResultsConfig();
  const output = JSON.stringify(
    {
      library_dir: config.libraryDir,
      library_dir_exists: existsSync(config.libraryDir),
      verifies_partial_downloads: true,
      requires_metadata_json: true,
      requires_output_video: true,
      prints_signed_urls: false,
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

void main();
