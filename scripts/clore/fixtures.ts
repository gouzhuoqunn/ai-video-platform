import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertNoSecretOutput } from "./client";

const FIXTURE_DIR = path.join(process.cwd(), "scripts", "clore", "fixtures");

export function writeSanitizedFixture(name: string, payload: unknown) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const output = `${JSON.stringify(payload, null, 2)}\n`;
  assertNoSecretOutput(output);
  writeFileSync(path.join(FIXTURE_DIR, `${name}.sanitized.json`), output, "utf8");
}
