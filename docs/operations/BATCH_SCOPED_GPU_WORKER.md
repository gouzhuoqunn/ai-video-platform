# Batch-scoped GPU Worker

The immutable RTX 4090 Worker is configured with one batch ID, expected task count, `video_wan_silent`, `rtx4090`, short lease and restricted Worker credentials. It calls only the batch claim RPC and then the matching batch heartbeat, completion and failure RPCs.

Migration `0013_gpu_execution_batch_task_contracts.sql` is required after `0012`. The remote deployment and role probe remain pending Supabase CLI authentication; do not set `LOCAL_GPU_BATCH_RPC_VERIFIED=true` before that probe succeeds.
