"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { getSupabaseConfig } from "@/lib/supabase/config";

type AuthMode = "sign-in" | "sign-up";

function getFriendlyAuthMessage(message: string) {
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("failed to fetch") || lowerMessage.includes("networkerror")) {
    return "无法连接到 Supabase 项目。请检查 .env.local 里的 Project URL 是否正确，并确认这个 Supabase 项目没有被删除或暂停。";
  }

  if (lowerMessage.includes("invalid login credentials")) {
    return "邮箱或密码不正确，请检查后重试。";
  }

  if (lowerMessage.includes("email not confirmed")) {
    return "邮箱还没有确认，请先打开邮箱完成确认。";
  }

  if (lowerMessage.includes("password")) {
    return "密码不符合要求，请使用更长或更安全的密码。";
  }

  if (lowerMessage.includes("email")) {
    return "邮箱格式或邮箱状态不正确，请检查后重试。";
  }

  return "认证请求失败，请稍后再试。";
}

export default function LoginPage() {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const supabaseConfig = useMemo(() => getSupabaseConfig(), []);
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");

    if (!supabaseConfig.isConfigured || !supabase) {
      setError(supabaseConfig.message ?? "Supabase 尚未配置。");
      return;
    }

    if (!email.trim() || !password) {
      setError("请填写邮箱和密码。");
      return;
    }

    setIsSubmitting(true);

    try {
      if (mode === "sign-up") {
        let signUpResult;

        try {
          signUpResult = await supabase.auth.signUp({
            email: email.trim(),
            password,
            options: {
              emailRedirectTo: `${window.location.origin}/auth/callback`,
            },
          });
        } catch (requestError) {
          setError(getFriendlyAuthMessage(requestError instanceof Error ? requestError.message : "Failed to fetch"));
          return;
        }

        const { data, error: signUpError } = signUpResult;

        if (signUpError) {
          setError(getFriendlyAuthMessage(signUpError.message));
          return;
        }

        if (data.user && !data.session) {
          setMessage("注册请求已提交。如果 Supabase 开启了邮箱确认，请检查邮箱并点击确认链接。");
          return;
        }

        setMessage("注册成功，已登录。");
        return;
      }

      let signInResult;

      try {
        signInResult = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
      } catch (requestError) {
        setError(getFriendlyAuthMessage(requestError instanceof Error ? requestError.message : "Failed to fetch"));
        return;
      }

      const { error: signInError } = signInResult;

      if (signInError) {
        setError(getFriendlyAuthMessage(signInError.message));
        return;
      }

      setMessage("登录成功，可以返回首页查看账户状态。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-8 text-white">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col justify-center">
        <Link className="mb-6 w-fit rounded-md bg-white/10 px-3 py-2 text-sm hover:bg-white/15" href="/">
          返回首页
        </Link>

        <section className="rounded-lg border border-white/15 bg-white/8 p-6 shadow-2xl backdrop-blur">
          <p className="text-sm font-semibold text-cyan-200">Supabase 账号认证</p>
          <h1 className="mt-3 text-3xl font-bold">{mode === "sign-in" ? "登录账号" : "注册账号"}</h1>
          <p className="mt-3 text-sm leading-6 text-zinc-300">
            当前只接入邮箱和密码认证。不会保存密码到 localStorage，不会把密码放进 URL，也不会输出密码或 Session。
          </p>

          {!supabaseConfig.isConfigured ? (
            <div className="mt-4 rounded-md border border-amber-300/25 bg-amber-300/10 p-3 text-sm leading-6 text-amber-100">
              {supabaseConfig.message}
            </div>
          ) : null}

          <div className="mt-6 grid grid-cols-2 gap-2 rounded-md bg-black/25 p-1">
            <button
              className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === "sign-in" ? "bg-cyan-300 text-zinc-950" : "text-zinc-300"}`}
              onClick={() => {
                setMode("sign-in");
                setError("");
                setMessage("");
              }}
              type="button"
            >
              登录
            </button>
            <button
              className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === "sign-up" ? "bg-cyan-300 text-zinc-950" : "text-zinc-300"}`}
              onClick={() => {
                setMode("sign-up");
                setError("");
                setMessage("");
              }}
              type="button"
            >
              注册
            </button>
          </div>

          <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="text-sm font-semibold" htmlFor="email">
                邮箱
              </label>
              <input
                autoComplete="email"
                className="mt-2 w-full rounded-md border border-white/15 bg-black/30 px-4 py-3 outline-none transition focus:border-cyan-300"
                id="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="demo@example.com"
                type="email"
                value={email}
              />
            </div>

            <div>
              <label className="text-sm font-semibold" htmlFor="password">
                密码
              </label>
              <div className="mt-2 flex rounded-md border border-white/15 bg-black/30 focus-within:border-cyan-300">
                <input
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                  className="min-w-0 flex-1 bg-transparent px-4 py-3 outline-none"
                  id="password"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="请输入密码"
                  type={showPassword ? "text" : "password"}
                  value={password}
                />
                <button
                  className="px-4 text-sm text-cyan-200 hover:text-cyan-100"
                  onClick={() => setShowPassword((value) => !value)}
                  type="button"
                >
                  {showPassword ? "隐藏" : "显示"}
                </button>
              </div>
            </div>

            {error ? <p className="rounded-md bg-rose-500/15 px-3 py-2 text-sm text-rose-100">{error}</p> : null}
            {message ? <p className="rounded-md bg-emerald-400/15 px-3 py-2 text-sm text-emerald-100">{message}</p> : null}

            <button
              className="w-full rounded-md bg-cyan-300 px-5 py-3 font-bold text-zinc-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-zinc-500"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? "处理中..." : mode === "sign-in" ? "登录" : "注册"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
