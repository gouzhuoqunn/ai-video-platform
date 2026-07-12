import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { LOCAL_LAB_BALANCE, LOCAL_LAB_ENV_PATH, LOCAL_LAB_ROLE, parseEnvContent } from "../src/lib/local-lab/config";
import { getSupabaseAdminClientCore } from "../src/lib/supabase/admin-core";
import { loadLocalEnv } from "./script-env";

loadLocalEnv();

const DEFAULT_EMAIL = "local-lab@ai-video-platform.local";

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function randomPassword() {
  return `${randomBytes(24).toString("base64url")}Aa1!`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertSecretsIgnored() {
  const gitignore = readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");
  assert(gitignore.includes(".secrets/"), ".secrets must be ignored.");
  assert(gitignore.includes(".secrets/local-lab.env"), ".secrets/local-lab.env must be ignored explicitly.");
}

async function readExistingCredentials() {
  if (!existsSync(LOCAL_LAB_ENV_PATH)) {
    return null;
  }

  return parseEnvContent(await readFile(LOCAL_LAB_ENV_PATH, "utf8"));
}

function publicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function findUserByEmail(email: string) {
  const admin = getSupabaseAdminClientCore();
  let page = 1;

  while (page <= 20) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      throw new Error(`Failed to list users: ${error.message}`);
    }

    const found = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (found) {
      return found;
    }

    if (data.users.length < 1000) {
      return null;
    }

    page += 1;
  }

  throw new Error("Too many users to safely locate the local lab account.");
}

async function writeCredentials(userId: string, email: string, password: string) {
  assertSecretsIgnored();
  await mkdir(path.dirname(LOCAL_LAB_ENV_PATH), { recursive: true });
  const content = [
    "# Local lab test account. Do not commit or share.",
    `LOCAL_LAB_USER_ID="${userId}"`,
    `LOCAL_LAB_EMAIL="${email}"`,
    `LOCAL_LAB_PASSWORD="${password}"`,
    "",
  ].join("\n");

  await writeFile(LOCAL_LAB_ENV_PATH, content, { flag: "wx", mode: 0o600 });
  try {
    await chmod(LOCAL_LAB_ENV_PATH, 0o600);
  } catch {
    // Best effort on Windows.
  }
}

async function verifyLogin(userId: string, email: string, password: string) {
  const client = publicClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    throw new Error(`Local lab login verification failed: ${error?.message ?? "missing user"}`);
  }
  assert(data.user.id === userId, "Local lab login returned a different user.");
  assert(data.user.app_metadata?.role === LOCAL_LAB_ROLE, "Local lab role must be stored in app_metadata.");
  await client.auth.signOut();
}

async function ensureRows(userId: string) {
  const admin = getSupabaseAdminClientCore();
  const { error: profileError } = await admin.from("profiles").upsert({ id: userId, display_name: "本地实验账号" });
  if (profileError) {
    throw new Error(`Failed to upsert local lab profile: ${profileError.message}`);
  }

  const { error: creditError } = await admin.from("credit_accounts").upsert({ user_id: userId, balance: LOCAL_LAB_BALANCE });
  if (creditError) {
    throw new Error(`Failed to set local lab balance: ${creditError.message}`);
  }

  const { data: profile } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
  const { data: account } = await admin.from("credit_accounts").select("balance").eq("user_id", userId).maybeSingle();
  assert(profile?.id === userId, "Local lab profile was not created.");
  assert(account?.balance === LOCAL_LAB_BALANCE, "Local lab balance was not set.");
}

async function verifyOrdinaryUserCannotForgeLocalTesterRole() {
  const client = publicClient();
  const email = `codex_local_lab_forge_${Date.now()}_${randomBytes(4).toString("hex")}@example.test`;
  const password = randomPassword();
  const admin = getSupabaseAdminClientCore();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role: LOCAL_LAB_ROLE },
  });

  if (error || !data.user) {
    throw new Error(`Could not create ordinary role-boundary test user: ${error?.message ?? "missing user"}`);
  }

  try {
    await client.auth.signInWithPassword({ email, password });
    await client.auth.updateUser({ data: { app_metadata: { role: LOCAL_LAB_ROLE }, role: LOCAL_LAB_ROLE } });
    const {
      data: { user },
    } = await client.auth.getUser();
    assert(user?.app_metadata?.role !== LOCAL_LAB_ROLE, "Ordinary users must not be able to self-assign local_tester app_metadata.");
  } finally {
    await client.auth.signOut().catch(() => undefined);
    await admin.from("credit_transactions").delete().eq("user_id", data.user.id);
    await admin.from("credit_accounts").delete().eq("user_id", data.user.id);
    await admin.from("profiles").delete().eq("id", data.user.id);
    await admin.auth.admin.deleteUser(data.user.id);
  }
}

async function main() {
  const reset = hasFlag("--reset");
  const existing = await readExistingCredentials();
  if (existing && !reset) {
    const userId = existing.get("LOCAL_LAB_USER_ID");
    const email = existing.get("LOCAL_LAB_EMAIL");
    const password = existing.get("LOCAL_LAB_PASSWORD");
    if (!userId || !email || !password) {
      throw new Error(".secrets/local-lab.env exists but is incomplete. Use --reset to replace it.");
    }
    await ensureRows(userId);
    await verifyLogin(userId, email, password);
    console.log("Local lab account already exists. Balance verified at 1000000000. Password was not printed.");
    return;
  }

  if (existing && reset) {
    await rm(LOCAL_LAB_ENV_PATH, { force: true });
  }

  const admin = getSupabaseAdminClientCore();
  const email = process.env.LOCAL_LAB_EMAIL?.trim() || DEFAULT_EMAIL;
  const password = randomPassword();
  const existingUser = await findUserByEmail(email);
  const userId = existingUser?.id;

  const finalUser =
    userId
      ? await admin.auth.admin.updateUserById(userId, {
          email,
          password,
          email_confirm: true,
          app_metadata: { role: LOCAL_LAB_ROLE },
          user_metadata: { purpose: "local_lab" },
        })
      : await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          app_metadata: { role: LOCAL_LAB_ROLE },
          user_metadata: { purpose: "local_lab" },
        });

  if (finalUser.error || !finalUser.data.user) {
    throw new Error(`Failed to create or update local lab account: ${finalUser.error?.message ?? "missing user"}`);
  }

  await ensureRows(finalUser.data.user.id);
  await writeCredentials(finalUser.data.user.id, email, password);
  await verifyLogin(finalUser.data.user.id, email, password);
  await verifyOrdinaryUserCannotForgeLocalTesterRole();
  console.log(`Local lab account ready at ${path.relative(process.cwd(), LOCAL_LAB_ENV_PATH)}. Password was written locally and not printed.`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "local lab setup failed");
  process.exitCode = 1;
});
