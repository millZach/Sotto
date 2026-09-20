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
