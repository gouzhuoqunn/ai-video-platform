import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClientCore } from "../src/lib/supabase/admin-core";
import { loadLocalEnv } from "./script-env";

loadLocalEnv();

const SECRETS_DIR = path.join(process.cwd(), ".secrets");
const WORKER_ENV_PATH = path.join(SECRETS_DIR, "gpu-worker.env");
const DEFAULT_EMAIL = "gpu-worker@ai-video-platform.local";

type Command = "create" | "rotate" | "delete";

function getCommand(): Command {
  const command = process.argv[2] as Command | undefined;

  if (command === "create" || command === "rotate" || command === "delete") {
    return command;
  }

  throw new Error("Usage: tsx scripts/manage-gpu-worker-account.ts create|rotate|delete");
}

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

function parseEnvFile(content: string) {
  const values = new Map<string, string>();

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("=");

    if (!trimmed || trimmed.startsWith("#") || separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    values.set(key, value);
  }

  return values;
}

function parseJwtPayload(token: string) {
  const payload = token.split(".")[1];
  assert(payload, "Worker login did not return a valid JWT payload.");

  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const json = Buffer.from(normalized, "base64").toString("utf8");
  return JSON.parse(json) as { app_metadata?: { role?: string } };
}

function assertSecretsIgnored() {
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  assert(existsSync(gitignorePath), ".gitignore is missing.");

  const gitignore = readFileSync(gitignorePath, "utf8");
  assert(
    gitignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === ".secrets/" || line === "/.secrets/"),
    ".secrets must be ignored by Git before writing Worker credentials.",
  );
}

async function readExistingCredentials() {
  if (!existsSync(WORKER_ENV_PATH)) {
    return null;
  }

  return parseEnvFile(await readFile(WORKER_ENV_PATH, "utf8"));
}

async function writeCredentials(userId: string, email: string, password: string) {
  assertSecretsIgnored();
  await mkdir(SECRETS_DIR, { recursive: true });

  const config = [
    "# Local GPU worker credentials. Do not commit or share.",
    `SUPABASE_URL="${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}"`,
    `SUPABASE_PUBLISHABLE_KEY="${process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ""}"`,
    `GPU_WORKER_USER_ID="${userId}"`,
    `GPU_WORKER_EMAIL="${email}"`,
    `GPU_WORKER_PASSWORD="${password}"`,
    "",
  ].join("\n");

  await writeFile(WORKER_ENV_PATH, config, { flag: "wx", mode: 0o600 });

  try {
    await chmod(WORKER_ENV_PATH, 0o600);
  } catch {
    // Best effort on platforms that do not support chmod semantics.
  }
}

async function verifyWorkerLogin(userId: string, email: string, password: string) {
  const client = publicClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });

  if (error || !data.user || !data.session) {
    throw new Error(`Worker account was created but login verification failed: ${error?.message ?? "missing session"}`);
  }

  assert(data.user.id === userId, "Worker login returned a different user id.");
  assert(data.user.app_metadata?.role === "gpu_worker", "Worker user app_metadata.role must be gpu_worker.");

  const payload = parseJwtPayload(data.session.access_token);
  assert(payload.app_metadata?.role === "gpu_worker", "Worker JWT must contain app_metadata.role=gpu_worker.");

  await client.auth.signOut();
}

async function verifyOrdinaryUserCannotForgeRole() {
  const admin = getSupabaseAdminClientCore();
  const email = `codex_worker_forge_${Date.now()}_${randomBytes(4).toString("hex")}@example.test`;
  const password = randomPassword();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { purpose: "forge_role_boundary_test" },
  });

  if (error || !data.user) {
    throw new Error(`Could not create temporary ordinary user for role boundary verification: ${error?.message ?? "no user"}`);
  }

  const userId = data.user.id;
  const client: SupabaseClient = publicClient();

  try {
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) {
      throw new Error(`Temporary ordinary user login failed: ${signInError.message}`);
    }

    await client.auth.updateUser({
      data: {
        app_metadata: { role: "gpu_worker" },
        raw_app_meta_data: { role: "gpu_worker" },
        role: "gpu_worker",
      },
    });

    const {
      data: { user },
      error: getUserError,
    } = await client.auth.getUser();
    if (getUserError || !user) {
      throw new Error(`Reading temporary ordinary user failed: ${getUserError?.message ?? "no user"}`);
    }

    assert(user.app_metadata?.role !== "gpu_worker", "Ordinary users must not be able to set app_metadata.role.");

    const { error: rpcError } = await client.rpc("heartbeat_video_job", {
      p_job_id: "00000000-0000-4000-8000-000000000000",
      p_worker_id: "ordinary-forge-test",
      p_progress: 10,
      p_lease_seconds: 30,
    });
    assert(rpcError, "Ordinary users must not gain Worker RPC access by editing user_metadata.");
  } finally {
    await client.auth.signOut().catch(() => undefined);
    await admin.from("credit_transactions").delete().eq("user_id", userId);
    await admin.from("credit_accounts").delete().eq("user_id", userId);
    await admin.from("profiles").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId);
  }
}

async function createAccount() {
  const overwrite = hasFlag("--overwrite");
  const existing = await readExistingCredentials();

  if (existing && !overwrite) {
    throw new Error(".secrets/gpu-worker.env already exists. Use rotate instead of overwriting credentials.");
  }

  if (existing && overwrite) {
    const existingUserId = existing.get("GPU_WORKER_USER_ID");
    if (existingUserId) {
      await getSupabaseAdminClientCore().auth.admin.deleteUser(existingUserId);
    }
    await rm(WORKER_ENV_PATH, { force: true });
  }

  const admin = getSupabaseAdminClientCore();
  const email = process.env.GPU_WORKER_EMAIL?.trim() || DEFAULT_EMAIL;
  const password = randomPassword();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "gpu_worker" },
    user_metadata: { purpose: "gpu_worker" },
  });

  if (error || !data.user) {
    throw new Error(`Failed to create GPU worker account: ${error?.message ?? "no user returned"}`);
  }

  await writeCredentials(data.user.id, email, password);
  await verifyWorkerLogin(data.user.id, email, password);
  await verifyOrdinaryUserCannotForgeRole();
  console.log(`GPU worker account created. Credentials were written to ${path.relative(process.cwd(), WORKER_ENV_PATH)}.`);
}

async function rotateAccount() {
  const existing = await readExistingCredentials();

  if (!existing) {
    throw new Error("No existing .secrets/gpu-worker.env found. Run create first.");
  }

  const userId = existing.get("GPU_WORKER_USER_ID");
  const email = existing.get("GPU_WORKER_EMAIL") || DEFAULT_EMAIL;
  const password = randomPassword();

  if (!userId) {
    throw new Error("Existing GPU worker credentials are missing GPU_WORKER_USER_ID.");
  }

  const admin = getSupabaseAdminClientCore();
  const { error } = await admin.auth.admin.updateUserById(userId, {
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "gpu_worker" },
    user_metadata: { purpose: "gpu_worker" },
  });

  if (error) {
    throw new Error(`Failed to rotate GPU worker account: ${error.message}`);
  }

  await rm(WORKER_ENV_PATH, { force: true });
  await writeCredentials(userId, email, password);
  await verifyWorkerLogin(userId, email, password);
  await verifyOrdinaryUserCannotForgeRole();
  console.log(`GPU worker password rotated. New credentials were written to ${path.relative(process.cwd(), WORKER_ENV_PATH)}.`);
}

async function deleteAccount() {
  const existing = await readExistingCredentials();

  if (!existing) {
    throw new Error("No existing .secrets/gpu-worker.env found; refusing to delete an unknown account.");
  }

  const userId = existing.get("GPU_WORKER_USER_ID");

  if (!userId) {
    throw new Error("Existing GPU worker credentials are missing GPU_WORKER_USER_ID.");
  }

  const admin = getSupabaseAdminClientCore();
  const { error } = await admin.auth.admin.deleteUser(userId);

  if (error) {
    throw new Error(`Failed to delete GPU worker account: ${error.message}`);
  }

  await rm(WORKER_ENV_PATH, { force: true });
  console.log("GPU worker account deleted and local credential file removed.");
}

async function main() {
  const command = getCommand();

  if (command === "create") {
    await createAccount();
  } else if (command === "rotate") {
    await rotateAccount();
  } else {
    await deleteAccount();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "GPU worker account command failed.");
  process.exitCode = 1;
});
