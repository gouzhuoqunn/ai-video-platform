import { CloreProvider } from "./clore";
import { ManualSshProvider } from "./manual-ssh";
import { RunPodProvider } from "./runpod";
import type { GpuProvider, GpuProviderId } from "./types";

export function getGpuProvider(id: GpuProviderId): GpuProvider {
  if (id === "runpod") return new RunPodProvider();
  if (id === "manual_ssh") return new ManualSshProvider();
  return new CloreProvider();
}

export function parseProviderArg(argv = process.argv): GpuProviderId {
  const value = argv.find((item) => item.startsWith("--provider="))?.slice("--provider=".length) ?? "runpod";
  if (value !== "clore" && value !== "runpod" && value !== "manual_ssh") throw new Error("Use --provider=clore, --provider=runpod, or --provider=manual_ssh.");
  return value;
}

export type { GpuProvider, GpuProviderId, GpuTarget } from "./types";
