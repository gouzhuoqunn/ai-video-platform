export function buildRemoteRestoreLaunchCommand(familyId: string) {
  if (!/^[a-z0-9-]+$/.test(familyId)) throw new Error("unsafe_family_id");
  const bundle = `/workspace/restore/${familyId}.json`;
  const log = `/workspace/logs/restore-${familyId}.log`;
  return `mkdir -p /workspace/restore /workspace/logs && nohup python3 /workspace/tools/restore-production-r2.py --bundle ${bundle} >${log} 2>&1 </dev/null & echo $!`;
}

export function buildRemoteRestorePollCommand(familyId: string) {
  if (!/^[a-z0-9-]+$/.test(familyId)) throw new Error("unsafe_family_id");
  return `test -f /workspace/logs/restore-${familyId}.json && cat /workspace/logs/restore-${familyId}.json || printf '{"status":"starting"}\\n'`;
}

export const RESTORE_CONTROLLER_POLICY = {
  transport: "short-lived read-only presigned R2 GET URLs",
  launch: "one short SSH command using nohup",
  progress: "repeated short SSH polls of local JSON",
  forbidden: ["R2 admin credentials on GPU", "single blocking synchronous SSH window"],
} as const;
