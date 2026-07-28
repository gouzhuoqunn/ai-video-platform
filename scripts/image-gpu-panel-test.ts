import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizeRunnerLog } from "./image-executor/readiness";

const studio = readFileSync("src/components/ImageCreationStudio.tsx", "utf8");
const route = readFileSync("src/app/api/local-lab/image-tasks/route.ts", "utf8");
const globals = readFileSync("src/app/globals.css", "utf8");

assert.match(studio, /显卡状态/);
assert.match(studio, /lg:grid-cols-\[320px_minmax\(0,1fr\)_360px\]/);
assert.match(studio, /图像工作台/);
assert.match(studio, /活动任务/);
assert.match(studio, /最高时价/);
assert.match(studio, /确认生成 RTX 4090 任务/);
assert.match(studio, /停止并退租 \/ 取消本批次/);
assert.match(studio, /显卡租用时间/);
assert.match(studio, /退租倒计时（最晚）/);
assert.match(studio, /rentalClockSnapshot/);
assert.match(studio, /window\.clearInterval\(timer\)/);
assert.match(studio, /当前候选显卡/);
assert.match(studio, /已租用主机/);
assert.match(studio, /task\?\.result\?\.relativeDir/);
assert.match(studio, /ImageResultsGallery/);
assert.match(studio, /当下日志/);
assert.match(studio, /StudioLogModal/);
assert.match(studio, /image-tasks\?view=logs/);
assert.match(studio, />复制</);
assert.match(studio, />下载</);
assert.match(studio, /重新生成提示词/);
assert.match(studio, /prompt: promptDraft/);
assert.match(studio, /点击图片查看详情/);
assert.doesNotMatch(studio, /onDoubleClick=/);
assert.match(studio, /const mutationLock = useRef\(false\)/);
assert.match(studio, /if \(mutationLock\.current\) return;[\s\S]*mutationLock\.current = true;[\s\S]*await operation\(\);[\s\S]*mutationLock\.current = false/);
for (const action of ["create_group", "confirm_group", "cancel_group", "unconfirm_group", "regenerate_group", "start_batch", "cancel_batch"]) {
  assert.match(studio, new RegExp(action));
}
assert.match(studio, /正在处理，请勿重复点击/);
assert.match(studio, /aria-busy=\{busy\}/);
assert.match(route, /runner-session\.json/);
assert.match(route, /preferences\.json/);
assert.match(route, /executionReady: readiness\.rtx4090\.ready/);
assert.match(route, /projectLiveReceiptRunner/);
assert.match(route, /rentalTiming: projectedRentalTiming/);
assert.match(route, /mixed_gpu_classes_are_not_allowed/);
assert.match(route, /FLUX Kontext 执行器尚未完成/);
assert.match(route, /request\.nextUrl\.searchParams\.get\("view"\) === "logs"/);
assert.match(route, /CURRENT_LOG_EXPORT_MAX_BYTES = 512 \* 1024/);
assert.match(route, /typeof input\.prompt !== "string"/);
const logExportSource = route.slice(route.indexOf("function currentStudioLogExport"), route.indexOf("async function responsePayload"));
assert.doesNotMatch(logExportSource, /cloreRequest|readLiveOrdersSummary|spawn\(|appendFileSync|writeFileSync|rmSync/);
assert.match(globals, /\.image-studio-interactions/);
assert.match(globals, /@media \(hover: hover\) and \(pointer: fine\)/);
assert.match(globals, /:hover[\s\S]*brightness\(1\.16\)/);
assert.match(globals, /:active[\s\S]*translateY\(2px\) scale\(0\.98\)/);
assert.match(globals, /:focus-visible/);
assert.match(globals, /prefers-reduced-motion: reduce/);
assert.doesNotMatch(studio, /LongVideoStudio|视频任务池/);

const unsafeLog = [
  "\u001b[31mstage=health\u001b[0m",
  'HF_TOKEN="hf_1234567890abcdefghijklmnop"',
  "token=plain token value with spaces",
  "Authorization: Basic dXNlcjpwYXNzd29yZA==",
  'PASSWORD="quoted password value"',
  '{"prompt":"private prompt text","api_key":"sk-1234567890abcdefghijklmnop"}',
  "https://example.test/path?X-Amz-Signature=secret",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEY comment",
  "-----BEGIN PRIVATE KEY-----\nvery-secret\n-----END PRIVATE KEY-----",
  "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB\n-----END PRIVATE KEY-----",
  "<html><body>proxy credentials</body></html>",
  "unknown_code6 server-already-rented",
  "<html><body>unclosed proxy credentials",
].join("\n");
const safeLog = sanitizeRunnerLog(unsafeLog);
for (const secret of ["hf_1234567890", "plain token value", "dXNlcjpw", "quoted password", "private prompt text", "sk-1234567890", "example.test", "AAAAC3", "very-secret", "QUFBQUFB", "proxy credentials", "unknown_code6", "server-already-rented", "\u001b"]) {
  assert.ok(!safeLog.includes(secret), `sanitized log leaked ${secret}`);
}
assert.match(safeLog, /stage=health/);
assert.match(safeLog, /candidate_already_rented/);

console.log("image GPU panel contract: ok");
