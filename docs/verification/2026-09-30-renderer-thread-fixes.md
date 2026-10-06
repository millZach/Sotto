# Renderer thread fixes

Issues #593, #594 and #599; package pkg-41. Verified on Windows with fixture providers. No live provider, microphone or native macOS claim is made.

## Behavior

- Pane zoom checks the dictation hotkey. A conflict removes the handler, tooltip hint and accessibility shortcut; the button still zooms. Unit tests cover Windows, macOS accelerator interpretation and settings changes.
- Incoming thread snapshots prune departed transient answers, including threads without an open pane and removed threads. Structured answers are retired from the renderer only after main reports no matching saved draft, queued loads and writes settle, and the saved revision remains unchanged. Unsaved and retained drafts remain recoverable. Regression cases cover reused IDs and delayed submission and delivery-check replies.
- Diagram palettes publish after 150 ms without another theme mutation. Initial drawings remain immediate. Tests use controlled clocks to check multiple consumers, the final color, inspector probes and unmount cleanup.

The pane zoom behavior study is retained locally on `prototype/bh-41-pane-zoom`, commit `98ef11bf5cf0015201285bc8decd491d4e145b86`, as `artifacts/crossing/pkg-41-behavior-prototype.html`. It studies shortcut ownership, with the existing app appearance retained. Browser inspection of that local HTML was unavailable because the browser tool refused the file URL; the real Electron journeys and captures below are the rendered evidence.

## Rendered evidence

These captures were inspected. The generated folder is covered by the existing `artifacts/review-*/` ignore rules in `.gitignore` and `eslint.config.mjs`; only the images cited here are retained.

- [Split panes in the actual app](../../artifacts/review-pkg-41/split-dark.png): independent drafts and controls at 1600x1000.
- [Questions at the minimum window size](../../artifacts/review-pkg-41/questions-820x560-light.png): the question scrolls inside its panel and Send answer and the separate message draft remain reachable.
- [Dark diagram](../../artifacts/review-pkg-41/diagram-dark.png) and [light diagram](../../artifacts/review-pkg-41/diagram-light.png): the drawing and its labels remain readable. These use the older rich-message fixture, whose sidebar does not match the current app; they establish the diagram rendering, not the main-window layout.

## Known fixture limitation

The rich-diagram minimum-width journey (`rich-diagrams.spec.ts:410`) reports 23 pixels of transcript overflow. It also reports exactly 23 pixels when built with the original palette source from base commit `f733984746ecd642fe8eaadf0594786e990e57ac`. The comparison loaded that original module through a temporary Vite plugin in this worktree; no source in the main checkout was touched. This batch changes no diagram dimensions or layout styles. The separate reduced-motion journey is run independently because the fixture suite is serial and stops after this failure.

The first permission journey run reached its final outbox assertion before the persisted answer receipt was removed. It passed when rerun alone. No assertion or deadline was weakened.

## Review

The standards and issue-spec reviews were run separately with the code-review skill. The spec review identified retained structured bindings and delayed-reply races; all were fixed and covered by regression tests. Both final reviews reported no remaining findings. README, CONTEXT and the ADRs still describe the same product behavior and authority; the guide adds the shortcut conflict and delayed diagram-color behavior.

A later PR review found same-ID question replacement without an intervening empty snapshot. The A → B → A regression reproduced the stale `sent` phase with the original ID-only pruning API. Snapshot pruning now compares the original question definition as well as its ID, while unchanged forms keep their phase and retirement still requires main to confirm the saved draft is gone. Both review axes checked this follow-up and reported no remaining findings.
