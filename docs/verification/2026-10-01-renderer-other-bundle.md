# Renderer recovery and accessibility fixes

Package pkg-37 covers #564, #596, #597 and #600 on Windows.

The regression tests were run against the old behavior before each fix. Dictate
checks both daylight-saving transitions in America/Los_Angeles only after
verifying the dates have different UTC offsets. A worker that ignores the
runtime timezone skips with an explicit reason. Phones and Hosts
check rejected saves, retained values and successful retries. Files holds the
first root listing, retries a failed listing for a nested file and closes a
preview while its root is pending. Accessibility tests check hidden readable text for the pairing code and
questionnaire progress, with their visual forms hidden from screen readers.
Neither label uses an image role or live region.

`renderer-save-feedback.spec.ts` ran the built Electron app. It replaced only its
owned profile's settings file with a directory to force real save failures, then
restored the file and saved again through the keyboard. All three controls passed
at 1600x1000, 1280x800 and 820x560, in light and dark with reduced motion on.
The local-host view checks horizontal overflow. The retained screenshots were
inspected: the errors wrap beside their controls without clipping.

- [Local host, 820x560 dark](../../artifacts/renderer-save-feedback/local-host-820-dark.png)
- [Phone access, 820x560 light](../../artifacts/renderer-save-feedback/phone-access-820-light.png)

The existing hosts, memory and dictation recovery journeys passed. The first
phones journey stopped on its hard-coded September pairing expectation on
October 1; the assertion now derives the date from the actual pairing timestamp.
The first Tools rail journey stopped before the Changes file list appeared;
its separate Changes scope journey passed. A standalone rail rerun stopped when
switching back to Working changes. The identical assertion failed against a
built archive of baseline `2f1d74f240cbcd2b3ab6a1b0e5a212111ccc5221`, kept
inside this worktree with no dependency links or changes to the main checkout.
The phones rerun passed after correcting the dated assertion. The final focused
unit run passed all 84 tests. Full-suite results are recorded in the pull request.
No design baselines were regenerated.

The prototype comparison lives on `prototype/pkg-37-save-feedback`. Variant A
places feedback beside the control, following #596's requested placement. This
was the reversible assumption used after asking for clarification; no alternative
layout was selected by the user. The implementation uses the app's real controls
and theme tokens. No domain term or architectural decision changed.

## Review correction

The PR review reproduced a busy preview when opening a file four or five folders
deep: ancestor reads consumed the service's four request slots before the preview
started. Files now queues its reads and path actions within that same limit,
shared with main as a constant. A controlled bridge holds each read and rejects a
fifth concurrent request. Both deep-path regressions failed before this correction
and pass after it, with every expanded folder and the preview ready without Retry.

## Rework checks

The stalled-queue regression failed before the deadline was added and passed
afterward. It holds all four slots, advances fake timers through the ten-second
wait for a root listing, preview and Retry, then releases the reads and checks
that expired waiters do not obstruct recovery. The deep-path tests still pass.
The accessibility regressions also failed before their labels were changed.

The normal DST regression executed and passed. Starting the threads pool in UTC
produced 19 passed and one explicitly skipped test, confirming that the offset
guard prevents a vacuous DST pass. Field errors again use their existing input
description without making unrelated fields live regions.

The throwaway semantics demo is retained on
`prototype/readable-progress-pairing-text`. It preserves the visual count and
code and shows the readable text separately, without a live region. The wording
was a reversible assumption after clarification was requested; no user choice
was recorded.

The rework's built Electron journeys passed for Hosts, Memory, Phones and real
settings save failures. The accessibility-tree checks find the ordinary readable
progress text and spelled pairing code, and reject live regions on those labels.
The save-feedback journey again covers all three window sizes in light/dark with
reduced motion and keyboard retries. Fresh captures at those sizes were visually
inspected; minimum-size feedback wraps, and the code remains spaced and readable.
The two existing retained feedback captures were refreshed from this run.

- [Questionnaire progress](../../artifacts/renderer-save-feedback/questionnaire-readable-progress.png)
- [Pairing code, 820x560 dark](../../artifacts/renderer-save-feedback/pairing-code-820-dark.png)

The first complete rework run passed all four required local gates.
`npm test -- --maxWorkers=2` completed with 507 passed and 39 skipped files:
6,901 tests passed and 154 skipped in 21.2 minutes. Typecheck and lint passed
again after the Electron assertion edits; notices verified 174 components.
The built Electron run passed all seven tests in 5.6 minutes, including both
Tools rail and Changes-scope journeys that failed on earlier revisions.
The independent Standards and Spec reviews have no remaining findings.


## Follow-up gate checks

The second Windows attempt passed SSH but exposed a Hosts focus test that could
find the dialog before its passive focus effect ran. A separate test commit waits
for the same focus target before asserting or sending keyboard input. All 44
Hosts tests pass, and both independent reviewers cleared the change.

[Gates (Windows) passed on 892661e0](https://github.com/millZach/Sotto/actions/runs/36917982127/job/110556616879):
6,930 tests passed and 151 skipped; typecheck, lint and notices passed.
The follow-up full local run passed 6,895 tests but hit six unchanged 15-second
timeouts across threadWorktrees, socketHostContract, gitStatus, worktreeCleanup
and headlessWorktreeCleanup. The failed files' isolated reruns and the subsequent
main-sync checks are reported in PR #666. Their deadlines and assertions were
preserved.


After syncing main at 94fb4ea4, all five timeout files passed serially: 127 tests
with their original assertions and deadlines. The affected-test run passed 531
tests across 16 files; typecheck, lint, notices and the rebuild passed.
[Gates (Windows) passed on c52b22e0](https://github.com/millZach/Sotto/actions/runs/36921868287).

The rebuilt Electron run passed six of seven journeys. The broad Tools rail
matrix repeated the Working changes assertion already reproduced on baseline
2f1d74f240cbcd2b3ab6a1b0e5a212111ccc5221. Its standalone file rerun passed the
Changes-scope journey but repeated the rail failure. The saved state still showed
Reading the working tree when the five-second assertion expired. Changes' store,
surface and Git comparison code are unchanged from that baseline; the assertion
was preserved. Fresh progress, pairing and save-feedback captures were inspected.
The later installer/adapter main sync and its checks are recorded in PR #666.
