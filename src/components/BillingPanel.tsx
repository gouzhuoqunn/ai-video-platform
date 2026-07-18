"use client";

import { useEffect, useState } from "react";

type Props = { onClose: () => void };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = { fetchedAt: string; clore: Record<string, any>; runpod: Record<string, any>; r2: Record<string, any>; supabase: Record<string, any>; github: Record<string, any>; modelSources: Record<string, any> };

const links = { clore: "https://clore.ai/", runpod: "https://www.console.runpod.io/user/billing", r2: "https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fbilling", r2Pricing: "https://developers.cloudflare.com/r2/pricing/", supabase: "https://supabase.com/dashboard/org/_/billing", github: "https://github.com/settings/billing" };

function money(value: unknown) { return typeof value === "number" ? `$${value.toFixed(3)}` : "未知"; }

export function BillingPanel({ onClose }: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");

  async function refresh() {
    setLoading(true); setNotice("");
    try { const response = await fetch("/api/local-lab/billing?refresh=1"); const payload = await response.json() as Data & { error?: string }; if (!response.ok) throw new Error(payload.error ?? "费用信息暂时不可用"); setData(payload); }
    catch (error) { setNotice(error instanceof Error ? error.message : "费用信息暂时不可用"); }
    finally { setLoading(false); }
  }

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void refresh();
    // The panel is intentionally lazy: no request is made while it is closed.
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  return <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-bold">费用情况</h2><p className="text-sm text-stone-500">账户状态与本项目支出分开显示；只在打开或手动刷新时请求。</p></div><div className="flex gap-2"><button className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold" disabled={loading} onClick={() => void refresh()} type="button">{loading ? "刷新中…" : "刷新"}</button><button className="rounded-md border border-stone-300 px-3 py-2 text-sm" onClick={onClose} type="button">返回工作台</button></div></div>
    {notice ? <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{notice}</p> : null}
    {!data && !loading ? <p className="mt-4 rounded-md bg-[#faf8f4] px-3 py-4 text-sm text-stone-600">点击“刷新”加载费用信息。</p> : null}
    {data ? <div className="mt-4 space-y-4"><p className="text-xs text-stone-500">上次刷新：{new Date(data.fetchedAt).toLocaleString("zh-CN")}</p><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <article className="rounded-md border border-stone-200 p-3"><h3 className="font-semibold">Clore</h3><p className="mt-2 text-sm">账户余额：{money(data.clore.available_usd_balance)}</p><p className="text-sm">账户状态：订单 {String(data.clore.activeOrderCount ?? "未知")} 个 · hold {String(data.clore.providerHold ?? "未知")}</p><p className="text-sm">当前项目支出：{money(data.clore.knownProjectSpendUsd)}</p><p className="text-sm">上次会话：{money(data.clore.lastSessionSpendUsd)}</p><a className="mt-2 inline-block text-sm text-emerald-700 underline" href={links.clore} rel="noreferrer" target="_blank">前往充值</a><p className="mt-1 text-xs text-stone-500">登录后进入 Account → Billing / Deposit</p></article>
      <article className="rounded-md border border-stone-200 p-3"><h3 className="font-semibold">RunPod</h3><p className="mt-2 text-sm">余额：{String(data.runpod.billing ?? "余额需登录查看")}</p><p className="text-sm">Pods：{String(data.runpod.activePods ?? "未知")} · Volumes：{String(data.runpod.activeVolumes ?? "未知")}</p><p className="text-sm">项目支出：{money(data.runpod.knownProjectSpendUsd)}</p><a className="mt-2 inline-block text-sm text-emerald-700 underline" href={links.runpod} rel="noreferrer" target="_blank">打开 RunPod Billing</a></article>
      <article className="rounded-md border border-stone-200 p-3"><h3 className="font-semibold">Cloudflare R2</h3><p className="mt-2 text-sm">连接：{String(data.r2.connected ? "已连接" : "未连接")}</p><p className="text-sm">对象：{String(data.r2.objectCount ?? "未知")} · 总量：{data.r2.totalBytes ? `${(data.r2.totalBytes / 1024 ** 3).toFixed(2)} GiB` : "未知"}</p><p className="text-sm">生产 / 历史：{data.r2.productionBytes ? `${(data.r2.productionBytes / 1024 ** 3).toFixed(2)} / ${(data.r2.legacyBytes / 1024 ** 3).toFixed(2)} GiB` : "未知"}</p><p className="text-sm">预计标准存储：{money(data.r2.estimatedMonthlyStorageUsd)} / 月</p><a className="mt-2 inline-block text-sm text-emerald-700 underline" href={links.r2} rel="noreferrer" target="_blank">打开 Cloudflare Billing</a> <a className="text-xs text-stone-500 underline" href={links.r2Pricing} rel="noreferrer" target="_blank">定价说明</a></article>
      <article className="rounded-md border border-stone-200 p-3"><h3 className="font-semibold">Supabase</h3><p className="mt-2 text-sm">项目连接：{String(data.supabase.connected ? "已配置" : "未配置")}</p><p className="text-sm">{String(data.supabase.billing)}</p><p className="text-sm">数据库/存储：{String(data.supabase.databaseHealth)}</p><a className="mt-2 inline-block text-sm text-emerald-700 underline" href={links.supabase} rel="noreferrer" target="_blank">打开 Supabase Billing</a></article>
      <article className="rounded-md border border-stone-200 p-3"><h3 className="font-semibold">GitHub Actions</h3><p className="mt-2 text-sm">最近缓存工作流：{String(data.github.workflow)}</p><p className="text-sm">{String(data.github.billing)}</p><a className="mt-2 inline-block text-sm text-emerald-700 underline" href={links.github} rel="noreferrer" target="_blank">打开 GitHub Billing</a></article>
    </div><div><h3 className="font-semibold">模型来源</h3><div className="mt-2 grid gap-2 sm:grid-cols-2 text-sm"><p className="rounded-md bg-[#faf8f4] p-2">Civitai：凭据 {String(data.modelSources.civitai.configured ? "已配置" : "未配置")} · 本项目不维护该平台余额</p><p className="rounded-md bg-[#faf8f4] p-2">Hugging Face：凭据 {String(data.modelSources.huggingFace.configured ? "已配置" : "未配置")} · 本项目不维护该平台余额</p></div></div></div> : null}
  </section>;
}
