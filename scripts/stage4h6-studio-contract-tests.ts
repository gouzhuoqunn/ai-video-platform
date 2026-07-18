import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(file: string) { return readFileSync(file, "utf8"); }

const studio = read("src/components/LocalCreationStudio.tsx");
const longStudio = read("src/components/LongVideoStudio.tsx");
const billing = read("src/components/BillingPanel.tsx");
const firstFrame = read("src/components/FirstFrameInput.tsx");

assert.match(studio, /useState<StudioMode>\("video"\)/);
assert.match(studio, /setMode\(normalizeStudioMode\(window\.localStorage\.getItem\(STUDIO_MODE_STORAGE_KEY\)\)\)/);
assert.doesNotMatch(studio, /useState<StudioMode>\(\(\) => typeof window/);
assert.match(studio, /data-studio-mode=\{mode\}/);
assert.match(studio, /aria-pressed=\{mode === item\}/);
assert.match(studio, /data-testid="studio-status"/);
assert.match(studio, /data-testid="billing-toggle"/);
assert.match(studio, /aria-label="资费情况"[\s\S]*?data-testid="billing-toggle"[\s\S]*?>资费情况<\/button>/);
assert.match(billing, /<section aria-label="资费情况"[\s\S]*?<h2 className="text-lg font-bold">资费情况<\/h2>/);
assert.match(billing, /useEffect\(\(\) => \{[\s\S]*?void refresh\(\)/);
assert.doesNotMatch(billing, /setInterval/);
assert.match(longStudio, /draftRestored/);
assert.match(longStudio, /if \(!draftRestored\) return/);
assert.match(firstFrame, /data-testid="first-frame-dropzone"/);
assert.match(firstFrame, /onDrop=/);
assert.match(firstFrame, /onPaste=/);

console.log(JSON.stringify({ ok: true, hydrationSafeInitializer: true, postMountRestore: true, billingLazy: true, draftGuard: true, firstFrameDrop: true }));
