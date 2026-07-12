export type DockerImageVerification = {
  image: string;
  exists: boolean;
  linuxAmd64: boolean;
  method: string;
  note?: string;
};

async function verifyWithPowerShell(repo: string, tag: string, image: string): Promise<DockerImageVerification> {
  const { spawnSync } = await import("node:child_process");
  if (!/^[a-z0-9/_-]+$/i.test(repo) || !/^[a-z0-9._-]+$/i.test(tag)) {
    return { image, exists: false, linuxAmd64: false, method: "docker-registry-api", note: "invalid image name for fallback" };
  }
  const command = [
    `$repo='${repo}'`,
    `$tag='${tag}'`,
    `$tokenResp = Invoke-RestMethod -Uri "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull" -UseBasicParsing`,
    `$headers = @{ Authorization = "Bearer $($tokenResp.token)"; Accept = 'application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' }`,
    `$manifest = Invoke-RestMethod -Uri "https://registry-1.docker.io/v2/${repo}/manifests/${tag}" -Headers $headers -UseBasicParsing`,
    `$amd64 = $manifest.manifests | Where-Object { $_.platform.os -eq 'linux' -and $_.platform.architecture -eq 'amd64' } | Select-Object -First 1`,
    `if ($amd64) { 'linux-amd64:true' } else { 'linux-amd64:false' }`,
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.includes("linux-amd64:true")) {
    return { image, exists: true, linuxAmd64: true, method: "docker-registry-api-powershell" };
  }
  return { image, exists: false, linuxAmd64: false, method: "docker-registry-api-powershell", note: "fallback registry request failed" };
}

function parseDockerImage(image: string) {
  const [namePart, tag = "latest"] = image.split(":");
  const parts = namePart.split("/");
  const registry = parts.length > 2 && parts[0].includes(".") ? parts.shift() : "registry-1.docker.io";
  const repo = registry === "registry-1.docker.io" && parts.length === 1 ? `library/${parts[0]}` : parts.join("/");
  return { registry, repo, tag };
}

export async function verifyDockerImage(image: string): Promise<DockerImageVerification> {
  if (!image.startsWith("nvidia/cuda:")) {
    return {
      image,
      exists: false,
      linuxAmd64: false,
      method: "not-verified",
      note: "Only official nvidia/cuda image verification is implemented for this dry-run.",
    };
  }

  const { repo, tag } = parseDockerImage(image);
  try {
    const tokenResponse = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`);
    if (!tokenResponse.ok) {
      return { image, exists: false, linuxAmd64: false, method: "docker-registry-api", note: "token request failed" };
    }

    const tokenPayload = (await tokenResponse.json()) as { token?: string };
    const manifestResponse = await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, {
      headers: {
        Authorization: `Bearer ${tokenPayload.token ?? ""}`,
        Accept:
          "application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    if (!manifestResponse.ok) {
      return { image, exists: false, linuxAmd64: false, method: "docker-registry-api", note: `manifest request status ${manifestResponse.status}` };
    }

    const manifest = (await manifestResponse.json()) as { manifests?: Array<{ platform?: { os?: string; architecture?: string } }> };
    const linuxAmd64 = manifest.manifests?.some((entry) => entry.platform?.os === "linux" && entry.platform.architecture === "amd64") ?? true;
    return { image, exists: true, linuxAmd64, method: "docker-registry-api" };
  } catch {
    return verifyWithPowerShell(repo, tag, image);
  }
}
