import { mkdirSync, writeFileSync } from "node:fs";
import { assertNoSecretOutput } from "../clore/client";
import { buildLocalJobPaths, loadLocalResultsConfig } from "./config";

function main() {
  const config = loadLocalResultsConfig();
  const date = new Date().toISOString().slice(0, 10);
  const mockJobId = "dry-run-job";
  const paths = buildLocalJobPaths(config.libraryDir, date, mockJobId);
  mkdirSync(paths.jobDir, { recursive: true });
  writeFileSync(
    paths.metadataPath,
    `${JSON.stringify(
      {
        dry_run: true,
        job_id: mockJobId,
        status: "mock_synced",
        signed_url_printed: false,
        prompt_included: false,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const output = JSON.stringify(
    {
      dry_run: true,
      downloaded: false,
      signed_url_printed: false,
      metadata_written: paths.metadataPath,
      next_real_mode: "Use a future execute flag only after local_lab signed URL flow is ready.",
    },
    null,
    2,
  );
  assertNoSecretOutput(output);
  console.log(output);
}

void main();
