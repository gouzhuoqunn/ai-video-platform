import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CANONICAL_SSH_IDENTITY_EVIDENCE_PATH = path.join(
  process.cwd(),
  ".secrets",
  "clore-ssh-identity-evidence.json",
);

export type ParsedOpenSshPublicKey = {
  algorithm: "ssh-ed25519";
  normalizedPublicKey: string;
  fingerprint: string;
};

export type CanonicalSshIdentity = ParsedOpenSshPublicKey & {
  privateKeyPath: string;
  privateKeyIdentifier: string;
  publicKeySource: "derived_from_private_key";
};

let cached:
  | {
      privateKeyPath: string;
      mtimeMs: number;
      identity: CanonicalSshIdentity;
    }
  | null = null;

function sha256Fingerprint(decodedKey: Buffer) {
  return `SHA256:${createHash("sha256").update(decodedKey).digest("base64").replace(/=+$/g, "")}`;
}

export function parseNormalizedOpenSshPublicKey(value: string): ParsedOpenSshPublicKey {
  if (!value || value.charCodeAt(0) === 0xfeff) throw new Error("ssh_public_key_bom_forbidden");
  if (/[\r\n]/.test(value)) throw new Error("ssh_public_key_must_be_one_line");
  if (value !== value.trim()) throw new Error("ssh_public_key_surrounding_whitespace_forbidden");
  if (value.length > 4096) throw new Error("ssh_public_key_provider_length_exceeded");
  const match = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]+)?$/.exec(value);
  if (!match) throw new Error("ssh_public_key_invalid_openssh_format");
  const decoded = Buffer.from(match[2], "base64");
  if (decoded.length < 32 || decoded.toString("base64").replace(/=+$/g, "") !== match[2].replace(/=+$/g, "")) {
    throw new Error("ssh_public_key_invalid_base64");
  }
  if (decoded.length < 4) throw new Error("ssh_public_key_invalid_blob");
  const algorithmLength = decoded.readUInt32BE(0);
  const algorithmStart = 4;
  const algorithmEnd = algorithmStart + algorithmLength;
  if (algorithmEnd + 4 > decoded.length || decoded.subarray(algorithmStart, algorithmEnd).toString("ascii") !== match[1]) {
    throw new Error("ssh_public_key_algorithm_blob_mismatch");
  }
  const keyLength = decoded.readUInt32BE(algorithmEnd);
  if (keyLength !== 32 || algorithmEnd + 4 + keyLength !== decoded.length) {
    throw new Error("ssh_public_key_invalid_ed25519_blob");
  }
  return {
    algorithm: "ssh-ed25519",
    normalizedPublicKey: `${match[1]} ${match[2]}`,
    fingerprint: sha256Fingerprint(decoded),
  };
}

export function deriveCanonicalSshIdentity(privateKeyPath: string): CanonicalSshIdentity {
  const resolved = path.resolve(privateKeyPath);
  if (!existsSync(resolved)) throw new Error("canonical_ssh_private_key_missing");
  const metadata = statSync(resolved);
  if (cached?.privateKeyPath === resolved && cached.mtimeMs === metadata.mtimeMs) return cached.identity;
  const derived = spawnSync("ssh-keygen", ["-y", "-f", resolved], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (derived.status !== 0) throw new Error("canonical_ssh_private_key_parse_failed");
  const raw = String(derived.stdout ?? "").replace(/\r?\n$/, "");
  const parsed = parseNormalizedOpenSshPublicKey(raw);
  const identity: CanonicalSshIdentity = {
    ...parsed,
    privateKeyPath: resolved,
    privateKeyIdentifier: path.basename(resolved),
    publicKeySource: "derived_from_private_key",
  };
  cached = { privateKeyPath: resolved, mtimeMs: metadata.mtimeMs, identity };
  return identity;
}

export function assertPublicKeyMatchesCanonicalIdentity(value: string, identity: CanonicalSshIdentity) {
  const parsed = parseNormalizedOpenSshPublicKey(value);
  if (parsed.fingerprint !== identity.fingerprint || parsed.normalizedPublicKey !== identity.normalizedPublicKey) {
    throw new Error("ssh_public_private_fingerprint_mismatch");
  }
  return parsed;
}

export function persistCanonicalSshIdentityEvidence(
  identity: CanonicalSshIdentity,
  evidencePath = CANONICAL_SSH_IDENTITY_EVIDENCE_PATH,
) {
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  const evidence = {
    schemaVersion: 1,
    algorithm: identity.algorithm,
    fingerprint: identity.fingerprint,
    privateKeyIdentifier: identity.privateKeyIdentifier,
    publicKeySource: identity.publicKeySource,
    publicPrivateFingerprintMatch: true,
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return evidence;
}

export function buildSanitizedSshCredentialSummary(
  publicKey: string | undefined,
  identity: CanonicalSshIdentity,
) {
  if (!publicKey) throw new Error("create_order_ssh_key_missing");
  const parsed = assertPublicKeyMatchesCanonicalIdentity(publicKey, identity);
  return {
    ssh_key_present: true,
    ssh_key_algorithm: parsed.algorithm,
    ssh_key_fingerprint: parsed.fingerprint,
    private_key_identifier: identity.privateKeyIdentifier,
    public_key_source: identity.publicKeySource,
    private_key_fingerprint_match: true,
    key_material_logged: false,
  };
}

export function assertNoSshCredentialMaterial(value: string) {
  if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(value) || /ssh-ed25519\s+[A-Za-z0-9+/]{20,}/.test(value)) {
    throw new Error("ssh_credential_material_in_output");
  }
}
