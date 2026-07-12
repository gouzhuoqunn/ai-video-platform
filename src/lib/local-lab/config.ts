import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const LOCAL_LAB_BALANCE = 1_000_000_000;
export const LOCAL_LAB_ROLE = "local_tester";
export const LOCAL_LAB_ENV_PATH = path.join(process.cwd(), ".secrets", "local-lab.env");

export type LocalLabCredentials = {
  userId: string;
  email: string;
  password: string;
};

export function isLocalLabBrowserMode() {
  return process.env.NEXT_PUBLIC_APP_MODE === "local_lab";
}

export function parseEnvContent(content: string) {
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

export function readLocalLabCredentials(): LocalLabCredentials {
  if (!existsSync(LOCAL_LAB_ENV_PATH)) {
    throw new Error("缺少 .secrets/local-lab.env。请先运行 npm run local-lab:setup。");
  }

  const values = parseEnvContent(readFileSync(LOCAL_LAB_ENV_PATH, "utf8"));
  const userId = values.get("LOCAL_LAB_USER_ID")?.trim();
  const email = values.get("LOCAL_LAB_EMAIL")?.trim();
  const password = values.get("LOCAL_LAB_PASSWORD")?.trim();

  if (!userId || !email || !password) {
    throw new Error(".secrets/local-lab.env 不完整。请重新运行 npm run local-lab:setup -- --reset。");
  }

  return { userId, email, password };
}
