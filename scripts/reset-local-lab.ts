import { getSupabaseAdminClientCore } from "../src/lib/supabase/admin-core";
import { LOCAL_LAB_BALANCE, LOCAL_LAB_ROLE, readLocalLabCredentials } from "../src/lib/local-lab/config";
import { GENERATED_VIDEOS_BUCKET } from "../src/lib/video-jobs/signed-url-policy";
import { loadLocalEnv } from "./script-env";

loadLocalEnv();

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function countRows(table: string, userIdColumn: string, userId: string) {
  const admin = getSupabaseAdminClientCore();
  const { count, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq(userIdColumn, userId);
  if (error) {
    throw new Error(`Failed to count ${table}: ${error.message}`);
  }
  return count ?? 0;
}

async function listGeneratedVideoPaths(userId: string) {
  const admin = getSupabaseAdminClientCore();
  const { data: jobFolders, error } = await admin.storage.from(GENERATED_VIDEOS_BUCKET).list(userId, { limit: 1000 });
  if (error) {
    throw new Error(`Failed to list generated videos: ${error.message}`);
  }

  const paths: string[] = [];
  for (const folder of jobFolders ?? []) {
    const folderPath = `${userId}/${folder.name}`;
    const { data: files, error: fileError } = await admin.storage.from(GENERATED_VIDEOS_BUCKET).list(folderPath, { limit: 1000 });
    if (fileError) {
      throw new Error(`Failed to list generated video folder ${folderPath}: ${fileError.message}`);
    }
    paths.push(...(files ?? []).map((file) => `${folderPath}/${file.name}`));
  }
  return paths;
}

async function main() {
  const execute = hasFlag("--execute");
  const credentials = readLocalLabCredentials();
  const admin = getSupabaseAdminClientCore();
  const { data: user, error: userError } = await admin.auth.admin.getUserById(credentials.userId);

  if (userError || !user.user) {
    throw new Error(`Local lab user not found: ${userError?.message ?? "missing user"}`);
  }
  assert(user.user.app_metadata?.role === LOCAL_LAB_ROLE, "Refusing to reset an account that is not app_metadata.role=local_tester.");

  const videoJobCount = await countRows("video_jobs", "user_id", credentials.userId);
  const transactionCount = await countRows("credit_transactions", "user_id", credentials.userId);
  const objectPaths = await listGeneratedVideoPaths(credentials.userId);

  console.log(
    JSON.stringify(
      {
        mode: execute ? "execute" : "dry-run",
        user_id: credentials.userId,
        video_jobs: videoJobCount,
        credit_transactions: transactionCount,
        generated_video_objects: objectPaths.length,
        balance_target: LOCAL_LAB_BALANCE,
      },
      null,
      2,
    ),
  );

  if (!execute) {
    console.log("Dry-run only. Pass --execute to reset local lab data.");
    return;
  }

  if (objectPaths.length > 0) {
    const { error } = await admin.storage.from(GENERATED_VIDEOS_BUCKET).remove(objectPaths);
    if (error) {
      throw new Error(`Failed to remove generated videos: ${error.message}`);
    }
  }

  await admin.from("video_jobs").delete().eq("user_id", credentials.userId);
  await admin.from("credit_transactions").delete().eq("user_id", credentials.userId);
  const { error: creditError } = await admin.from("credit_accounts").upsert({ user_id: credentials.userId, balance: LOCAL_LAB_BALANCE });
  if (creditError) {
    throw new Error(`Failed to reset local lab balance: ${creditError.message}`);
  }

  const remainingJobs = await countRows("video_jobs", "user_id", credentials.userId);
  const remainingTransactions = await countRows("credit_transactions", "user_id", credentials.userId);
  const remainingObjects = (await listGeneratedVideoPaths(credentials.userId)).length;
  const { data: account } = await admin.from("credit_accounts").select("balance").eq("user_id", credentials.userId).maybeSingle();

  console.log(
    JSON.stringify(
      {
        reset_complete: true,
        remaining_video_jobs: remainingJobs,
        remaining_credit_transactions: remainingTransactions,
        remaining_generated_video_objects: remainingObjects,
        balance: account?.balance,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "local lab reset failed");
  process.exitCode = 1;
});
