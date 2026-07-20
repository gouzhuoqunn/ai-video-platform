# GPU rental start interaction repair

## Root cause

The Studio button had a `type="button"` and was not covered by a form submit,
but its click handler returned before setting any visible state when the current
filtered candidate list had no manually selected card. This commonly happened
after selecting a different GPU queue than the initially selected marketplace
card. The return neither searched candidates nor showed an error, so the UI
appeared inert.

## Repair

`rentalEligibilityFor` is the canonical typed decision used by the sidebar,
click handler, and generation-pool mutation endpoint. It reports stable reason
codes, total/confirmed/executable/audio-waiting counts, and a Chinese message.
The selected queue uses executable count, not a raw card count.

An eligible click sets the synchronous, duplicate-click-safe state
`正在搜寻符合价格要求的显卡`, locks queue switching, performs exactly one
read-only candidate request, persists the `searching` pool activity, and then
uses the existing one-time confirmation-plan route. Candidate search returns no
raw provider payload and does not create an order, reserve funds, release a
hold, or deploy a model. Any no-candidate, API, or plan failure clears the local
mutation state and uses the existing safe search-abort path.

Silent Wan tasks never use GPT-SoVITS readiness as a gate. An audible task
requires a present `local_audio_ready` binding before confirmation/execution;
an audio-ready confirmed task is eligible locally.

## Focused evidence

`npm run gpu:rental-eligibility:test` covers no selection, empty and
unconfirmed queues, incomplete/invalid/ready audible audio, silent readiness,
GPU conflicts and activity locks, authorization, runtime/manifest blockers, and
unknown errors. It performs no provider request or mutation.
