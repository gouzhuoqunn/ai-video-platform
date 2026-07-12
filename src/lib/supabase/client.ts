import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseConfig } from "@/lib/supabase/config";

export function createSupabaseBrowserClient() {
  const config = getSupabaseConfig();

  if (!config.isConfigured) {
    return null;
  }

  return createBrowserClient(config.url, config.publishableKey);
}
