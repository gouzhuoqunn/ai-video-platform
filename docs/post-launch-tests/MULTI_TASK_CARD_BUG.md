# Multiple submitted task cards regression

Observed symptom: after adding several video tasks, the Studio could display an older pool response and make recent cards appear absent.

Root cause: concurrent poll and submit refreshes were allowed to resolve out of order. A late response containing an older snapshot replaced the newer React pool state. The durable pool upsert uses task IDs and the card key is `pool-${task.id}`, so this was a stale display-state regression rather than intentional task de-duplication.

Fix: the pool route is dynamic with `Cache-Control: no-store`, the browser fetch opts out of cache, and a monotonic refresh sequence ignores stale responses. Focused regression coverage submits eleven independent cards, including identical prompts and a same-queue set, and verifies scoped deletion/regeneration without collapsing neighboring cards.
