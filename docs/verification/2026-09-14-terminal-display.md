# Terminal display fidelity

Baseline: `722bd63`. The user compared Claude Code in Windows Terminal with Sotto: Sotto lost the orange logo, gray secondary text and yellow mode line, and split block artwork and prompt rules into disconnected glyphs.

## Diagnosis and fix

Two independent failures were reproduced in the actual running app:

1. Sotto inherited `NO_COLOR=1` from its launcher and passed it to interactive shells. Claude emitted no application color sequences. Removing only that variable and restarting the probe's Claude restored its RGB escape sequences and colored output. New terminal processes now clear inherited color-policy overrides and advertise `TERM=xterm-256color`, `COLORTERM=truecolor`, and `TERM_PROGRAM=Sotto`. Shell profiles still run afterward and can customize these values. Unrelated environment variables and the original environment object remain intact; Windows aliases are handled case-insensitively.
2. The DOM renderer used font glyphs with extra line spacing for block artwork. A three-row block-grid pixel probe through the real terminal view measured only 82.1% orange coverage inside the intended solid rectangle. The WebGL renderer's cell-aligned glyphs produce 100% coverage. `@xterm/addon-webgl` 0.19.0 and the existing xterm 6.0.0 have the same npm `gitHead` (`f447274`), matching the [xterm 6 release](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0). The [xterm options documentation](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/#optional-customglyphs) explains why font-only DOM rendering does not provide continuous custom glyphs.

GPU rendering starts when the view mounts and releases when it hides, preserving the same terminal buffer. Initialization failure or context loss restores the DOM renderer so input and output remain usable. Terminal text has a 4.5:1 minimum contrast ratio, keeping CLI text readable on light themes while retaining solid block colors.

## Acceptance and evidence

The reference and target are the user's Windows desktop screenshots. The selected approach is faithful terminal cell rendering, rather than changing the CLI or replacing its artwork. Existing Sotto chrome, typography size, input behavior and layout remain intact. No app copy, decorative imagery or new motion was added; the visible terminal text belongs to the CLI.

- **37 focused unit tests passed:** terminal service, view theme/lifecycle, terminal surface and Tools panel. The environment regression failed before the fix. Tests cover injected-environment immutability, platform casing, GPU failure, context loss and buffer-preserving remount.
- **Four relevant native Electron E2E tests passed:** sidecar workflow; the new color/grid test; DOM fallback selection/theme/contrast; DOM fallback theme gallery/editor/reduced-motion controls. The final selection test was rerun after adjusting its expectation for the new contrast floor.
- The new native test uses a real PTY and Node's TTY color detection (`COLOR_DEPTH=24`), RGB and indexed/ANSI color output, block/box glyphs, 1280x800 and 820x560 windows in dark/light themes, close/reopen, and forced `WEBGL_lose_context` followed by keyboard interruption. It does not invoke a paid model.
- Typecheck, ESLint and production build passed.
- A separate read-only critic found no concrete production regressions; its suggested real GPU-loss probe was then added and passed.
- Root visually inspected the normal dark grid, narrow light grid and real Claude in both themes. Block artwork is contiguous, prompt rules are continuous, secondary text and mode colors are legible, and controls remain usable. Captures are in [artifacts/terminal-display](../../artifacts/terminal-display/).
- The live `test` thread has Claude open in the updated terminal. The original appearance preference was restored after capturing both themes. Only the task's earlier interrupted probe was removed; the user's original terminal record was preserved.

## Broader check limitations

The exploratory run of older Phase 3 suites also encountered three failures outside the terminal behavior changed here: a tall-window working-folder wrap assertion, selected-file containment in the short-window Changes list (before the test reaches Terminal), and a 150px minimum personal-chat transcript assertion (observed 142.7px). These remained unresolved at the end of this terminal work; this work does not claim the entire historical UI suite is green. Terminal-specific stale tab-order/settings-navigation/renderer selectors were updated. The subsequent [issue 74 layout lane](issue-74-layout.md) resolved the two spacing regressions and replaced the retired path-rail assertion with the current folder-action checks; its five focused Windows journeys passed.

This verifies the Windows development app and native automated fixtures. No new installer, push, merge or microphone test is included. The pixel-grid and TTY-capability regressions cover the gap that plain-text echo smoke tests previously missed.
