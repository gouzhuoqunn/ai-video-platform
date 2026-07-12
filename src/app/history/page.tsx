"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { PageShell } from "@/components/PageShell";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { VIDEO_JOB_SELECT_FIELDS } from "@/lib/video-jobs/fields";
import { requestSignedVideoUrl } from "@/lib/video-jobs/signed-url";
import { videoJobStatusLabels, videoModelLabels } from "@/types/video-config";
import type { SignedVideoResponse, VideoJob } from "@/types/video-jobs";

const statusStyles = {
  queued: "bg-amber-50 text-amber-800",
  processing: "bg-sky-50 text-sky-800",
  succeeded: "bg-teal-50 text-teal-800",
  failed: "bg-rose-50 text-rose-800",
  canceled: "bg-stone-100 text-stone-700",
};
const isLocalLabMode = process.env.NEXT_PUBLIC_APP_MODE === "local_lab";

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function getFriendlyTaskMessage(message: string) {
  const firstLine = message.split("\n")[0] || message;

  if (firstLine.includes("任务") || firstLine.includes("登录") || firstLine.includes("取消")) {
    return firstLine;
  }

  if (firstLine.toLowerCase().includes("failed to fetch")) {
    return "无法连接到 Supabase，请检查本地网络和 Supabase 项目配置。";
  }

  return "操作失败，请确认已经执行 0002 数据库迁移，或稍后重试。";
}

export default function HistoryPage() {
  const [supabase] = useState(() => createSupabaseBrowserClient());
  const [user, setUser] = useState<User | null>(null);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [isLoading, setIsLoading] = useState(() => Boolean(supabase));
  const [notice, setNotice] = useState(() => (supabase ? "" : "Supabase 尚未配置，无法读取生成记录。"));
  const [cancelingJobId, setCancelingJobId] = useState("");
  const [signedVideos, setSignedVideos] = useState<Record<string, SignedVideoResponse>>({});
  const [videoErrors, setVideoErrors] = useState<Record<string, string>>({});

  const loadJobs = useCallback(async (currentUser: User | null) => {
    if (!supabase || !currentUser) {
      setJobs([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    const { data, error } = await supabase
      .from("video_jobs")
      .select(VIDEO_JOB_SELECT_FIELDS)
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false });

    if (error) {
      setJobs([]);
      setNotice("暂时无法读取生成记录。请确认已经在 Supabase 后台执行 0002 迁移。");
      setIsLoading(false);
      return;
    }

    setJobs((data as VideoJob[] | null) ?? []);
    setIsLoading(false);
  }, [supabase]);

  const hasActiveJobs = jobs.some((job) => job.status === "queued" || job.status === "processing");

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let isMounted = true;

    supabase.auth.getUser().then(({ data }) => {
      if (!isMounted) {
        return;
      }

      setUser(data.user);
      void loadJobs(data.user);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      void loadJobs(currentUser);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [loadJobs, supabase]);

  useEffect(() => {
    if (!user || !hasActiveJobs) {
      return;
    }

    const interval = window.setInterval(() => {
      void loadJobs(user);
    }, 5000);

    return () => window.clearInterval(interval);
  }, [hasActiveJobs, loadJobs, user]);

  useEffect(() => {
    let isCancelled = false;

    async function loadSignedVideos() {
      const succeededJobs = jobs.filter((job) => job.status === "succeeded" && job.output_video_path && !signedVideos[job.id]);

      await Promise.all(
        succeededJobs.map(async (job) => {
          try {
            const signedVideo = await requestSignedVideoUrl(job.id);

            if (!isCancelled) {
              setSignedVideos((current) => ({ ...current, [job.id]: signedVideo }));
            }
          } catch (error) {
            if (!isCancelled) {
              setVideoErrors((current) => ({
                ...current,
                [job.id]: error instanceof Error ? error.message : "获取视频临时链接失败。",
              }));
            }
          }
        }),
      );
    }

    void loadSignedVideos();

    return () => {
      isCancelled = true;
    };
  }, [jobs, signedVideos]);

  async function handleCancelJob(jobId: string) {
    if (!supabase || !user || cancelingJobId) {
      return;
    }

    setCancelingJobId(jobId);
    setNotice("");

    try {
      const { error } = await supabase.rpc("cancel_video_job", {
        p_job_id: jobId,
      });

      if (error) {
        setNotice(getFriendlyTaskMessage(error.message));
        return;
      }

      setNotice("任务已取消，已退还积分。");
      await loadJobs(user);
    } catch (requestError) {
      setNotice(getFriendlyTaskMessage(requestError instanceof Error ? requestError.message : "Failed to fetch"));
    } finally {
      setCancelingJobId("");
    }
  }

  async function handleDownloadJob(jobId: string) {
    try {
      const signedVideo = await requestSignedVideoUrl(jobId);
      setSignedVideos((current) => ({ ...current, [jobId]: signedVideo }));
      window.location.href = signedVideo.signedUrl;
    } catch (error) {
      setVideoErrors((current) => ({
        ...current,
        [jobId]: error instanceof Error ? error.message : "获取视频临时链接失败。",
      }));
    }
  }

  return (
    <PageShell>
      <div className="mb-8">
        <Link className="mb-5 inline-flex rounded-md bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-200" href="/">
          返回首页
        </Link>
        <p className="text-sm font-semibold text-teal-700">生成记录页</p>
        <h1 className="mt-3 text-3xl font-bold text-stone-950 sm:text-4xl">
          {isLocalLabMode ? "本地实验任务历史" : "真实视频任务记录"}
        </h1>
        <p className="mt-3 max-w-3xl text-stone-700">
          {isLocalLabMode
            ? "这里读取专用本地测试账号的 Supabase 任务记录。云端GPU尚未启动时，任务会停留在排队中。"
            : "这里读取当前登录用户自己的 Supabase 任务记录。本阶段使用本地模拟Worker推进进度，真实GPU尚未接入。"}
        </p>
      </div>

      {notice ? <p className="mb-4 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900">{notice}</p> : null}

      {!user && !isLoading ? (
        <section className="rounded-lg border border-stone-200 bg-white p-6 text-stone-700 shadow-sm">
          <h2 className="text-lg font-bold text-stone-950">请先登录</h2>
          <p className="mt-2">{isLocalLabMode ? "请回到首页恢复本地实验会话。" : "未登录用户不能读取或提交视频任务。"}</p>
          <Link className="mt-4 inline-flex rounded-md bg-teal-600 px-4 py-3 text-sm font-bold text-white hover:bg-teal-700" href={isLocalLabMode ? "/" : "/login"}>
            {isLocalLabMode ? "返回本地实验台" : "登录/注册"}
          </Link>
        </section>
      ) : null}

      {user && isLoading ? (
        <section className="rounded-lg border border-stone-200 bg-white p-6 text-stone-700 shadow-sm">正在读取生成记录...</section>
      ) : null}

      {user && !isLoading && jobs.length === 0 ? (
        <section className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-stone-700">
          <h2 className="text-lg font-bold text-stone-950">暂无任务</h2>
          <p className="mt-2">回到首页输入提示词并提交后，这里会显示真实排队任务。</p>
        </section>
      ) : null}

      {user && jobs.length > 0 ? (
        <section className="grid gap-4">
          {jobs.map((job) => (
            <article className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm" key={job.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm text-stone-500">提示词</p>
                  <h2 className="mt-1 font-semibold leading-7 text-stone-950">{job.prompt}</h2>
                  <p className="mt-2 break-all text-xs text-stone-400">任务编号：{job.id}</p>
                </div>
                <span className={`w-fit rounded-full px-3 py-1 text-sm font-semibold ${statusStyles[job.status]}`}>
                  {videoJobStatusLabels[job.status]}
                </span>
              </div>
              <div className="mt-4 grid gap-3 text-sm text-stone-700 sm:grid-cols-2 lg:grid-cols-3">
                <p>模型：{videoModelLabels[job.model_key]}</p>
                <p>时长：{job.duration_seconds}秒</p>
                <p>分辨率：{isLocalLabMode && job.model_key === "standard-video" ? "1280×704" : job.resolution.toUpperCase()}</p>
                <p>进度：{job.progress}%</p>
                <p>创建时间：{formatDateTime(job.created_at)}</p>
                <p>完成时间：{job.completed_at ? formatDateTime(job.completed_at) : "未完成"}</p>
                <p>{isLocalLabMode ? "积分：本地测试" : `积分消耗：${job.cost_credits}积分`}</p>
                <p>{isLocalLabMode ? "次数：不限制" : `退款状态：${job.refunded_at ? "已退款" : job.status === "failed" || job.status === "canceled" ? "等待确认" : "未退款"}`}</p>
              </div>
              {isLocalLabMode && job.status === "queued" ? (
                <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  云端GPU尚未启动。配置Clore并启动Worker后，此任务将自动处理。
                </p>
              ) : null}
              {job.status === "failed" ? (
                <p className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
                  失败原因：{job.error_message ?? "任务处理失败。"} 积分已按规则退还。
                </p>
              ) : null}
              {job.status === "succeeded" ? (
                <div className="mt-4 rounded-md bg-stone-50 p-3">
                  {signedVideos[job.id] ? (
                    <div className="space-y-3">
                      <video className="max-h-80 w-full rounded-md bg-black" controls playsInline src={signedVideos[job.id].signedUrl} />
                      <button
                        className="inline-flex rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
                        onClick={() => void handleDownloadJob(job.id)}
                        type="button"
                      >
                        下载视频
                      </button>
                    </div>
                  ) : (
                    <p className="text-sm text-stone-600">{videoErrors[job.id] || "正在获取视频临时播放链接..."}</p>
                  )}
                </div>
              ) : null}
              {job.status === "queued" ? (
                <div className="mt-4 border-t border-stone-100 pt-4">
                  <button
                    className="rounded-md border border-stone-300 bg-stone-50 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
                    disabled={cancelingJobId === job.id}
                    onClick={() => void handleCancelJob(job.id)}
                    type="button"
                  >
                    {cancelingJobId === job.id ? "取消中..." : "取消任务"}
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
    </PageShell>
  );
}
