"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { VIDEO_JOB_SELECT_FIELDS } from "@/lib/video-jobs/fields";
import { requestSignedVideoUrl } from "@/lib/video-jobs/signed-url";
import { videoJobStatusLabels, videoModels } from "@/types/video-config";
import type { SignedVideoResponse, VideoJob, VideoJobWithBalance } from "@/types/video-jobs";
import { LocalCreationStudio } from "@/components/LocalCreationStudio";

type SignedVideoState = SignedVideoResponse & {
  jobId: string;
};

type VideoErrorState = {
  jobId: string;
  message: string;
};

const starterPrompt = "一位穿银色外套的女孩站在雨夜霓虹街道中央，镜头缓慢推进，地面积水反射蓝绿色灯光，电影感，720P，5秒。";
const accountMessages = {
  recharge: "充值功能尚未开放。当前页面没有接入支付服务。",
};
const isLocalLabMode = process.env.NEXT_PUBLIC_APP_MODE === "local_lab";

function getFriendlyTaskMessage(message: string) {
  const firstLine = message.split("\n")[0] || message;

  if (firstLine.includes("提示词") || firstLine.includes("任务") || firstLine.includes("模型") || firstLine.includes("登录")) {
    return firstLine;
  }

  if (firstLine.toLowerCase().includes("failed to fetch")) {
    return "无法连接到 Supabase，请检查本地网络和 Supabase 项目配置。";
  }

  return "任务提交失败，请检查是否已执行 0002 数据库迁移，或稍后重试。";
}

function pickRpcJob(data: unknown): VideoJobWithBalance | null {
  if (Array.isArray(data)) {
    return (data[0] as VideoJobWithBalance | undefined) ?? null;
  }

  return (data as VideoJobWithBalance | null) ?? null;
}

export function StudioExperience() {
  return isLocalLabMode ? <LocalCreationStudio /> : <CommercialStudioExperience />;
}

function CommercialStudioExperience() {
  const supabaseConfig = useMemo(() => getSupabaseConfig(), []);
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [prompt, setPrompt] = useState(starterPrompt);
  const [selectedModel, setSelectedModel] = useState(videoModels[1]);
  const [notice, setNotice] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [accountMessage, setAccountMessage] = useState("登录后可以查看真实积分余额。");
  const [user, setUser] = useState<User | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [authLoading, setAuthLoading] = useState(supabaseConfig.isConfigured);
  const [lastJob, setLastJob] = useState<VideoJob | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [firstFrameName, setFirstFrameName] = useState("");
  const [firstFramePreviewUrl, setFirstFramePreviewUrl] = useState("");
  const [signedVideo, setSignedVideo] = useState<SignedVideoState | null>(null);
  const [videoError, setVideoError] = useState<VideoErrorState | null>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const firstFrameInputRef = useRef<HTMLInputElement>(null);
  const isPollingRef = useRef(false);
  const localLabLoginAttemptedRef = useRef(false);

  const canAddFirstFrame = !isLocalLabMode && selectedModel.supportsFirstFrame;

  const promptLength = useMemo(() => prompt.trim().length, [prompt]);

  const loadBalance = useCallback(async (currentUser: User | null) => {
    if (!supabase || !currentUser) {
      setBalance(null);
      return;
    }

    const { data, error } = await supabase
      .from("credit_accounts")
      .select("balance")
      .eq("user_id", currentUser.id)
      .maybeSingle();

    if (error) {
      setBalance(null);
      setAccountMessage("暂时无法读取积分。请确认已经在 Supabase 后台执行迁移 SQL。");
      return;
    }

    setBalance(data?.balance ?? null);
  }, [supabase]);

  const loadLatestJob = useCallback(async (currentUser: User | null) => {
    if (!supabase || !currentUser) {
      setLastJob(null);
      return;
    }

    const { data, error } = await supabase
      .from("video_jobs")
      .select(VIDEO_JOB_SELECT_FIELDS)
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      setLastJob(null);
      setNotice("暂时无法读取视频任务。请确认已经在 Supabase 后台执行 0002 迁移。");
      return;
    }

    setLastJob((data as VideoJob | null) ?? null);
  }, [supabase]);

  const loadJob = useCallback(async (jobId: string) => {
    if (!supabase) {
      return null;
    }

    const { data, error } = await supabase
      .from("video_jobs")
      .select(VIDEO_JOB_SELECT_FIELDS)
      .eq("id", jobId)
      .maybeSingle();

    if (error) {
      setNotice("暂时无法刷新任务状态。请确认已经在 Supabase 后台执行最新迁移。");
      return null;
    }

    const job = (data as VideoJob | null) ?? null;
    setLastJob(job);
    return job;
  }, [supabase]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (accountRef.current && !accountRef.current.contains(target)) {
        setAccountOpen(false);
      }

      if (modelRef.current && !modelRef.current.contains(target)) {
        setModelMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountOpen(false);
        setModelMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!supabase || !supabaseConfig.isConfigured) {
      return;
    }

    let isMounted = true;

    supabase.auth.getUser().then(({ data }) => {
      if (!isMounted) {
        return;
      }

      setUser(data.user);
      setAuthLoading(false);
      void loadBalance(data.user);
      void loadLatestJob(data.user);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      setAuthLoading(false);
      void loadBalance(currentUser);
      void loadLatestJob(currentUser);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [loadBalance, loadLatestJob, supabase, supabaseConfig.isConfigured]);

  const restoreLocalLabSession = useCallback(async () => {
    if (!isLocalLabMode || !supabase || !supabaseConfig.isConfigured) {
      return false;
    }

    try {
      const response = await fetch("/api/local-lab/session", { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        setNotice(payload.error ?? "本地实验账号自动登录失败。请先运行 npm run local-lab:setup。");
        return false;
      }

      const { data } = await supabase.auth.getUser();
      setUser(data.user);
      await Promise.all([loadBalance(data.user), loadLatestJob(data.user)]);
      setAccountMessage("本地实验会话已恢复。");
      return Boolean(data.user);
    } catch {
      setNotice("本地实验账号自动登录失败。请确认正在通过 http://127.0.0.1:3000 访问，并已运行 npm run local-lab:setup。");
      return false;
    }
  }, [loadBalance, loadLatestJob, supabase, supabaseConfig.isConfigured]);

  useEffect(() => {
    if (!isLocalLabMode || authLoading || user || localLabLoginAttemptedRef.current) {
      return;
    }

    localLabLoginAttemptedRef.current = true;
    setAccountMessage("正在恢复本地实验会话。");
    void restoreLocalLabSession();
  }, [authLoading, restoreLocalLabSession, user]);

  useEffect(() => {
    if (!lastJob || lastJob.status === "succeeded") {
      return;
    }

    if (lastJob.status !== "queued" && lastJob.status !== "processing") {
      return;
    }

    const interval = window.setInterval(() => {
      if (isPollingRef.current) {
        return;
      }

      isPollingRef.current = true;
      void loadJob(lastJob.id).finally(() => {
        isPollingRef.current = false;
      });
    }, 4000);

    return () => window.clearInterval(interval);
  }, [lastJob, loadJob]);

  useEffect(() => {
    let isCancelled = false;

    if (!lastJob || lastJob.status !== "succeeded" || !lastJob.output_video_path) {
      return;
    }

    void requestSignedVideoUrl(lastJob.id)
      .then((response) => {
        if (!isCancelled) {
          setSignedVideo({ ...response, jobId: lastJob.id });
        }
      })
      .catch((error) => {
        if (!isCancelled) {
          setSignedVideo(null);
          setVideoError({
            jobId: lastJob.id,
            message: error instanceof Error ? error.message : "获取视频临时链接失败。",
          });
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [lastJob]);

  function handleFirstFrameClick() {
    firstFrameInputRef.current?.click();
  }

  function handleFirstFrameChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (firstFramePreviewUrl) {
      URL.revokeObjectURL(firstFramePreviewUrl);
    }

    setFirstFrameName(file.name);
    setFirstFramePreviewUrl(URL.createObjectURL(file));
    setNotice("首帧图片仅在本地预览，不会上传。提交任务前请先移除图片。");
  }

  function clearFirstFrame() {
    if (firstFramePreviewUrl) {
      URL.revokeObjectURL(firstFramePreviewUrl);
    }

    setFirstFrameName("");
    setFirstFramePreviewUrl("");

    if (firstFrameInputRef.current) {
      firstFrameInputRef.current.value = "";
    }
  }

  async function handleSignOut() {
    if (!supabase) {
      setAccountMessage("Supabase 尚未配置，无法执行退出登录。");
      return;
    }

    await supabase.auth.signOut();
    setAccountMessage("已退出登录。");
    setAccountOpen(false);
  }

  async function handleGenerateClick() {
    if (isSubmitting) {
      return;
    }

    if (!user) {
      if (isLocalLabMode) {
        setNotice("正在恢复本地实验会话，请稍后再次提交。");
        await restoreLocalLabSession();
        return;
      }
      setNotice("请先登录或注册账号，再提交生成任务。真实GPU尚未接入，可用本地模拟Worker处理任务。");
      return;
    }

    if (!supabase) {
      setNotice("Supabase 尚未配置，暂时无法提交任务。");
      return;
    }

    if (!isLocalLabMode && (!selectedModel.available || selectedModel.key === "high-quality-video")) {
      setNotice("高质量视频模型仍然不可用。当前只允许轻量视频模型和标准视频模型。");
      return;
    }

    if (firstFramePreviewUrl) {
      setNotice("首帧上传将在后续版本开放。请先移除本地预览图片，再提交文字排队任务。");
      return;
    }

    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt) {
      setNotice("请先填写提示词。");
      return;
    }

    if (trimmedPrompt.length > 2000) {
      setNotice("提示词不能超过2000个字符。");
      return;
    }

    setIsSubmitting(true);
    setNotice("");

    try {
      const { data, error } = await supabase.rpc("create_video_job", {
        p_prompt: trimmedPrompt,
        p_model_key: selectedModel.key,
      });

      if (error) {
        setNotice(getFriendlyTaskMessage(error.message));
        return;
      }

      const createdJob = pickRpcJob(data);

      if (!createdJob) {
        setNotice("任务提交后没有收到任务编号，请刷新生成记录页面确认。");
        return;
      }

      setLastJob(createdJob);
      setSignedVideo(null);
      setVideoError(null);
      setBalance(createdJob.latest_balance);
      setNotice(
        isLocalLabMode
          ? `任务已创建，编号：${createdJob.id}。本地测试不限制次数；云端GPU尚未启动，配置Clore并启动Worker后，此任务将自动处理。`
          : `任务已创建，编号：${createdJob.id}。已扣除 ${createdJob.cost_credits} 积分，当前余额 ${createdJob.latest_balance}。正在排队。`,
      );
      await Promise.all([loadBalance(user), loadLatestJob(user)]);
    } catch (requestError) {
      setNotice(getFriendlyTaskMessage(requestError instanceof Error ? requestError.message : "Failed to fetch"));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDownloadLatestVideo() {
    if (!lastJob || lastJob.status !== "succeeded") {
      return;
    }

    try {
      const freshSignedVideo = await requestSignedVideoUrl(lastJob.id);
      setSignedVideo({ ...freshSignedVideo, jobId: lastJob.id });
      window.location.href = freshSignedVideo.signedUrl;
    } catch (error) {
      setVideoError({
        jobId: lastJob.id,
        message: error instanceof Error ? error.message : "获取视频临时链接失败。",
      });
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-black text-white">
      <section className="absolute inset-0">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute inset-[-4%] animate-[demo-pan_9s_ease-in-out_infinite] bg-[radial-gradient(circle_at_25%_25%,rgba(45,212,191,0.72),transparent_20%),radial-gradient(circle_at_68%_18%,rgba(244,63,94,0.45),transparent_22%),linear-gradient(125deg,#111827_0%,#082f49_38%,#3f1024_72%,#030712_100%)]" />
          <div className="absolute bottom-0 left-[12%] h-[58%] w-[26%] rounded-t-full bg-slate-950/55 blur-sm" />
          <div className="absolute bottom-[14%] left-[28%] h-[16%] w-[48%] rounded-full bg-cyan-300/25 blur-2xl" />
          <div className="absolute bottom-0 left-0 right-0 h-[45%] bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.72))]" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(0deg,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:72px_72px] opacity-25" />
          <div className="absolute left-0 right-0 h-24 animate-[demo-scan_4.8s_linear_infinite] bg-cyan-200/10 blur-md" />
        </div>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,rgba(0,0,0,0.2)_52%,rgba(0,0,0,0.76)_100%)]" />
      </section>

      <header className="relative z-20 flex items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" className="rounded-md bg-black/30 px-3 py-2 text-sm font-semibold backdrop-blur">
          {isLocalLabMode ? "本地AI生成实验台" : "AI视频生成平台"}
        </Link>

        <div className="relative flex items-center gap-2" ref={accountRef}>
          {isLocalLabMode ? (
            <div className="rounded-md border border-cyan-200/25 bg-cyan-300/12 px-3 py-2 text-xs font-semibold text-cyan-50 backdrop-blur">
              本地实验模式 · 积分：∞
            </div>
          ) : null}
          <button
            aria-expanded={accountOpen}
            aria-label="打开账户菜单"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-white/25 bg-white/15 font-bold shadow-lg backdrop-blur transition hover:bg-white/25"
            onClick={() => setAccountOpen((value) => !value)}
            type="button"
          >
            演
          </button>

          {accountOpen ? (
            <div className="fixed inset-x-3 bottom-3 rounded-lg border border-white/15 bg-zinc-950/95 p-3 text-sm shadow-2xl backdrop-blur sm:absolute sm:inset-auto sm:right-0 sm:mt-3 sm:w-80">
              {user ? (
                <>
                  <div className="rounded-md bg-white/8 p-3">
                    <p className="font-semibold">{isLocalLabMode ? "本地实验模式" : "已登录"}</p>
                    <p className="mt-1 break-all text-zinc-400">{isLocalLabMode ? "专用本地测试账号" : user.email}</p>
                    <p className="mt-3 text-zinc-400">当前积分</p>
                    <p className="mt-1 text-2xl font-bold">{isLocalLabMode ? "∞" : balance === null ? "读取中" : `${balance} 积分`}</p>
                  </div>
                  <div className="mt-3 grid gap-1">
                    {isLocalLabMode ? (
                      <>
                        <button
                          className="w-full rounded-md px-3 py-2 text-left hover:bg-white/10"
                          onClick={() => setAccountMessage("当前运行模式：local_lab。本页面只应通过 http://127.0.0.1:3000 访问。")}
                          type="button"
                        >
                          当前运行模式
                        </button>
                        <button
                          className="w-full rounded-md px-3 py-2 text-left hover:bg-white/10"
                          onClick={() => setAccountMessage("清空本地测试任务请在终端运行：npm run local-lab:reset:dry，确认后再运行 npm run local-lab:reset -- --execute。")}
                          type="button"
                        >
                          清空本地测试任务
                        </button>
                        <button
                          className="w-full rounded-md px-3 py-2 text-left hover:bg-white/10"
                          onClick={() => void restoreLocalLabSession()}
                          type="button"
                        >
                          恢复会话
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="w-full rounded-md px-3 py-2 text-left hover:bg-white/10"
                          onClick={() =>
                            setAccountMessage(
                              balance === null
                                ? "暂时没有读取到积分。请确认数据库迁移已经执行。"
                                : `当前剩余 ${balance} 积分。积分余额只允许读取，前端不能直接修改。`,
                            )
                          }
                          type="button"
                        >
                          我的积分
                        </button>
                        <button
                          className="w-full rounded-md px-3 py-2 text-left hover:bg-white/10"
                          onClick={() => setAccountMessage(accountMessages.recharge)}
                          type="button"
                        >
                          充值积分
                        </button>
                        <button
                          className="w-full rounded-md px-3 py-2 text-left hover:bg-white/10"
                          onClick={() =>
                            setAccountMessage(`当前邮箱：${user.email ?? "未知邮箱"}。暂未连接账户资料修改系统，不显示任何真实密码。`)
                          }
                          type="button"
                        >
                          账号与密码
                        </button>
                      </>
                    )}
                    <Link className="block rounded-md px-3 py-2 hover:bg-white/10" href="/history">
                      生成记录
                    </Link>
                    <button
                      className="w-full rounded-md px-3 py-2 text-left hover:bg-white/10"
                      onClick={handleSignOut}
                      type="button"
                    >
                      退出登录
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-md bg-white/8 p-3">
                    <p className="font-semibold">未登录</p>
                    <p className="mt-1 text-zinc-400">登录后查看账户信息</p>
                    <p className="mt-3 text-zinc-400">当前积分</p>
                    <p className="mt-1 text-2xl font-bold">登录后查看</p>
                  </div>
                  <div className="mt-3 grid gap-1">
                    <Link className="block rounded-md px-3 py-2 hover:bg-white/10" href="/login">
                      {isLocalLabMode ? "本地会话未就绪" : "登录/注册"}
                    </Link>
                  </div>
                </>
              )}
              <div className="rounded-md bg-white/8 p-3">
                <p className="text-xs leading-5 text-zinc-300">
                  {authLoading ? "正在检查登录状态..." : accountMessage}
                </p>
              </div>
              <p className="mt-2 border-t border-white/10 pt-3 text-xs leading-5 text-zinc-400">
                {isLocalLabMode
                  ? "本地实验模式不会显示或暴露测试账号密码。云端GPU尚未启动。"
                  : "账户认证使用 Supabase。充值、视频生成、GPU 和支付仍未接入。"}
              </p>
            </div>
          ) : null}
        </div>
      </header>

      <div className="relative z-10 flex min-h-[calc(100vh-76px)] flex-col justify-end px-4 pb-5 sm:px-6 sm:pb-7">
        <div className="mb-5 max-w-3xl">
          <div className="mb-3 flex w-fit items-center gap-2 rounded-full bg-black/35 px-3 py-1.5 text-sm backdrop-blur">
            <span className="h-2 w-2 animate-[demo-pulse_1.8s_ease-in-out_infinite] rounded-full bg-amber-300" />
            {isLocalLabMode ? "本地实验模式 · GPU尚未租用" : "真实GPU尚未接入，可用本地模拟Worker处理"}
          </div>
          <h1 className="text-3xl font-bold leading-tight sm:text-5xl">
            {isLocalLabMode ? "Wan2.2 文生视频本地实验台。" : "输入提示词，提交真实排队任务。"}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-200 sm:text-base">
            {isLocalLabMode
              ? "第一阶段只验证Wan2.2文生视频；文字生图和首帧生视频将在第一段真实视频成功后接入。云端GPU尚未启动，任务会先停留在排队中。"
              : "当前画面仍是前端动态演示，不是真实AI生成结果。提交后会真实扣除积分并进入队列，模拟Worker可将本地演示视频作为结果上传。"}
          </p>
        </div>

        <section className="w-full rounded-lg border border-white/18 bg-zinc-950/78 p-3 shadow-2xl backdrop-blur-xl sm:p-4">
          <div className="mb-3 grid gap-2 text-xs text-zinc-300 sm:grid-cols-4">
            <div className="rounded-md bg-white/8 px-3 py-2">{isLocalLabMode ? "本地测试，不限制次数" : `消耗：${selectedModel.creditCost}积分`}</div>
            <div className="rounded-md bg-white/8 px-3 py-2">{isLocalLabMode ? "模型：Wan2.2 TI2V-5B" : `预计：${selectedModel.estimatedTime}`}</div>
            <div className="rounded-md bg-white/8 px-3 py-2">{isLocalLabMode ? "分辨率：1280×704 · 24fps" : `分辨率：${selectedModel.resolution.toUpperCase()}`}</div>
            <div className="rounded-md bg-white/8 px-3 py-2">{isLocalLabMode ? "运行位置：Clore云端GPU" : "Worker：本地模拟"}</div>
          </div>
          <label className="sr-only" htmlFor="studio-prompt">
            当前展示视频的提示词
          </label>
          <textarea
            className="min-h-28 w-full resize-none rounded-md border border-white/10 bg-black/30 p-4 pb-16 text-base leading-7 text-white outline-none transition placeholder:text-zinc-500 focus:border-cyan-300"
            id="studio-prompt"
            onChange={(event) => {
              setPrompt(event.target.value);
              setNotice("");
            }}
            value={prompt}
          />

          <div className="-mt-14 flex flex-wrap items-end justify-between gap-3 px-2 pb-2">
            <div className="flex items-center gap-2">
              {canAddFirstFrame ? (
                <>
                  <input
                    accept="image/*"
                    className="hidden"
                    onChange={handleFirstFrameChange}
                    ref={firstFrameInputRef}
                    type="file"
                  />
                  <button
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-white/12 text-2xl leading-none transition hover:bg-white/22"
                    onClick={handleFirstFrameClick}
                    title="添加图像素材作为首帧"
                    type="button"
                  >
                    +
                  </button>
                </>
              ) : null}
              <span className="text-xs text-zinc-400">{promptLength} 字</span>
            </div>

            <div className="group relative" ref={modelRef}>
              <button
                className="rounded-full border border-white/18 bg-white/12 px-4 py-2 text-sm font-semibold transition hover:bg-white/22"
                onClick={() => {
                  if (!isLocalLabMode) {
                    setModelMenuOpen((value) => !value);
                  }
                }}
                type="button"
              >
                {isLocalLabMode ? "Wan2.2 TI2V-5B" : selectedModel.name}
              </button>
              {!isLocalLabMode ? <div
                className={`absolute bottom-12 right-0 w-[min(88vw,28rem)] rounded-lg border border-white/15 bg-zinc-950/95 p-2 shadow-2xl backdrop-blur transition group-hover:visible group-hover:opacity-100 ${
                  modelMenuOpen ? "visible opacity-100" : "invisible opacity-0"
                }`}
              >
                <p className="px-3 pb-2 pt-1 text-xs text-zinc-400">当前只创建排队任务，不连接GPU。高质量模型仍不可用。</p>
                {videoModels.map((model) => (
                  <button
                    className={`block w-full rounded-md p-3 text-left transition ${
                      model.available ? "hover:bg-white/10" : "cursor-not-allowed opacity-55"
                    }`}
                    disabled={!model.available}
                    key={model.key}
                    onClick={() => {
                      if (!model.available) {
                        return;
                      }
                      setSelectedModel(model);
                      setModelMenuOpen(false);
                      setNotice(
                        model.supportsFirstFrame
                          ? "当前模型支持添加首帧图片。"
                          : "当前模型不支持首帧图片，左下角入口已隐藏。",
                      );
                    }}
                    type="button"
                  >
                    <span className="flex items-center justify-between gap-3 text-sm font-semibold text-white">
                      {model.name}
                      {!model.available ? (
                        <span className="rounded-full bg-amber-300/15 px-2 py-1 text-xs text-amber-200">即将开放</span>
                      ) : null}
                    </span>
                    <span className="mt-2 grid gap-1 text-xs leading-5 text-zinc-400 sm:grid-cols-2">
                      <span>类型：{model.type}</span>
                      <span>消耗：{model.creditCost}积分</span>
                      <span>预计时长：{model.estimatedTime}</span>
                      <span>分辨率：{model.resolution.toUpperCase()}</span>
                      <span>视频时长：{model.durationSeconds}秒</span>
                      <span>首帧图片：{model.supportsFirstFrame ? "仅本地预览" : "不支持"}</span>
                    </span>
                  </button>
                ))}
              </div> : null}
            </div>
          </div>

          {firstFramePreviewUrl ? (
            <div className="mt-3 flex flex-col gap-3 rounded-md border border-amber-300/25 bg-amber-300/10 p-3 text-sm text-amber-50 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <Image
                  alt=""
                  className="h-14 w-20 rounded-md object-cover"
                  height={56}
                  src={firstFramePreviewUrl}
                  unoptimized
                  width={80}
                />
                <div className="min-w-0">
                  <p className="truncate font-semibold">{firstFrameName}</p>
                  <p className="mt-1 text-xs text-amber-100">首帧图片目前只做本地预览，不会上传，也不会写入数据库。</p>
                </div>
              </div>
              <button className="w-fit rounded-md bg-white/12 px-3 py-2 text-xs font-semibold hover:bg-white/20" onClick={clearFirstFrame} type="button">
                移除图片
              </button>
            </div>
          ) : null}

          <div className="mt-3 flex flex-col gap-3 border-t border-white/10 pt-3 text-sm text-zinc-300 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-2">
              <p>
                {notice ||
                  (isLocalLabMode
                    ? "云端GPU尚未启动。配置Clore并启动Worker后，此任务将自动处理。"
                    : "提交后会创建真实数据库任务并扣除积分；本地模拟Worker可推进进度、上传私有视频并完成任务。")}
              </p>
              {lastJob ? (
                <div className="rounded-md bg-white/8 p-3 text-xs leading-5 text-zinc-200">
                  <p className="font-semibold">最近任务：{lastJob.id}</p>
                  <p>
                    状态：{videoJobStatusLabels[lastJob.status]} · 模型：{isLocalLabMode ? "Wan2.2 TI2V-5B" : lastJob.model_key} · 时长：{lastJob.duration_seconds}秒 ·
                    分辨率：{isLocalLabMode ? "1280×704" : lastJob.resolution.toUpperCase()} · {isLocalLabMode ? "本地测试" : `消耗：${lastJob.cost_credits}积分`} · 进度：{lastJob.progress}%
                  </p>
                  {isLocalLabMode && lastJob.status === "queued" ? <p className="text-amber-100">云端GPU尚未启动。配置Clore并启动Worker后，此任务将自动处理。</p> : null}
                  {lastJob.status === "processing" ? <p className="text-cyan-100">生成中：{lastJob.progress}%</p> : null}
                  {lastJob.status === "failed" ? <p className="text-rose-100">生成失败：{lastJob.error_message ?? "积分已退还。"}</p> : null}
                  {lastJob.status === "canceled" ? <p className="text-amber-100">已取消，积分已退还。</p> : null}
                  {lastJob.status === "succeeded" ? <p className="text-emerald-100">已完成，可以播放或下载。</p> : null}
                </div>
              ) : null}
              {lastJob?.status === "succeeded" ? (
                <div className="rounded-md bg-black/35 p-3">
                  {signedVideo?.jobId === lastJob.id ? (
                    <div className="space-y-3">
                      <video className="max-h-72 w-full rounded-md bg-black" controls playsInline src={signedVideo.signedUrl} />
                      <button
                        className="inline-flex rounded-md bg-white/12 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20"
                        onClick={() => void handleDownloadLatestVideo()}
                        type="button"
                      >
                        下载视频
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-300">
                      {videoError?.jobId === lastJob.id ? videoError.message : "正在获取视频临时播放链接..."}
                    </p>
                  )}
                </div>
              ) : null}
            </div>
            <button
              className="rounded-md bg-cyan-300 px-5 py-3 font-bold text-zinc-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-zinc-500"
              disabled={isSubmitting}
              onClick={handleGenerateClick}
              type="button"
            >
              {isSubmitting ? "提交中..." : isLocalLabMode ? "提交Wan2.2任务" : "提交排队任务"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
