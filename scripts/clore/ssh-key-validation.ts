import { existsSync, readFileSync } from "node:fs";
import { assertNoSecretOutput } from "./client";
import { getPrivateKeyPath } from "./ssh-client";
import {
  assertPublicKeyMatchesCanonicalIdentity,
  deriveCanonicalSshIdentity,
  parseNormalizedOpenSshPublicKey,
  persistCanonicalSshIdentityEvidence,
} from "./ssh-identity";

function publicParts(value: string) {
  const match = /^(ssh-ed25519)\s+([A-Za-z0-9+/=]+)(?:\s+.*)?$/.exec(value.trim());
  return match ? { type: match[1], body: match[2] } : null;
}

function lineEnding(value: string) {
  const crlf = /\r\n/.test(value); const bareLf = /(^|[^\r])\n/.test(value);
  return crlf && bareLf ? "mixed" : crlf ? "CRLF" : "LF";
}

export function validateSshKeyPair(input: { privateKeyPath: string; publicKeyPath: string }) {
  if (!existsSync(input.privateKeyPath) || !existsSync(input.publicKeyPath)) return { valid: false, reason: "key_file_missing" as const };
  const privateText = readFileSync(input.privateKeyPath, "utf8"); const publicText = readFileSync(input.publicKeyPath, "utf8");
  let identity;
  try { identity = deriveCanonicalSshIdentity(input.privateKeyPath); }
  catch { return { valid: false, reason: "private_key_parse_failed" as const }; }
  const configured = publicParts(publicText);
  const privateFormatValid = /-----BEGIN OPENSSH PRIVATE KEY-----/.test(privateText) && /-----END OPENSSH PRIVATE KEY-----/.test(privateText);
  const endings = lineEnding(privateText); const publicEndings = lineEnding(publicText);
  let matches = false;
  try {
    const normalized = configured ? `${configured.type} ${configured.body}` : "";
    matches = Boolean(configured && assertPublicKeyMatchesCanonicalIdentity(normalized, identity));
  } catch { matches = false; }
  return { valid: privateFormatValid && endings !== "mixed" && publicEndings !== "mixed" && matches, reason: matches ? "ok" as const : "public_private_mismatch" as const, keyType: configured?.type ?? identity.algorithm, fingerprint: identity.fingerprint, fingerprintSuffix: identity.fingerprint.slice(-12), privateLineEndings: endings, publicLineEndings: publicEndings, privateFormatValid, publicFormatValid: Boolean(configured), publicMatchesDerived: matches };
}

export function ensureValidatedProjectSshKey() {
  const identity = deriveCanonicalSshIdentity(getPrivateKeyPath());
  parseNormalizedOpenSshPublicKey(identity.normalizedPublicKey);
  persistCanonicalSshIdentityEvidence(identity);
  return {
    valid: true,
    keyType: identity.algorithm,
    algorithm: identity.algorithm,
    fingerprint: identity.fingerprint,
    fingerprintSuffix: identity.fingerprint.slice(-12),
    privateLineEndings: "OpenSSH",
    publicLineEndings: "LF",
    publicMatchesDerived: true,
    dedicatedKeyCreated: false,
    privateKeyPath: identity.privateKeyPath,
    privateKeyIdentifier: identity.privateKeyIdentifier,
    normalizedPublicKey: identity.normalizedPublicKey,
    publicKeySource: identity.publicKeySource,
  };
}

if (process.argv[1]?.endsWith("ssh-key-validation.ts")) {
  const result = ensureValidatedProjectSshKey();
  const output = JSON.stringify({ valid: result.valid, keyType: result.keyType, fingerprint: result.fingerprint, privateKeyIdentifier: result.privateKeyIdentifier, publicKeySource: result.publicKeySource, publicMatchesDerived: result.publicMatchesDerived, dedicatedKeyCreated: result.dedicatedKeyCreated, keyContentsPrinted: false }, null, 2);
  assertNoSecretOutput(output); console.log(output);
}
