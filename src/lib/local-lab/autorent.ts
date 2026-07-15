import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { AUTOMATIC_GPU_PROVIDER } from "./studio-mode";

export type AutorentStatus = "waiting" | "searching" | "candidate_found" | "provisioning" | "assigned" | "failed" | "cancelled";

export const SESSION_COMPLETE_CANCEL_DEADLINE_MS = 60 * 1000;

const TRANSITIONS: Partial<Record<AutorentStatus, AutorentStatus>> = {
  waiting: "searching",
  searching: "candidate_found",
  candidate_found: "provisioning",
  provisioning: "assigned",
};

export function isRealAutorentEnabled() {
  return process.env.CLORE_AUTORENT_ENABLED === "true";
}

export async function listAutorentRequests(userId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("gpu_autorent_requests")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    throw new Error("Unable to read auto-rent requests.");
  }
  return data ?? [];
}

export async function advanceMockAutorentRequests(userId: string) {
  const admin = getSupabaseAdminClient();
  const requests = await listAutorentRequests(userId);
  const openRequests = requests.filter((request) => ["waiting", "searching", "candidate_found", "provisioning"].includes(String(request.status)));
  const updates = [];

  for (const request of openRequests) {
    const current = String(request.status) as AutorentStatus;
    const next = TRANSITIONS[current];
    if (!next) continue;

    const patch: Record<string, unknown> = {
      status: next,
      provider: AUTOMATIC_GPU_PROVIDER,
      real_create_enabled: false,
    };
    if (next === "candidate_found") {
      patch.selected_server_id = "mock-rtx5090-lowest-price";
    }
    if (next === "assigned") {
      patch.assigned_at = new Date().toISOString();
    }

    const { data, error } = await admin
      .from("gpu_autorent_requests")
      .update(patch)
      .eq("id", request.id)
      .eq("user_id", userId)
      .select("*")
      .single();
    if (error) {
      updates.push({ id: request.id, error: "mock autorent update failed" });
    } else {
      updates.push(data);
    }
  }

  return {
    real_clore_create_enabled: isRealAutorentEnabled(),
    create_order_called: false,
    session_complete_cancel_deadline_ms: SESSION_COMPLETE_CANCEL_DEADLINE_MS,
    note: isRealAutorentEnabled()
      ? "Clore自动调度已启用；此界面推进调度状态，但只有任务就绪且存在合规主机时才允许创建订单。"
      : "Clore自动调度当前处于安全暂停状态，只保留任务池和调度状态。",
    updates,
  };
}

export async function cancelAutorentRequest(userId: string, requestId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("gpu_autorent_requests")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("user_id", userId)
    .in("status", ["waiting", "searching", "candidate_found", "provisioning"])
    .select("*")
    .maybeSingle();
  if (error) {
    throw new Error("Unable to cancel auto-rent request.");
  }
  return data;
}
