import { existsSync, readFileSync } from "node:fs";

export function inspectSshPublicKey(publicKeyPath: string) {
  const exists = existsSync(publicKeyPath);
  if (!exists) {
    return { path: publicKeyPath, exists: false, formatValid: false };
  }

  const firstLine = readFileSync(publicKeyPath, "utf8").split(/\r?\n/)[0] ?? "";
  return {
    path: publicKeyPath,
    exists: true,
    formatValid: /^ssh-ed25519\s+[A-Za-z0-9+/=]+(?:\s+.+)?$/.test(firstLine.trim()),
  };
}
