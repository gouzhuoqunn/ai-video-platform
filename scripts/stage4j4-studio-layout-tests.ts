import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const studio = readFileSync(path.join(process.cwd(), "src", "components", "LocalCreationStudio.tsx"), "utf8");
const longStudio = readFileSync(path.join(process.cwd(), "src", "components", "LongVideoStudio.tsx"), "utf8");
const globals = readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");

assert.match(globals, /grid-template-columns: minmax\(0, 1fr\) 320px/);
assert.match(studio, /data-testid="permanent-gpu-sidebar"/);
assert.match(globals, /height: calc\(100vh - 72px\)/);
assert.match(globals, /overflow-y: auto/);
assert.match(studio, /h-\[42vh\].*max-h-\[480px\]/);
assert.match(studio, /object-contain/);
assert.match(globals, /@media \(min-width: 800px\)[\s\S]*repeat\(4/);
assert.match(globals, /@media \(min-width: 1100px\)[\s\S]*repeat\(6/);
assert.match(globals, /@media \(min-width: 1366px\)[\s\S]*repeat\(8/);
assert.match(studio, /data-testid="shared-task-gallery"/);
assert.match(studio, /data-testid="long-video-segment-strip"/);
assert.match(studio, /short_video|短视频/);
assert.match(studio, /长视频/);
assert.match(studio, /modePoolTasks = pool\?\.tasks\.filter\(\(task\) => task\.generationType === ordinaryMode/);
assert.match(studio, /longVideoProjects\.map/);
assert.match(studio, /开始任务并租用显卡/);
assert.match(studio, /尚未选择兼容任务/);
assert.match(studio, /无任务 \{idleCancelSeconds\} 秒后自动退租/);
assert.match(studio, /: 120;/);
assert.match(studio, /showBilling \? <BillingPanel[\s\S]*<aside/);
assert.match(longStudio, /editorOnly/);
assert.match(longStudio, /\{!editorOnly \? <section/);
assert.doesNotMatch(studio, /max-w-\[1600px\]/);

console.log("Stage 4J.4 Studio layout contract tests passed.");
