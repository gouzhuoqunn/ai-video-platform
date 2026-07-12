export type SupabaseConfigStatus = {
  isConfigured: boolean;
  url: string;
  publishableKey: string;
  message?: string;
};

export function getSupabaseConfig(): SupabaseConfigStatus {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const publishableKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

  if (!url || !publishableKey) {
    return {
      isConfigured: false,
      url,
      publishableKey,
      message: "缺少 Supabase 环境变量。请在 .env.local 中配置 NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY。",
    };
  }

  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname.endsWith(".supabase.co")) {
      return {
        isConfigured: false,
        url,
        publishableKey,
        message: "Supabase 项目地址格式不正确。请在 .env.local 中填写 Supabase 后台 API 页面里的 Project URL，例如 https://xxxx.supabase.co。",
      };
    }
  } catch {
    return {
      isConfigured: false,
      url,
      publishableKey,
      message: "Supabase 项目地址不是有效 URL。请检查 .env.local 中的 NEXT_PUBLIC_SUPABASE_URL。",
    };
  }

  return {
    isConfigured: true,
    url,
    publishableKey,
  };
}
