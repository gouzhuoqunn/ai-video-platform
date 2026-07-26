import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { listImageTasks } from "../../src/lib/image-generation/local-image-task-store";
import { loadCloreConfig } from "./config";
import { readLiveOrdersSummary } from "./live";

export type WorkerState = { schemaVersion: 1; sessionId: string; pid: number | null; state: "starting"|"running"|"succeeded"|"failed"; taskIds: string[]; immutableCommit: string; startedAt: string; lastHeartbeatAt: string; completedAt: string|null; exitCode: number|null; sanitizedError: string|null; sessionReceiptPath: string; logPath: string };
export const root = (id:string) => path.join(process.cwd(), ".secrets", "diagnostics", "image-sessions", id);
export const workerPath = (id:string) => path.join(root(id), "worker-state.json");
export const sessionReceiptPath = path.join(process.cwd(), ".secrets", "clore-image-session-receipt.json");
export const clean = (v:unknown) => String(v instanceof Error?v.message:v).replace(/(bearer\s+)[^\s]+/gi,"$1<redacted>").replace(/https?:\/\/[^\s]+/gi,"<redacted-url>").replace(/(token|credential|authorization|prompt)\s*[:=]\s*\S+/gi,"$1=<redacted>").slice(0,700);
export function atomic(file:string,value:unknown){mkdirSync(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.tmp`;const fd=openSync(tmp,"w",0o600);try{writeSync(fd,`${JSON.stringify(value,null,2)}\n`);fsyncSync(fd)}finally{closeSync(fd)}renameSync(tmp,file)}
export function readWorker(id:string){try{return JSON.parse(readFileSync(workerPath(id),"utf8")) as WorkerState}catch{return null}}
export function readReceipt(){try{return JSON.parse(readFileSync(sessionReceiptPath,"utf8")) as any}catch{return null}}
export async function archiveSafePrior(taskIds:string[]){const receipt=readReceipt();if(!receipt)return null;const unsafe=receipt.sessionState!=="completed"&&receipt.sessionState!=="failed"||receipt.currentTaskId!==null||!["cancelled","reconciled_inactive"].includes(receipt.cancellationState)||Object.values(receipt.tasks??{}).some((t:any)=>["submitting","accepted"].includes(t.inferenceState)||t.terminal==="ambiguous");if(unsafe)throw new Error("prior_session_receipt_unsafe");const active=await readLiveOrdersSummary(loadCloreConfig(),{forceRefresh:true});if(active.some(o=>o.active))throw new Error("prior_session_active_order_exists");const tasks=listImageTasks();for(const id of taskIds){const t=tasks.find(x=>x.id===id);if(!t||t.status!=="waiting_for_gpu"||t.result||t.localClaim)throw new Error("prior_session_target_task_changed")};const archive=path.join(process.cwd(),".secrets","diagnostics","image-sessions","archive",`${receipt.sessionId}.json`);mkdirSync(path.dirname(archive),{recursive:true});renameSync(sessionReceiptPath,archive);return archive}
