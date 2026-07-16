import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertNoSecretOutput } from "./client";
import { loadCloreConfig } from "./config";
import { getPrivateKeyPath, getPublicKeyPath } from "./ssh-client";

const OVERRIDE_PATH = path.join(process.cwd(), ".secrets", "clore-project-ssh-key.json");

function publicParts(value: string) {
  const match = /^(ssh-ed25519)\s+([A-Za-z0-9+/=]+)(?:\s+.*)?$/.exec(value.trim());
  return match ? { type: match[1], body: match[2] } : null;
}

function lineEnding(value: string) {
  const crlf = /\r\n/.test(value); const bareLf = /(^|[^\r])\n/.test(value);
  return crlf && bareLf ? "mixed" : crlf ? "CRLF" : "LF";
}

function fingerprint(publicKeyPath: string) {
  const result = spawnSync("ssh-keygen", ["-lf", publicKeyPath, "-E", "sha256"], { encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) throw new Error("ssh_public_key_fingerprint_failed");
  const match = /SHA256:([A-Za-z0-9+/]+)/.exec(String(result.stdout));
  return match?.[1]?.slice(-12) ?? "unknown";
}

export function validateSshKeyPair(input: { privateKeyPath: string; publicKeyPath: string }) {
  if (!existsSync(input.privateKeyPath) || !existsSync(input.publicKeyPath)) return { valid: false, reason: "key_file_missing" as const };
  const privateText = readFileSync(input.privateKeyPath, "utf8"); const publicText = readFileSync(input.publicKeyPath, "utf8");
  const derived = spawnSync("ssh-keygen", ["-y", "-f", input.privateKeyPath], { encoding: "utf8", timeout: 15_000 });
  if (derived.status !== 0) return { valid: false, reason: "private_key_parse_failed" as const };
  const configured = publicParts(publicText); const derivedParts = publicParts(String(derived.stdout));
  const privateFormatValid = /-----BEGIN OPENSSH PRIVATE KEY-----/.test(privateText) && /-----END OPENSSH PRIVATE KEY-----/.test(privateText);
  const endings = lineEnding(privateText); const publicEndings = lineEnding(publicText);
  const matches = Boolean(configured && derivedParts && configured.type === derivedParts.type && configured.body === derivedParts.body);
  return { valid: privateFormatValid && endings !== "mixed" && publicEndings !== "mixed" && matches, reason: matches ? "ok" as const : "public_private_mismatch" as const, keyType: configured?.type ?? derivedParts?.type ?? "unknown", fingerprintSuffix: configured ? fingerprint(input.publicKeyPath) : "unknown", privateLineEndings: endings, publicLineEndings: publicEndings, privateFormatValid, publicFormatValid: Boolean(configured), publicMatchesDerived: matches };
}

export function ensureValidatedProjectSshKey() {
  const config = loadCloreConfig();
  let privateKeyPath = getPrivateKeyPath(); let publicKeyPath = getPublicKeyPath(config.sshPublicKeyPath);
  let result = validateSshKeyPair({ privateKeyPath, publicKeyPath }); let dedicatedKeyCreated = false;
  if (!result.valid) {
    privateKeyPath = path.join(process.cwd(), ".secrets", "clore-stage3r-ed25519"); publicKeyPath = `${privateKeyPath}.pub`;
    mkdirSync(path.dirname(privateKeyPath), { recursive: true });
    const created = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "ai-video-platform-stage3r", "-f", privateKeyPath], { encoding: "utf8", timeout: 30_000 });
    if (created.status !== 0) throw new Error("dedicated_project_ssh_key_creation_failed");
    writeFileSync(OVERRIDE_PATH, `${JSON.stringify({ privateKeyPath, publicKeyPath }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    result = validateSshKeyPair({ privateKeyPath, publicKeyPath }); dedicatedKeyCreated = true;
  }
  if (!result.valid) throw new Error(`ssh_key_validation_failed:${result.reason}`);
  return { valid: true, keyType: result.keyType, fingerprintSuffix: result.fingerprintSuffix, privateLineEndings: result.privateLineEndings, publicLineEndings: result.publicLineEndings, publicMatchesDerived: result.publicMatchesDerived, dedicatedKeyCreated, privateKeyPath, publicKeyPath };
}

if (process.argv[1]?.endsWith("ssh-key-validation.ts")) {
  const result = ensureValidatedProjectSshKey();
  const output = JSON.stringify({ valid: result.valid, keyType: result.keyType, fingerprintSuffix: result.fingerprintSuffix, privateLineEndings: result.privateLineEndings, publicLineEndings: result.publicLineEndings, publicMatchesDerived: result.publicMatchesDerived, dedicatedKeyCreated: result.dedicatedKeyCreated, keyContentsPrinted: false }, null, 2);
  assertNoSecretOutput(output); console.log(output);
}
