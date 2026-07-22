import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ffmpeg = require("@ffmpeg-installer/ffmpeg") as { path: string };
const ffprobe = require("@ffprobe-installer/ffprobe") as { path: string };

const OUTPUT_PATH = path.join(process.cwd(), "public", "mock-videos", "demo.mp4");

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

async function probeVideo(filePath: string) {
  const output = await run(ffprobe.path, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height,pix_fmt,r_frame_rate:format=duration",
    "-of",
    "json",
    filePath,
  ]);

  const parsed = JSON.parse(output) as {
    streams?: Array<{ codec_name?: string; width?: number; height?: number; pix_fmt?: string; r_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  const duration = Number(parsed.format?.duration);

  if (!stream) {
    throw new Error("没有读取到视频流。");
  }

  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    pixFmt: stream.pix_fmt,
    frameRate: stream.r_frame_rate,
    duration,
  };
}

async function isValidExistingVideo(filePath: string) {
  if (!existsSync(filePath)) {
    return false;
  }

  const fileStat = await stat(filePath);

  if (fileStat.size <= 0) {
    return false;
  }

  const metadata = await probeVideo(filePath);

  return (
    metadata.codec === "h264" &&
    metadata.width === 1280 &&
    metadata.height === 720 &&
    metadata.pixFmt === "yuv420p" &&
    metadata.frameRate === "24/1" &&
    metadata.duration >= 4 &&
    metadata.duration <= 5.5
  );
}

async function generateVideo() {
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });

  await run(ffmpeg.path, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=24:duration=4.5",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x17bebb:size=180x120:rate=24:duration=4.5",
    "-filter_complex",
    "[0:v][1:v]overlay=x='mod(t*260,1100)':y='260+80*sin(t*3)':shortest=1,format=yuv420p",
    "-an",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-level",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    OUTPUT_PATH,
  ]);
}

async function main() {
  if (await isValidExistingVideo(OUTPUT_PATH).catch(() => false)) {
    console.log("demo.mp4 已存在且有效，未重复生成。");
    return;
  }

  await generateVideo();

  const fileStat = await stat(OUTPUT_PATH);
  const metadata = await probeVideo(OUTPUT_PATH);

  if (fileStat.size <= 0) {
    throw new Error("demo.mp4 文件大小为 0。");
  }

  if (
    metadata.codec !== "h264" ||
    metadata.width !== 1280 ||
    metadata.height !== 720 ||
    metadata.pixFmt !== "yuv420p" ||
    metadata.duration < 4 ||
    metadata.duration > 5.5
  ) {
    throw new Error("demo.mp4 编码、尺寸或时长不符合要求。");
  }

  console.log("已生成并验证 public/mock-videos/demo.mp4。");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "生成 demo.mp4 失败。");
  process.exitCode = 1;
});
