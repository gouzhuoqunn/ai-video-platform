# Manual real GPU batch operation

Scope: confirmed silent Wan short-video tasks on RTX 4090 only.

1. Start the loopback-only local console with `npm run dev:local` (or `npm run build` then `npm run start:local`). These commands explicitly set `LOCAL_REAL_GPU_RENTAL_ENABLED=true`; do not copy this flag to a public deployment.
2. In the GPU sidebar select `无声 RTX 4090`. Confirm the intended short-video tasks, then click `开始 N 个任务并租用显卡` once. The server freezes the exact ordered task IDs before candidate lookup.
3. Wait for `正在搜寻符合价格要求的显卡`. The console uses only exact RTX 4090 candidates with an effective price no higher than `$0.70/hour`, chooses the cheapest compliant host, and displays the normal one-time plan.
4. Check the exact server, price, projected cost, and risk text. The provider call requires the nonce, exact text, risk checkbox, matching queued count, live revalidation, one-active-order rule, `$4.50` cap, `$1` reserve, 380-minute limit, and 350-minute drain boundary.
5. The first future paid session must run one synthetic silent prompt and pause for inspection. Do not start a broader batch until its worker bootstrap, result return, and safe cancellation have been observed.

Stop conditions: no candidate, price over cap, reserve/cap failure, an active order, changed batch IDs, expired nonce, worker readiness failure, or any unexpected provider response. Preserve the frozen record; do not retry automatically.

This document does not authorize a paid run by itself.
