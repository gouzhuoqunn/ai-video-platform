# Local Image Workspace

Run `npm run dev:local` for the loopback-only image task workspace.

- The workspace can create and confirm image tasks locally.
- The left GPU panel persists runner state, maximum hourly price, compact host details, and copyable backend errors.
- The RTX 4090 paid runner remains disabled by default until the explicit executor readiness gate is enabled.
- Loading the page never creates or cancels a Clore order.
- Generated image results are stored locally under ignored `local-data/image-results/` after PNG signature, dimension, and SHA-256 validation.
