import { createHash } from "node:crypto";

export type Rtx4090GoldenDeploymentProfile = {
  id: "rtx4090-golden-agent-v1";
  gpuClass: "rtx4090";
  supportedDimensions: { maxWidth: 1280; maxHeight: 1280 };
  image: "cloreai/jupyter:ubuntu24.04-v2";
  ports: { "8080": "http" };
  healthPath: "/healthz";
  controllerBind: "0.0.0.0:8080";
  immutable: { commit: string; agentSha256: string; controllerSha256: string; workflowSha256: string };
  bootstrapTemplateSha256: string;
};

const immutable = {
  // Immutable identities from the completed order 1982156 acceptance baseline.
  commit: "6b6d3be1d8e780fba658b0d777afd11d1b64858d",
  agentSha256: "5ca7af58319b048ad3d79836db251207ee72dd0e6ed91d756833969e6a55d4cd",
  controllerSha256: "96569eb5eee895f974d7b8304bb15f3b38e8f806115aae90f06bf0f8b927563e",
  workflowSha256: "e5b3e4cc7f347888f3231a82068d746740d5cb575905351ac4c7949d4b1cdd0d",
} as const;

function buildBootstrap(input: { commit: string; agentSha256: string; controllerSha256: string; workflowSha256: string; tokenSha256: string }) {
  const url = `https://raw.githubusercontent.com/gouzhuoqunn/ai-video-platform/${input.commit}/scripts/clore/diagnostic-agent.py`;
  return `python3 -c "import urllib.request as u,hashlib as h,os;p='/tmp/a.py';d=u.urlopen('${url}',timeout=30).read();assert h.sha256(d).hexdigest()=='${input.agentSha256}';open(p,'wb').write(d);os.execvp('python3',['python3',p,'--token-sha256','${input.tokenSha256}','--immutable','${input.commit}:${input.controllerSha256}:${input.workflowSha256}'])"`;
}

const templateTokenSha256 = "0".repeat(64);
export const RTX4090_GOLDEN_DEPLOYMENT_PROFILE: Rtx4090GoldenDeploymentProfile = {
  id: "rtx4090-golden-agent-v1",
  gpuClass: "rtx4090",
  supportedDimensions: { maxWidth: 1280, maxHeight: 1280 },
  image: "cloreai/jupyter:ubuntu24.04-v2",
  ports: { "8080": "http" },
  healthPath: "/healthz",
  controllerBind: "0.0.0.0:8080",
  immutable,
  bootstrapTemplateSha256: createHash("sha256").update(buildBootstrap({ ...immutable, tokenSha256: templateTokenSha256 })).digest("hex"),
};

export function buildRtx4090GoldenBootstrap(tokenSha256: string) {
  if (!/^[a-f0-9]{64}$/i.test(tokenSha256)) throw new Error("golden_deployment_token_hash_invalid");
  const command = buildBootstrap({ ...RTX4090_GOLDEN_DEPLOYMENT_PROFILE.immutable, tokenSha256 });
  if (Buffer.byteLength(command, "utf8") >= 700) throw new Error("golden_deployment_bootstrap_too_long");
  return command;
}

export function assertRtx4090GoldenDeploymentProfile(profile = RTX4090_GOLDEN_DEPLOYMENT_PROFILE) {
  if (profile.image !== "cloreai/jupyter:ubuntu24.04-v2" || profile.ports["8080"] !== "http" || profile.healthPath !== "/healthz" || profile.controllerBind !== "0.0.0.0:8080") {
    throw new Error("rtx4090_golden_deployment_profile_drift");
  }
  const expected = createHash("sha256").update(buildBootstrap({ ...profile.immutable, tokenSha256: templateTokenSha256 })).digest("hex");
  if (expected !== profile.bootstrapTemplateSha256) throw new Error("rtx4090_golden_bootstrap_hash_mismatch");
  return profile;
}
