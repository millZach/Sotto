# Continue after an unconfirmed prompt

October 17, 2026. Windows laptop. Branch `fix/unconfirmed-send`, based on `f000d7612`.

## Failure and choice

A provider can lose the evidence needed to confirm a prompt. Both the composer and the coordinator then hold every later prompt, while **Check again** can only reconcile the original message. Refreshing cannot resolve a message the provider no longer reports. The original renderer regression failed because the stuck composer offered no recovery.

Zach chose **Continue with a new message**, without resending the old prompt. He rejected the standalone approximation, requested distinct views in Sotto's actual layout, and chose A: the recovery beside **Check again**. The prototype compared that with a composer action and a confirmation dialog. The implementation keeps Sotto's existing Watcher room, theme, typography and controls.

The throwaway prototype is preserved separately in the local Git tag `prototype/unconfirmed-send-recovery-20261017`; it is not part of the implementation checkout.

## Built Windows app

`tests/e2e/watcher.spec.ts`, **an unconfirmed prompt has a recovery in the actual Watcher room**, drives the built Electron app. It opens Watcher, submits a prompt with an uncertain acknowledgement, removes its provider echo, writes `hello`, reloads, and checks again. The new message remains blocked until explicit recovery. Pressing the recovery from the keyboard returns focus to the composer, preserves `hello`, and leaves the original marked **Set aside · Unconfirmed**. Another reload retains the choice, then Enter sends exactly `hello` once.

The Watcher projection uses the existing fixture bridge; coordinator, draft persistence, IPC, delivery recovery and renderer are real. External provider effects are scripted. This verifies the recovery from missing evidence, not the cause of Zach's original Muse failure.

The journey also queues another explicit message, waits for the current turn to end, denies a new permission, and answers a new question. Coordinator regressions separately cover a question or permission arriving before recovery: the request remains pending until the user's answer. Hidden Watcher news and plain or mixed restart notes remain held while new user messages pass them, including across a coordinator restart.

Two independent GPT-6.1-Sol reviewers at high reasoning checked standards and the reported failure. Standards had no material findings. Spec review found the later-answer, hidden-news and leading-restart-note deadlocks; each was reproduced by a failing regression and corrected. The final review is recorded with the run's validation evidence.

Dark and light, with reduced motion on, passed at 1600×1000, 1280×800 and 820×560. The checks inspect overflow and clipping and measure visible recovery text against its surface at 4.5:1 or better. Captures were opened and inspected.

- [Blocked composer with recovery in the real Watcher room](../../artifacts/unconfirmed-send/watcher-recovery-dark-1280x800.png).
- [Newer draft ready after recovery at the minimum size](../../artifacts/unconfirmed-send/watcher-set-aside-light-820x560.png).

Run after `npm run build`:

```sh
npx playwright test tests/e2e/watcher.spec.ts -g "an unconfirmed prompt has a recovery" --workers=1
```

## Remaining surfaces

The broader three-spec run had 20 passes, five failures and one test not run. All five failures were reproduced with the same dependencies after checking out and rebuilding the unchanged base `f000d7612`:

| Existing journey | Same failure on the base |
| --- | --- |
| Watcher provider-change handover | Initial Watcher starts on the Claude fixture rather than the Codex reply the assertion expects. |
| Independent text/image draft restart | The assertion looks for bare `docs` in host-qualified draft IDs and reads `undefined.text`. |
| Project settlement | The assertion looks for bare `docs` in host-qualified thread IDs and reads `undefined.workspaceSettledAt`. |
| Light provider controls | The journey expects a New thread dialog that does not appear. |
| Failed-send keyboard recovery | The journey expects Retry to disappear after newer typing; it remains visible. |

The final focused built-app run passed both the new Watcher recovery journey and the existing composer permission/failed-answer journey. These baseline failures are recorded separately from the new recovery regressions; the broader E2E run is not reported green.

The full unit/integration run exposed two regressions in the initial candidate. Restart-note review read a stale selected queue item; it now reads the current record by its exact ID. A prompt already staged at Send was incorrectly refused when newer typing replaced its saved revision; normal replacement now preserves the staged packet, while explicit set-aside still fences it. Each failed separately before correction. The six-file rerun passed all 169 tests across atomic draft sending, restart recovery, delivery navigation, follow-ups and the unchanged copy budgets.

That full run finished with 939 files passing, two failing and 78 skipped: 12,263 tests passed, two failed and 348 skipped. It began before those two corrections, so it is not a green full-suite result for the final code. No other failures were reported. On the final code, typecheck, lint, notice verification (189 components), build, the 169-test rerun and both focused Electron journeys passed. The entire suite has not been repeated after the corrections.

The current recovery allows explicit new messages and answers, while automatic Watcher updates remain held until the original delivery is confirmed. Zach has been asked whether sending a fresh message should also resume those automatic updates; that behavior has not been changed without his answer.

The installed Sotto build has not been replaced or restarted. Live Muse, packaged Windows, macOS and Linux recovery journeys have not been run. Remote hosts and phones cannot perform this recovery; they direct the user to the desktop that owns the thread. Questions, permissions, a live send and queued follow-ups retain their own recovery rules. No design baselines were regenerated.
