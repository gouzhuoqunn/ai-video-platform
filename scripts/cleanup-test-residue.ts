import { getSupabaseAdminClientCore } from "../src/lib/supabase/admin-core";
import { loadLocalEnv } from "./script-env";

loadLocalEnv();

const TEST_EMAIL_PREFIXES = ["codex_it_", "codex_worker_once_", "codex_verify_", "codex_gpu_role_", "codex_worker_forge_"];
const TEST_PROMPT_PATTERNS = ["%[codex_it_%", "%[codex_worker_once_%", "%[codex_verify_%", "%[codex_gpu_role_%"];
const BUCKET = "generated-videos";

async function listTestUsers() {
  const admin = getSupabaseAdminClientCore();
  const users: Array<{ id: string; email?: string }> = [];
  let page = 1;

  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });

    if (error) {
      throw new Error(`读取测试用户失败：${error.message}`);
    }

    users.push(
      ...data.users
        .filter((user) => TEST_EMAIL_PREFIXES.some((prefix) => user.email?.startsWith(prefix)))
        .map((user) => ({ id: user.id, email: user.email })),
    );

    if (data.users.length < 100) {
      break;
    }

    page += 1;
  }

  return users;
}

async function removeUserStorage(userId: string) {
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.storage.from(BUCKET).list(userId);

  if (error || !data?.length) {
    return 0;
  }

  const paths = data.map((item) => `${userId}/${item.name}`);
  const { error: removeError } = await admin.storage.from(BUCKET).remove(paths);

  if (removeError) {
    throw new Error(`清理测试视频对象失败：${removeError.message}`);
  }

  return paths.length;
}

async function main() {
  const admin = getSupabaseAdminClientCore();
  const testUsers = await listTestUsers();
  const userIds = new Set(testUsers.map((user) => user.id));
  let removedObjects = 0;

  for (const pattern of TEST_PROMPT_PATTERNS) {
    const { data, error } = await admin.from("video_jobs").select("id,user_id,output_video_path").like("prompt", pattern);

    if (error) {
      throw new Error(`读取测试任务残留失败：${error.message}`);
    }

    for (const job of data ?? []) {
      userIds.add(job.user_id);
      if (job.output_video_path) {
        const { error: removeError } = await admin.storage.from(BUCKET).remove([job.output_video_path]);
        if (removeError) {
          throw new Error(`清理测试视频对象失败：${removeError.message}`);
        }
        removedObjects += 1;
      }
    }
  }

  const userIdList = [...userIds];

  if (userIdList.length > 0) {
    for (const userId of userIdList) {
      removedObjects += await removeUserStorage(userId);
    }

    await admin.from("credit_transactions").delete().in("user_id", userIdList);
    await admin.from("credit_accounts").delete().in("user_id", userIdList);
    await admin.from("profiles").delete().in("id", userIdList);
  }

  for (const pattern of TEST_PROMPT_PATTERNS) {
    await admin.from("video_jobs").delete().like("prompt", pattern);
  }

  for (const user of testUsers) {
    await admin.auth.admin.deleteUser(user.id);
  }

  const remainingUsers = await listTestUsers();
  let remainingJobs = 0;

  for (const pattern of TEST_PROMPT_PATTERNS) {
    const { count, error } = await admin.from("video_jobs").select("id", { count: "exact", head: true }).like("prompt", pattern);

    if (error) {
      throw new Error(`复查测试任务残留失败：${error.message}`);
    }

    remainingJobs += count ?? 0;
  }

  if (remainingUsers.length > 0 || remainingJobs > 0) {
    throw new Error("仍检测到测试残留，请检查清理权限。");
  }

  console.log(`测试残留检查通过：测试用户0个，测试任务0条，已清理测试视频对象${removedObjects}个。`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "测试残留检查失败。");
  process.exitCode = 1;
});
