# Final RTX 5090 video-only resume plan

Status: **plan only; no paid execution is authorized**.

This plan is bound to the existing durable Stage 4J.3 partial result. It must not create image work, restore UltraReal, regenerate segment 0, or create any short-video task.

## Exact durable boundary

- Batch: `stage4j1-final-5090-20260718`
- Image A job: `d3573f65-1400-4a27-9bcf-4ff6f8f34273`
- Image B job: `8cdc12f3-cc75-43dc-ae49-423071389f07`
- Long-video project: `a6cbf8c1-f158-4583-8f40-fa524dddd9d1`
- Accepted segment 0: `9e5f4d03-5233-4612-a375-01251c9c230a`
- Accepted segment-0 attempt: `b94faa26-e434-4c38-a67c-bacbb3bd51a6`
- Remaining segment 1: `554adaa8-fc5f-40c3-a02b-331eabcd23c8`
- Remaining segment-1 generation job: `4aef1e01-ec3e-40cb-936d-5b6c1e29d68c`
- Segment-0 MP4 SHA-256: `4d72d09d12f2bf7a40e6ab49f29cc963e002bcab3d3ec2046126aef2307758d9`
- Segment-0 last-frame SHA-256: `6260f7149b352bb4f337d8ce9a63f16f169e28c61e11052590e653e342cfb77a`
- Segment-1 input: the exact accepted segment-0 last-frame ref, `segments/000/attempts/b94faa26-e434-4c38-a67c-bacbb3bd51a6/last-frame.png`

## Required plan flags

- `completed_rtx5090_images_reused=true`
- `image_jobs_to_generate=0`
- `image_model_restore_required=false`
- `segment_0_reused=true`
- `segment_0_inference_required=false`
- `segment_0_media_valid=true`
- `segment_0_last_frame_valid=true`
- `segment_1_attempts=0`
- `segment_1_inference_required=true`
- `wan_restore_required=true`
- `video_segments_to_generate=1`
- `short_video_tests=0`
- `expected_provider_orders=1`
- `paid_execution_authorized=false`

## Future one-order sequence

Only a new explicit user authorization may permit the following:

1. Create one RTX 5090 On-Demand Clore order.
2. Pass the deterministic SSH and Blackwell readiness gates.
3. Restore Wan once. Do not restore UltraReal.
4. Submit segment 1 once with execution ID bound to its durable attempt and the exact accepted segment-0 last frame.
5. Synchronize and SHA-validate segment-1 media.
6. Cancel the GPU immediately and confirm zero active orders twice.
7. Locally merge segment 0 and segment 1 into the 1280×720 master.
8. Locally derive the deterministic 1920×1080 final.
9. Verify final playback, Range, seeking, refresh persistence, task card, and segment strip.

The runner must recover an already-completed remote result by the same deterministic attempt ID; it must not create a duplicate attempt or resubmit inference after a local result-read interruption.

## Proposed reduced guard

- GPU: RTX 5090 only
- Provider/order: Clore, On-Demand, exactly one order, no replacement
- Maximum hourly price: `$0.65/hour`
- Proposed wall clock: `120 minutes`
- Proposed draining point: `105 minutes`
- Expected duration: approximately `55–90 minutes` for one Wan restore, one segment inference, synchronization, and guarded cleanup
- Expected wallet delta: approximately `$0.35–$0.80`, including conservative overhead
- Hard proposed wallet-delta cap: `$1.25`

These values are a proposal, not an authorization. Current provider holds remain enabled and no automatic rental action may consume this plan.
