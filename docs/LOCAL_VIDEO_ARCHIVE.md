# Local Video Archive

Status: local archive tooling is prepared and mock-tested. No real generated videos were downloaded in this task, and no remote Supabase video objects were deleted.

## 2026-07-11 local_lab serving API

- Added loopback-only API routes for listing local results, serving thumbnails, and serving `output.mp4` with Range support.
- The API validates `job_id`, prevents directory traversal with `path.relative`, and never returns full local absolute paths to the browser.
- The local_lab history cards prefer local archive video/thumbnail URLs when present, then fall back to short-lived Supabase signed URLs for succeeded jobs.
- This does not change the cleanup rule: remote Supabase deletion remains dry-run only.

## Purpose

Supabase private Storage remains the short-term relay for generated videos. Long-term keeping should move successful local-lab outputs to the user's local disk.

Default local library:

```text
D:\AI-Video-Library
```

Override:

```env
LOCAL_VIDEO_LIBRARY_DIR=""
```

## Structure

```text
YYYY-MM-DD/
  job_id/
    output.mp4
    metadata.json
    thumbnail.jpg
```

Downloads must write to `output.mp4.part` first, verify size/hash when available, then atomically rename to `output.mp4`.

## Cleanup Rule

Remote Supabase video objects may only be deleted after:

- The local file is verified.
- The object is at least 24 hours old.
- The command is run with explicit `--execute` in a future implementation.

Current cleanup is dry-run only and does not delete:

- `video_jobs` metadata.
- Real users.
- `gpu_worker` accounts or data.
- Other users' objects.

## Local Serving

Local website history may show these future statuses:

```text
local, cloud, both, archive
```

Any local file serving must stay limited to `127.0.0.1` or `localhost`. Do not expose the local archive to a remote host.

## Commands

```powershell
npm run results:sync
npm run results:check
npm run results:cleanup:dry
npm run results:test
```
