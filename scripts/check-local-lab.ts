import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { LOCAL_LAB_BALANCE, LOCAL_LAB_ROLE, readLocalLabCredentials } from "../src/lib/local-lab/config";
import { GENERATED_VIDEOS_BUCKET } from "../src/lib/video-jobs/signed-url-policy";
import { getSupabaseAdminClientCore } from "../src/lib/supabase/admin-core";
import { loadLocalEnv } from "./script-env";

loadLocalEnv();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function publicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function main() {
  const credentials = readLocalLabCredentials();
  const admin = getSupabaseAdminClientCore();
  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(credentials.userId);
  if (authError || !authUser.user) {
    throw new Error(`Local lab auth user missing: ${authError?.message ?? "missing user"}`);
  }
  assert(authUser.user.app_metadata?.role === LOCAL_LAB_ROLE, "Local lab role must be in app_metadata.");

  const { data: account, error: accountError } = await admin.from("credit_accounts").select("balance").eq("user_id", credentials.userId).maybeSingle();
  if (accountError) {
    throw new Error(`credit_accounts check failed: ${accountError.message}`);
  }
  assert((account?.balance ?? 0) >= LOCAL_LAB_BALANCE - 1000, "Local lab balance is too low.");

  const { data: profile } = await admin.from("profiles").select("id").eq("id", credentials.userId).maybeSingle();
  assert(profile?.id === credentials.userId, "Local lab profile is missing.");

  const { error: jobsError } = await admin.from("video_jobs").select("id").eq("user_id", credentials.userId).limit(1);
  if (jobsError) {
    throw new Error(`video_jobs structure check failed: ${jobsError.message}`);
  }

  const { data: bucket, error: bucketError } = await admin.storage.getBucket(GENERATED_VIDEOS_BUCKET);
  if (bucketError) {
    throw new Error(`generated-videos bucket check failed: ${bucketError.message}`);
  }
  assert(bucket.public === false, "generated-videos bucket must remain private.");

  if (existsSync(path.join(process.cwd(), ".secrets", "gpu-worker.env"))) {
    const workerEnv = readFileSync(path.join(process.cwd(), ".secrets", "gpu-worker.env"), "utf8");
    assert(workerEnv.includes("GPU_WORKER_USER_ID="), "gpu_worker credential file exists but is incomplete.");
  }

  const client = publicClient();
  const { data: session, error: loginError } = await client.auth.signInWithPassword({ email: credentials.email, password: credentials.password });
  if (loginError || !session.user) {
    throw new Error(`Local lab cookie/login source check failed: ${loginError?.message ?? "missing user"}`);
  }
  assert(session.user.id === credentials.userId, "Local lab login returned wrong user.");
  await client.auth.signOut();

  console.log("Local lab检查通过：账号、余额、Supabase连接、video_jobs、私有Storage和本地登录凭据可用。未调用Clore API，未创建GPU订单。");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "local lab check failed");
  process.exitCode = 1;
});
