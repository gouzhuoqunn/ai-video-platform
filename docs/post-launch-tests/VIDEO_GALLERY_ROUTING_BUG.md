# Video gallery routing repair

## Symptom

Several independently submitted video prompts could appear to replace the
second-row first video card, while related records showed up in the image
gallery. The ninth card starting a second row is normal; disappearing cards
and cross-gallery ownership were not.

## Root cause

The normal `video_from_generated_image` path persisted two execution records:
an image-model first-frame dependency and the video task. The dependency kept
the video's form marker but was rendered as an independent image card because
the Studio filtered directly on `generationType`. The prior monotonic refresh
guard prevented one ordering race, but a polling response could still replace
the full client pool without reconciling newer returned records.

## Invariant and repair

- Every task now has immutable `mediaType` (`image` or `video`) and a separate
  video subtype (`short_video`, `long_video_parent`, or `long_video_segment`).
  Execution family, sound mode, model key, GPU class, and active tab do not
  decide gallery ownership.
- A generated first-frame is retained in the canonical ID-keyed task pool as
  an image-model dependency, with `galleryParentId` set to its video parent.
  It therefore is not a top-level image card. It remains available to the
  scheduler without being mistaken for an independently submitted image.
- Gallery views are pure media-type filters. Long-video segments are children
  of their project and are not top-level gallery cards.
- Reads validate missing/invalid media type fail-closed. The only compatibility
  repair hides an unexecuted legacy first-frame record when its persisted child
  video task explicitly references that exact ID; ambiguous and executed
  historical records are not guessed or reclassified.
- The client merges pool responses by task ID and `updatedAt`, so an older poll
  cannot downgrade newer media/lifecycle data or drop a newly returned task.

## Regression coverage

`npm run studio:multi-task-card:test` verifies independent and identical video
tasks, eleven rapid generated-video parent cards, hidden first-frame
dependencies, image/video selector isolation, long-segment hiding, scoped
delete/regenerate, immutable media type, task-ID React keys, dynamic/no-store
reads, explicit submission type, and Enter submission handling.
