# Recovery through application boundaries (#395)

`npm run test:recovery` now runs the existing focused recovery contracts, builds the same checkout, and drives three real Electron journeys with one worker. It covers uncertainty and Stop across the coordinator and workspace, history failures through the real event store, shutdown drainage, actual completed dictation text through the renderer and output service, receipt feedback and queued steering. `docs/ci.md` maps each boundary to its assertions. Synthetic provider and clipboard effects replace external services; the Sotto layers between them remain real.

The additional regression replaces the coordinator, workspace host, thread registry and provider adapters over the same isolated directory after an uncertain send. The durable outbox intent and native binding survive. Repeating the same draft sends nothing. An unrelated user message with identical words leaves the intent uncertain, while the exact late message ID and command ID settle it and enter workspace history once. Repeating the original draft still sends nothing. This extends the existing held-send, rejected-Stop and ordinary-success cases instead of duplicating their fixtures.

## Verified

- Typecheck, lint and notices passed.
- The compact runner passed 201 tests across seven files with two workers, built the app, then passed all three Electron journeys in 22.0 seconds: command receipt, dictation recovery and queued steering.
- Source and built app came from `review-395`, based on the approved dictation recovery integration `9965452a`. No alternate main-entry path was used. The daily workspace journey is owned separately by #391 and the broader release check by #393.
- The minimum dark queued-steering view, minimum light dictation recovery and reconnect model picker were inspected. Controls and recovered words were visible. The existing journeys also generated dark/light captures at their defined sizes and retained their keyboard assertions. No design baseline changed; pre-existing command-receipt and queued-steering captures were restored.
- `SOTTO_PERF_DATA` pointed to a verified absent owned artifact path. No paid turn, production profile or real microphone input was used.
- Independent native Astra Standards and Spec reviews and the parent source/minimum-capture review reported no findings. The full two-worker suite remains queued. This proof is Windows-local; macOS was not exercised.

The temporary Grok read-error diagnostic discovered while preparing these checks was moved to ignored `.probe.txt` evidence and then implemented separately in #420. It is not part of this recovery test change.

- [Queued steering at the minimum size](../../artifacts/review-395/queued-steering-minimum-dark.png)
- [Completed dictation recovery at the minimum size](../../artifacts/review-395/dictation-recovery-minimum-light.png)

## Integrated dependencies

The actual merged dictation-recovery and SSH-readiness changes were integrated at `c728ed90`. Recovery production source is unchanged from the compact native run. The incoming App test query correction was retained and all 36 App tests passed. Typecheck, lint, notices and all eight workspace-control tests had also passed after the preceding merged fixture/shared-ignore integration. The full two-worker suite remains queued.

The branch was refreshed onto actual main `22c8e90b` at `f21a755b`. All merges, including the additive CI instructions, were automatic. `workspaceControl.test.ts` and the `test:recovery` package command are unchanged from the previously reviewed integration `3437de36`; the committed native evidence remains scoped to its recorded build. No diagnostic test modules remain under this branch's artifact folder. Final acceptance will use the exact reviewed combined candidate's full gate and subsequent issue-specific PR CI; that combined result is still pending, and no new local full pass is claimed.
