import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "@/lib/supabase/config";

let cachedAdminClient: SupabaseClient | null = null;

export function getSupabaseAdminClientCore() {
  if (cachedAdminClient) {
    return cachedAdminClient;
  }

  const config = getSupabaseConfig();
  const secretKey = (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  if (!config.isConfigured) {
    throw new Error(config.message ?? "Supabase 尚未配置。");
  }

  if (!secretKey) {
    throw new Error("缺少服务器端 Supabase Secret key。请在 .env.local 中配置 SUPABASE_SECRET_KEY。");
  }

  cachedAdminClient = createClient(config.url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return cachedAdminClient;
}
