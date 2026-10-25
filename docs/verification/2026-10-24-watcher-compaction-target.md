# Compact Watcher at, October 24, 2026

Scope: Windows x64, the built app from `feat/watcher-compaction-target` on the Owl track, in the Sotto thread worktree. Zach asked for a slider in Settings › Watcher that sets where Watcher's conversation is compacted, 200k to 1M, 400k by default, and for idle compaction to reach Watcher's own conversation (ADR-0073, October 24 section; ADR-0127, amended October 24).

## The design

Zach rejected a first round of three slider layouts that used Sotto's existing slider look. Of four new designs he chose C: a bar that is Watcher's conversation, hatched, with a line on it where Watcher compacts. The prototype is the tag `prototype/watcher-compaction-target`. He asked that the other sliders in Settings keep their look for now.

## In the app

`tests/e2e/watcher-compaction-target.spec.ts` launches the built app on the Owl track with Watcher's room stood in for at 312k tokens, as `watcher-night-scene.spec.ts` does, and opens Settings › Watcher.

- The slider sits under its own **Compaction** heading after Watched threads, named **Compact Watcher at**, at 400k, reading "400k tokens" to a screen reader. The line under it says "Watcher is at 312k."
- At 1600x1000, 1280x800 and 820x560, in dark and in light, nothing overflows or clips, and the label, description, flag and the line under the bar all meet 4.5:1 on their surface.
- From the keyboard, four presses of the left arrow move it to 200k, and letting go saves 200k. The hatching turns to the accent and the line says "Watcher is at 312k: it compacts at its next rest." End moves it to 1M and saves 1M. The flag carries the focus ring while the slider has focus.
- `tests/e2e/watcher-settle-finished.spec.ts` still passes, with the page's headings now Watched threads, Compaction, Worker roles.

Captures (from the spec's run evidence):

- [1280x800, dark, at 400k](../../artifacts/watcher-compaction-target/compact-watcher-at-1280x800-dark.png)
- [820x560, light, at 400k](../../artifacts/watcher-compaction-target/compact-watcher-at-820x560-light.png)
- [1280x800, dark, moved to 200k below Watcher's 312k](../../artifacts/watcher-compaction-target/compact-watcher-at-1280x800-dark-below.png)

## Main

Unit and integration tests, written before the change and failing on `main`:

- `tests/unit/shared/settings.test.ts`: `watcherCompactAtTokens` defaults to 400,000, keeps any value from 200,000 to 1,000,000 on a 50,000 step, and falls back to 400,000 otherwise. `tests/integration/settingsHistoryIpc.test.ts`: it is on the settings patch allow-list, and IPC refuses a value off the slider.
- `tests/integration/watcherTools.test.ts`: with the point at 250k, a resting Watcher at 300k is compacted; `read_state` and the room report the chosen point. Raised to 600k, a 500k conversation is left alone. Lowered to 450k, `settingsChanged` compacts it at once, Watcher being at rest. `restsForIdleCompaction` is true only for Watcher's current thread with no news queued, and a finished idle compaction owes Watcher its state.
- `tests/unit/main/idleCompaction.test.ts`: Watcher's conversation is due on the ordinary terms, the sweep compacts it only while Watcher rests and never without Watcher, and the guard asked at dispatch refuses once Watcher stops resting.

Not checked here: a live Claude Code Watcher going quiet for 54 minutes. The sweep and the guard are the ones ADR-0127 already runs for every Claude thread, and Watcher's thread reaches them through the same command.
