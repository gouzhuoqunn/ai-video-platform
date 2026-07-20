# Multiple submitted task cards regression

Observed symptom: after adding several video tasks, the Studio could display an older pool response and make recent cards appear absent.

Root cause: concurrent poll and submit refreshes were allowed to resolve out of order. A late response containing an older snapshot replaced the newer React pool state. The durable pool upsert uses task IDs and the card key is `pool-${task.id}`, so this was a stale display-state regression rather than intentional task de-duplication.

Fix: the pool route is dynamic with `Cache-Control: no-store`, the browser fetch opts out of cache, and a monotonic refresh sequence ignores stale responses. The follow-up gallery repair also gives each task an immutable `mediaType`, keeps generated first-frame work as a hidden dependency of its video parent, and merges responses by task ID plus `updatedAt`. Focused regression coverage submits eleven independent cards, including identical prompts and rapid generated-video requests, and verifies selector isolation plus scoped deletion/regeneration without collapsing neighboring cards. See `VIDEO_GALLERY_ROUTING_BUG.md`.
