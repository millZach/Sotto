# Shell and detail batching while hidden

PR #159 keeps the shell and the open thread's detail in one React commit when they arrive in that order before a frame. The review fix preserves that optimization for visible windows and processes shells immediately while the main window is hidden. Hiding the window also flushes a shell already waiting for its frame.

The failure was a microphone mute from the floating widget while main was hidden: the widget received its command response, but the main renderer held the published shell for an animation frame Electron could suspend. Its voice controller did not see the mute until another update arrived or the main window was shown.

## Regression and neighboring behavior

Three deterministic regression tests were run before the fix and failed: mute delivery with suspended frames, flushing on hide, and visibility-listener cleanup. With the fix, `agentShellAssembly.test.tsx` and `shellDetailCommits.perf.test.tsx` pass all 16 tests. They also cover command-response ordering, history assembly, standalone shells and one commit per production-order chunk.

The performance fixture now finishes each chunk's frame before sending the next chunk. It asserts one commit for shell-first delivery and two for isolated detail-first delivery, which is not the order main sends. The performance note reports both numbers directly.

## Running application

Built with `npm run build` after merging main at a25f0c94. `npx playwright test tests/e2e/agentVoice.spec.ts` passes the existing voice journey, including prompt retention, wake/listen transitions, widget dictation and microphone controls.

A separate native Electron probe uses the same built application with a temporary E2E profile and deterministic microphone/provider adapters. It connects over CDP with `noDefaults: true`: Playwright's ordinary Electron launch forces focus emulation and reports `document.hidden === false` even after the native window is hidden, so it cannot demonstrate this failure directly.

The native probe activates voice management, hides main through `window.sotto.hideApp()`, verifies `document.hidden === true`, clicks the widget's microphone control and observes the real main-renderer voice controller report `wake` to `muted`. Unmute returns it to `wake`, with main still hidden. The captured widget was visually inspected.

- Probe: `artifacts/shell-detail-visibility/native-journey.cjs`
- Capture: `artifacts/shell-detail-visibility/widget-main-hidden.png`
- Probe command: `node artifacts/shell-detail-visibility/native-journey.cjs`

These artifacts are ignored locally. No real microphone, live provider, speech service or macOS acceptance was exercised. This fix does not change the voice beta gate or the visible design.

## Browser placement during panel animation

Combined native verification also exposed a placement burst: every changed animation frame could start another browser mount while main was still checking the previous mount's working folder. The shared Files service admits four concurrent requests, so a transient busy result could leave the browser waiting for explicit retry after closing and reopening the tools panel.

Browser placement now keeps one non-null request in flight and remembers only the latest desired rectangle. Hides still go through immediately. Changing pages first hides the previous desired page, which invalidates its pending main-process mount before a queued replacement can be canceled. A genuine refusal still requires the existing explicit retry; workspace validation and service admission limits are unchanged.

Three deferred-bridge regressions failed before the change. Five tests now cover latest-only rectangles, returning to an earlier rectangle, immediate hide, stale hides, and closing a queued replacement before the old page's validation completes. Two older late-refusal tests were updated to resolve the pending placement before expecting the newer one to be admitted. The browser renderer and main lifecycle suites pass all 20 tests.

`npm run build` and `npx playwright test tests/e2e/tools-sidecar.spec.ts --workers=1` pass with the combined changes. The native scenario checks browser placement, close/reopen, terminal input, Files, Changes, light/dark appearance and three window sizes. This does not establish that PR #159 introduced the original busy condition: its isolated native run and two repeats passed; another repeat failed earlier at terminal input rather than browser placement.

## Recovering the working folder after checkout setup

The Windows gate exposed a thread with a ready worktree and a successful native send but no recorded `workingDirectory`. A deterministic Grok regression reproduces that state by failing one folder read after Git creates the nested-project checkout. The next folder read recovers the checkout, but previously only saved its worktree metadata; the native send used the correct reconstructed folder while the saved thread kept an undefined directory.

Recovery now fills the missing directory from the verified worktree before publishing and saving. An established directory is preserved. Both the metadata write and the final folder resolution read the current thread after asynchronous verification, so a provider snapshot cannot leave them using an older thread object. The regression checks the native process's file in the correct nested folder, the thread metadata and its value after restarting the workspace. The failure was reproduced before the fix and the targeted regression passes afterward; no acknowledgement deadline was changed.

A second deterministic regression holds an older shared-folder inspection while the user chooses an independent working copy. The old result initially overwrote that choice. Recovery now applies only while the captured worktree record is still current, checked after each verification await; the pending independent choice survives.
