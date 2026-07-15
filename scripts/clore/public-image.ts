export const CLORE_LIGHT_BOOTSTRAP_PROFILE = "clore_light_bootstrap" as const;
export const CLORE_LIGHT_BOOTSTRAP_IMAGE = "cloreai/jupyter:ubuntu24.04-v2";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type RegistryToken = { token?: string };
type RegistryManifest = {
  mediaType?: string;
  manifests?: Array<{ digest?: string; platform?: { architecture?: string; os?: string } }>;
};

export async function verifyCloreLightBootstrapImage(fetchImpl: typeof fetch = fetch) {
  const repository = "cloreai/jupyter";
  const tag = "ubuntu24.04-v2";
  const tokenResponse = await fetchImpl(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`);
  if (!tokenResponse.ok) throw new Error(`clore_light_bootstrap_token_http_${tokenResponse.status}`);
  const token = (await tokenResponse.json() as RegistryToken).token;
  if (!token) throw new Error("clore_light_bootstrap_token_missing");
  const manifestResponse = await fetchImpl(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
  });
  if (!manifestResponse.ok) throw new Error(`clore_light_bootstrap_manifest_http_${manifestResponse.status}`);
  const manifest = await manifestResponse.json() as RegistryManifest;
  const digest = manifestResponse.headers.get("docker-content-digest");
  const linuxAmd64 = !manifest.manifests || manifest.manifests.some((entry) => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64");
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest) || !linuxAmd64) throw new Error("clore_light_bootstrap_manifest_invalid");
  return { image: CLORE_LIGHT_BOOTSTRAP_IMAGE, digest, mediaType: manifest.mediaType ?? "unknown", public: true, linuxAmd64: true };
}

export function readCloreLightBootstrapReceipt() {
  const filePath = path.join(process.cwd(), ".secrets", "clore-light-bootstrap-manifest.json");
  if (!existsSync(filePath)) return null;
  const receipt = JSON.parse(readFileSync(filePath, "utf8")) as { image?: string; digest?: string; linuxAmd64?: boolean; verifiedAt?: string; sourceRunId?: number };
  const ageMs = Date.now() - Date.parse(receipt.verifiedAt ?? "");
  if (receipt.image !== CLORE_LIGHT_BOOTSTRAP_IMAGE || !/^sha256:[a-f0-9]{64}$/.test(receipt.digest ?? "") || receipt.linuxAmd64 !== true || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) return null;
  return { image: CLORE_LIGHT_BOOTSTRAP_IMAGE, digest: receipt.digest!, mediaType: "github_actions_verified_manifest", public: true, linuxAmd64: true, sourceRunId: receipt.sourceRunId ?? null };
}

export async function loadVerifiedCloreLightBootstrapImage() {
  try {
    return await verifyCloreLightBootstrapImage();
  } catch {
    const receipt = readCloreLightBootstrapReceipt();
    if (!receipt) throw new Error("clore_light_bootstrap_public_manifest_not_verified");
    return receipt;
  }
}
