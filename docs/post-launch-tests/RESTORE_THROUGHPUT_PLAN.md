# RTX 5090 restore-throughput qualification plan

Status: **implemented and tested offline; no paid execution is authorized**.

## Stage 4J.6 diagnosis

The Wan manifest contained 35,572,266,487 bytes:

- High diffusion model: 14,291,272,136 bytes
- Low diffusion model: 14,291,272,136 bytes
- Shared UMT5 model: 6,735,906,897 bytes
- Wan VAE: 253,815,318 bytes

The restore bundle supplied short-lived AWS SigV4 presigned GET URLs for the authenticated Cloudflare R2 S3-compatible endpoint. The remote Python standard-library client used one HTTP connection per object, three whole-object workers, and Range only to continue a monolithic `.part` file. It had no per-object multi-stream ranges or connection pool. In Stage 4J.6, the first three large objects occupied all three workers while the VAE waited.

The last sanitized observation was 4,336,910,336 of 35,572,266,487 bytes in 770 seconds, or 5,632,351 bytes/second. It was canceled without a preceding HTTP, SHA, manifest, model, SSH, Blackwell, or Runtime error because the remaining transfer could not finish before the old draining boundary. The exact classification is:

`restore_throughput_incompatible_with_previous_session_deadline`

## Actual-source qualification probe

The future probe uses the same presigned read-only R2 model-object URLs as restore. It:

- selects at least the two largest objects;
- reads and discards 384 MiB total;
- uses eight bounded Range streams;
- runs for no more than the 60–90 second qualification window;
- requires HTTP 206 and valid `Content-Range` for every stream;
- records aggregate and per-object rates, HTTP statuses, Range support, restore ETA, remaining wall-clock allowance, projected spend, pass/fail, and the exact reason;
- writes only hashed object identifiers, never signed URLs or credentials.

No bytes are persisted as model files by the probe.

## Restore transport

Large objects use eight distinct byte ranges by default, configurable from four to twelve, with a global maximum of twelve live streams. Range boundaries cover each object exactly once with no gaps or overlap. Each chunk has an independent `.part` file and resumes from its own verified byte boundary. Retries use bounded exponential backoff.

After all chunks finish, the restore concatenates them in range order into a temporary file, verifies exact size and full SHA-256, and atomically renames it. Corrupt assembled or chunk state is removed. Existing fully verified targets are reused. Small objects and Range-incompatible sources retain the existing resumable single-stream fallback. Progress heartbeat reports completed bytes, aggregate rate, ETA, active streams, per-file state, and reconnect counts without loading an object into RAM.

## Dynamic gate

Measured aggregate throughput is classified as:

- healthy: at least 15 MiB/s;
- acceptable with an extended estimate: 8–15 MiB/s;
- slow and subject to the dynamic gate: 5–8 MiB/s;
- inadequate: below 5 MiB/s.

The gate uses remaining restore bytes, measured actual-source throughput, elapsed time, fixed Runtime/inference/synchronization/cleanup allowances, hourly price, cumulative wallet delta, the 240-minute wall cap, and the 220-minute draining boundary. Safety multipliers increase as throughput falls. Continue only when both guarded completion time and projected combined spend fit; otherwise cancel before restore.

## Candidate ranking

Candidates must first pass exact RTX 5090, On-Demand, RAM, workspace, price, currency, and availability constraints. Compatible candidates are then ordered by:

1. prior successful actual-source restore or passing qualification evidence;
2. advertised download/upload bandwidth and whether that bandwidth can plausibly move 35.57 GB in the available time;
3. reliability;
4. advertised disk speed when present;
5. hourly price.

Clearly inadequate advertised bandwidth is rejected when the provider exposes it. No server ID is embedded in the selection code. Persisted scoring evidence contains only the candidate identifier, normalized metrics, compatibility/rejection reasons, and probe outcome; provider payloads and signed URLs are excluded.

## Future bounded sequence

The non-authorized future policy permits one active order, one production order, at most two qualification orders, and at most two sequential orders. The first candidate runs the probe. A different second candidate is allowed only if the first fails qualification before restore or inference. There is no replacement after restore begins or after any inference submission. All qualification and production time shares one `$1.25` wallet-delta cap.
