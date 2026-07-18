import { createHash } from "node:crypto";

function sshString(value: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

export function syntheticEd25519PublicKey(label: string) {
  const algorithm = Buffer.from("ssh-ed25519", "ascii");
  const publicBytes = createHash("sha256").update(`ai-video-platform:${label}`).digest();
  const blob = Buffer.concat([sshString(algorithm), sshString(publicBytes)]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}
