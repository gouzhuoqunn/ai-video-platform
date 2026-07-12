import "server-only";

import { getSupabaseAdminClientCore } from "@/lib/supabase/admin-core";

export function getSupabaseAdminClient() {
  return getSupabaseAdminClientCore();
}
