# Effort furnace verification

The composer now uses the approved B popover from the effort prototype. Model discovery supplies its stops; the renderer does not invent effort values. Native new-thread and terminal fields keep their existing controls.

## Experience checked

Electron verification uses an isolated test profile and a synthetic Claude catalog, without paid turns. The journey covers continuous pointer preview without saving, discrete save on release, keyboard endpoints, delayed gold after melting, reset when lowering effort, Escape focus, outside and Tab dismissal, visible Ultrathink insertion with prompt focus, duplicate prevention, and both app and operating-system reduced motion. Unit integration also checks advertised Codex Ultra, absent Ultra, unknown current values, failed saves, and a turn starting during a drag.

The flame and token pile remain the focal element, followed by the track and animated words. There is no duplicate selected-effort heading. The popover has four purposes: effort choices, a brief description, the optional draft action, and Done. The existing chip outside the popover continues to show the confirmed effort. Figtree and the active theme carry through from the composer. The gold word meets 4.5:1 on the raised surface across every shipped theme; on light themes it is a darker gold for readability.

Captures live under `artifacts/effort-furnace/`: `max-ignition.png`, `max-gold.png`, and `{dark,light}-{1600,1280,820}.png`. The window sizes are 1600x1000, 1280x800 and 820x560. Ignition shows white Max text and pixel sparks beside the burning pile. The completed state shows a gold word and bar with the tokens gone. Reduced motion shows the completed state without letter or particle movement.

Independent source review found two issues: loss of focus after Ultrathink insertion, and an unsaved preview surviving a turn starting mid-drag. Both were corrected. Electron review additionally found Escape focus restoration ordering and stale anchoring after window resize; the implementation restores focus after native popover cleanup and schedules placement after composer layout, observing its layout ancestors because a capped-width composer can move without changing its own size.

## Validation

- Typecheck and lint passed after the interaction review fixes.
- Third-party notices verified: 174 components; no dependency changes.
- Focused integration and theme contrast: 84 tests passed across four files. The Electron effort check passed, including exact anchoring 8px above its chip after each resize. The final Electron run passed in 7.8 seconds. Reduced motion explicitly disables inherited control transitions, including the 1ms transitions from the global stylesheet. The existing thread creation/configuration/send journey also passed.
- The first full `npm test -- --maxWorkers=2` run reported 3,758 passes, 28 skips and four failures. It started before the mid-drag correction; the corrected case passes on rerun. The Grok live-history integration failure also passes in isolation. Two optional performance tests read the local workspace snapshot, which currently has no messages: longTranscript requires a nonempty message source, and statePipeline dereferences the missing final message. These failures are outside the changed effort path; that initial full run was not green.

## Provider limits

Claude Ultrathink is visible text in the current draft, with the existing draft persistence and retry behavior. It does not alter effort or permission settings. Ultracode combines extra-high effort and workflow orchestration; current discovery cannot confirm that workflow capability, so the prototype toggle is not exposed as a working production mode. Codex Ultra is offered when the selected model advertises it.

## Pull request validation

Integrated main at `71d0cd73beda2c0bcd0dde3b7ba93c3062a8acd9`. The two merge conflicts were documentation and artifact ignore entries; both sets of behavior were retained. Typecheck, lint and notices pass. The rebuilt effort and thread-creation Electron specs pass all three cases. Final independent standards and spec reviews found no remaining actionable issues.

Both optional personal-workspace performance failures reproduce in a clean, independently installed worktree at that exact main commit: longTranscript fails its nonempty-message assertion at line 51, and statePipeline accesses a missing final message at line 160. For the PR suite, `SOTTO_PERF_DATA` points to an absent folder so these optional benchmarks skip as they do on CI, as documented in `docs/ci.md`.

The first integrated CI-mode run passed 3,781 tests, skipped 31, and failed an existing Codex test that disconnected the fake provider before its answer receipt was recorded. The test passed in isolation, as did three clean-main attempts. The source showed the distinction between the parent's pipe write callback and the child's recorded receipt. The test now waits for the receipt before disconnecting and retains its exact post-close assertion against duplicate answers or declines. No production permission behavior changed.

The final full-suite result and Windows CI check are recorded on [PR #148](https://github.com/millZach/Sotto/pull/148).
