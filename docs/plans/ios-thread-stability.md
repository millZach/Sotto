# iPhone thread stability

Worktree: `.worktrees/fix-ios-thread-stability`, from `main` at `ef5ee727`.

## Acceptance checks

- [ ] Opening a thread on an online computer does not require another connection.
- [ ] Large lists and streaming threads stay responsive; measure a repeatable reproduction before fixing.
- [ ] Unsettled threads show first. Settled threads sit under a collapsed disclosure, as on desktop.
- [ ] Existing questions, permission authority, uncertain delivery, and host-qualified identities are preserved.
- [x] Regression tests, native compilation and prototype visual inspection are recorded separately, with native visual gaps stated.

Zach chose the desktop grouping and reports freezing both on the list and inside a thread. Keep the existing native appearance. The prototype demonstrates that choice; this is not a restyle. It is retained on the published `prototype/ios-thread-list` branch, at `artifacts/review-ios-stability/thread-list-prototype.html`.

## Current state

Implemented: parse sorting dates once per row; skip unused event history; decode ordered frames away from the UI actor; accept incremental thread detail with a single resync on a missing base; reuse observed initial detail; preserve a healthy connection when a thread read fails; group settled threads using desktop workspace and provider rules. Unchanged message bubbles skip Markdown work on unrelated updates.

The original list took 0.545 seconds for 500 threads; the same local harness takes 0.018–0.023 seconds after the fix. Two model tests fail against the original AppModel and pass against the changed source. Core and model tests pass locally with Swift 6.0.3 under WSL, using temporary stand-ins for Darwin DNS and SwiftUI observation only. The actual connection file also typechecks with FoundationNetworking. The macOS CI job also passed the native package tests and unsigned simulator build on `d6056c6c`; no device journey is claimed. Docker image downloads failed; the temporary compiler came directly from swift.org instead.

Independent standards and spec reviews are complete and their findings fixed. Remaining: final CI gates, merge, TestFlight upload and the native UI/device journey. The first three are authorized delivery steps; the device checks require installation on an iPhone. See `docs/verification/ios-thread-stability.md` for the evidence as it is completed.
