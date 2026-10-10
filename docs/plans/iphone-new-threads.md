# Create a thread from iPhone

October 9, 2026: Voice control and thread management described below are historical under [ADR-0067](../adr/0067-remove-voice-control-and-thread-management.md); the original plan or evidence is retained.

September 30, 2026. Zach asked to create threads in the iPhone app that run on its connected PCs.

## Deliverables and acceptance

- [x] Inspect the current iPhone app and the host's creation commands. Work is isolated on `feat/iphone-new-threads` from `main` at `77d24f8d`; the original checkout and its unrelated work are preserved.
- [x] Build three interactive HTML variants in the existing Threads layout: a compact sheet, a guided flow, and projects grouped by computer. Fixture data only.
- [x] Inspect the rendered prototype in light and dark, narrow width, keyboard navigation, and the offline/unconfirmed states.
- [x] Zach chose B, the guided flow, and asked to browse folders on a computer to start in a project not already active in Sotto. The project step now offers known projects and Browse another folder. Available connected providers are offered; no provider restriction was requested.
- [x] Source: typed model/project creation data and a narrowly scoped Swift command builder against host protocol v1. Phone-minted Sotto thread UUID, `managed: false`, shared project checkout by default (ADR-0014).
- [x] Source: create on the selected computer only, open the resulting conversation, then send through the existing reply path. Each computer's identity and connection remain independent.
- [x] Source: preserve permission authority (ADR-0004/ADR-0033). Read the host's available models/modes; explicitly send the chosen mode and disable grants without Can answer. Prefer an asking provider-owned mode by its allowance, not its name or position.
- [x] Source: reconcile uncertain creation by the minted thread ID and its receipt; keep an ID-only pending marker, block duplicate taps, and never automatically resend after disconnect/background/restart.
- [x] Swift package tests pass for routing across computers, unavailable model/project, revoked authority, creation refusal, lost acknowledgement and restart. Update the user guide and iPhone README.
- [x] Native package tests and simulator compilation passed in macOS CI: 95 tests, 1 skipped, no failures.
- [x] Complete the native UI journeys and inspect their captures. All five journeys passed on each simulator at `0be9d2aa`: iPhone SE and iPhone 16 Pro Max, iOS 26.5. Existing-project and new-folder creation passed in dark/light; the large phone used accessibility-large text and reduced motion. Primary and independent visual inspection found no material defects. [Verification and selected captures](../verification/2026-09-30-iphone-new-threads.md).

## What exists

The host already accepts `create-thread` and `create-project` through its closed remote allow-list. The shell already carries projects, models and provider connections. The current Swift wire models discard much of this display data, and its command builder offers replies, stops, earlier messages and request answers only. No new listener, remote service, provider credentials, or protocol version is needed for creating in an existing project.

Zach chose B on September 30, 2026. The fixture prototype is retained on `prototype/iphone-new-thread` at `f63aec91`, in `docs/prototypes/iphone-new-thread-prototype.html`, switchable with `?variant=A`, `B`, or `C`. The guided variant includes browsing an existing folder, filtering the current directory and entering a full host path. A separate question about recursive search remains optional; the existing host protocol lists one directory at a time. The prototype is not a native app or proof of remote execution.
