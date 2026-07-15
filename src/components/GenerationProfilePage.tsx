import Link from "next/link";
import type { GpuProfileKey } from "@/lib/generation/gpu-profiles";
import { getGenerationProfilePageData } from "@/lib/generation/profile-page-data";
import { listLocalImageResults } from "@/lib/local-lab/local-results";

type GenerationProfilePageProps = {
  profile: GpuProfileKey;
};

function formatGb(value: number) {
  return `${value}GB`;
}

export function GenerationProfilePage({ profile }: GenerationProfilePageProps) {
  const data = getGenerationProfilePageData(profile);
  const localImages = profile === "rtx4090" ? listLocalImageResults().slice(0, 4) : [];
  const allCandidates = [...data.imageCandidates, ...data.videoCandidates].sort(
    (left, right) => Number(right.benchmark_round === "first") - Number(left.benchmark_round === "first"),
  );

  return (
    <main className="min-h-screen bg-[#f5f0e8] text-stone-900">
      <header className="border-b border-stone-200 bg-[#f5f0e8]/95 px-5 py-4">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">metadata audit / pending benchmark</p>
            <h1 className="text-2xl font-bold">{data.gpu.displayName} generation profile</h1>
          </div>
          <nav className="flex flex-wrap gap-2 text-sm">
            <Link className="rounded-md border border-stone-200 bg-white px-3 py-2 font-semibold" href="/">
              Studio
            </Link>
            <Link className="rounded-md border border-stone-200 bg-white px-3 py-2 font-semibold" href="/generate/4090">
              RTX 4090
            </Link>
            <Link className="rounded-md border border-stone-200 bg-white px-3 py-2 font-semibold" href="/generate/5090">
              RTX 5090
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-5">
          <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold">Hardware gate</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border border-stone-200 bg-[#faf8f4] p-3">
                <p className="text-xs font-semibold uppercase text-stone-500">GPU</p>
                <p className="mt-1 font-bold">{data.gpu.exactGpuName}</p>
              </div>
              <div className="rounded-md border border-stone-200 bg-[#faf8f4] p-3">
                <p className="text-xs font-semibold uppercase text-stone-500">VRAM</p>
                <p className="mt-1 font-bold">at least {formatGb(data.gpu.minimumVramGb)}</p>
              </div>
              <div className="rounded-md border border-stone-200 bg-[#faf8f4] p-3">
                <p className="text-xs font-semibold uppercase text-stone-500">RAM</p>
                <p className="mt-1 font-bold">
                  {formatGb(data.gpu.hardMinimumRamGb)} hard / {formatGb(data.gpu.preferredRamGb)} preferred
                </p>
              </div>
              <div className="rounded-md border border-stone-200 bg-[#faf8f4] p-3">
                <p className="text-xs font-semibold uppercase text-stone-500">Disk</p>
                <p className="mt-1 font-bold">
                  {formatGb(data.gpu.hardMinimumDiskGb)} hard / {formatGb(data.gpu.preferredDiskGb)} preferred
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">Model candidates</h2>
                <p className="text-sm text-stone-500">Official first-round baseline is listed first. No model download, R2 upload, GPU benchmark, or production promotion happens here.</p>
              </div>
              <span className="rounded-md border border-stone-200 bg-[#faf8f4] px-3 py-2 text-sm font-semibold">{data.gpu.offloadPolicy} offload</span>
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {allCandidates.map((candidate) => (
                <article className="rounded-lg border border-stone-200 bg-[#faf8f4] p-4" key={candidate.key}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-bold">{candidate.display_name}</h3>
                    <span className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs font-semibold">{candidate.status}</span>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-stone-500">Task</dt>
                      <dd>{candidate.task_type}</dd>
                    </div>
                    <div>
                      <dt className="text-stone-500">Workflow</dt>
                      <dd>{candidate.workflow_key}</dd>
                    </div>
                    <div>
                      <dt className="text-stone-500">VRAM</dt>
                      <dd>{formatGb(candidate.minimum_vram)}</dd>
                    </div>
                    <div>
                      <dt className="text-stone-500">Stage</dt>
                      <dd>{candidate.benchmark_round === "first" ? "metadata audit" : "second round"}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs leading-5 text-stone-500">{candidate.license_note}</p>
                </article>
              ))}
            </div>
          </section>

          {profile === "rtx4090" ? (
            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold">Local first-image results</h2>
                <span className="text-sm text-stone-500">{localImages.length ? "completed" : "waiting"}</span>
              </div>
              {localImages.length ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {localImages.map((image) => (
                    <a className="block overflow-hidden rounded-md border border-stone-200 bg-[#faf8f4]" href={image.imageUrl} key={image.sessionId} target="_blank" rel="noreferrer">
                      <img className="aspect-square w-full object-cover" src={image.imageUrl} alt={`Generated image ${image.sessionId}`} />
                      <div className="p-3 text-sm">
                        <p className="font-semibold">{image.date}</p>
                        <p className="mt-1 break-all text-xs text-stone-500">{image.sessionId}</p>
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-stone-500">No local FLUX first-image result has been archived yet.</p>
              )}
            </section>
          ) : null}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-bold">Runtime</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Mode</dt>
                <dd className="font-semibold">{data.runtime.mode}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">ComfyUI bind</dt>
                <dd className="font-semibold">{data.runtime.bindHost}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Public ports</dt>
                <dd className="font-semibold">{data.runtime.publicPorts}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-stone-500">Planned sync</dt>
                <dd className="font-semibold">{data.plannedSyncGb}GB plus 20% disk reserve</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-bold">Benchmark status</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              The runner records startup, sync, load, cold generation, hot generation, resource peaks, output hash, error class, workflow version, model revision, GPU model, and driver. No result has been measured and no production profile is selected.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
