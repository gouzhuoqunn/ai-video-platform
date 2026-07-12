import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const excludedPrefixes = [
  ".git/",
  ".next/",
  "node_modules/",
  ".secrets/",
  "public/mock-videos/",
  "coverage/",
  "test-results/",
  "playwright-report/",
];

const excludedFiles = new Set([".env.local", ".env", ".next-dev.log", ".next-dev.err.log"]);

const secretPatterns = [
  { name: "OpenAI style key", pattern: /sk-[A-Za-z0-9]{20,}/ },
  { name: "Hugging Face token", pattern: /hf_[A-Za-z0-9]{20,}/ },
  { name: "JWT token", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "Clore API key assignment", pattern: /CLORE_API_KEY\s*=\s*["']?[A-Za-z0-9_-]{16,}/ },
  { name: "Vast API key assignment", pattern: /VAST_API_KEY\s*=\s*["']?[A-Za-z0-9_-]{16,}/ },
  { name: "GPU worker password assignment outside placeholders", pattern: /GPU_WORKER_PASSWORD\s*=\s*["'](?!")(.{12,})["']/ },
];

function listFiles() {
  const result = spawnSync("git", ["ls-files", "--others", "--cached", "--exclude-standard"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }

  return result.stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => !excludedFiles.has(file))
    .filter((file) => !excludedPrefixes.some((prefix) => file.replaceAll("\\", "/").startsWith(prefix)));
}

function main() {
  const findings: string[] = [];

  for (const file of listFiles()) {
    const absolute = path.join(process.cwd(), file);
    let content = "";
    try {
      content = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }

    for (const { name, pattern } of secretPatterns) {
      if (pattern.test(content)) {
        findings.push(`${file}: ${name}`);
      }
    }
  }

  if (findings.length > 0) {
    throw new Error(`Secret scan failed:\n${findings.join("\n")}`);
  }

  console.log("Secret扫描通过：未在可提交文件中发现密钥形态内容。");
}

void main();
