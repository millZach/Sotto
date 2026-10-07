# Hidden players during composer edits

This follow-up preserves the original typing fix in PR #330 and the player appearance. It removes background work while the browser and phone players are hidden; it does not establish end-to-end typing latency in the installed app.

The hidden phone player used to observe mutations across the document and scan overlays during composer edits. Its overlay observer and animation-frame loop now exist only while its player is shown. Browser pane placement and phone position are measured only when drawing their players. Task subscriptions stay active, so new browser and phone tasks can still open their players.

Native content stays unmounted until the overlay hook checks the document. A hidden player resets to unchecked before reopening, preventing a native mount underneath an existing dialog. Renderer regressions check the absence of hidden geometry work and overlay scans, active subscriptions, and initial/reopened dialog mount ordering. The Electron composer regression types into the real composer and checks zero overlay scans.

The PR review identified that the initial covered state could show the notice before any overlay had been found. The hook now distinguishes unchecked from covered: it returns undefined until the passive scan, and all three native placement callers mount only when coverage is explicitly false. The notice appears only for confirmed coverage. This preserves passive scan and mount scheduling. A renderer regression observes the actual docked viewport during its placement layout effect: the first commit requests no native mount and contains no false notice, then mounts after the scan. The regression fails with the old initial covered state. It proves committed DOM ordering, rather than a recorded physical first paint.

The previously selected lifecycle prototype remains on `prototype/dormant-player-lifecycle`, commit `0b7033d9`, at `docs/prototypes/dormant-player-lifecycle.html`. Its hidden, shown and covered states establish unchanged appearance and active task subscriptions as constraints.

## Verification

Based on current `origin/main`, `0b0145a7`. The targeted browser and phone renderer tests passed: 2 files, 46 tests. `npm run build` passed. Typecheck, lint and third-party notices passed (174 components). Lint was repeated after adding the evidence folder. `npm test -- --maxWorkers=2` passed: 544 files passed, 40 skipped; 7,432 tests passed, 156 skipped, in 982.42 seconds.

Nine distinct Electron journeys passed across `composer-hidden-players`, `composer-typing-styles`, `composer-short-window`, `agent-browser-player-controls`, `agent-browser`, `agent-iphone` and `cloud-iphone`. The first batch passed 8/9: the layout fixture reopened its queued thread by the obsolete name Docs after automatic title generation renamed it to Start the long job. Diagnostic DOM output proved that cause. The layout fixture now turns off thread titles so its fixed-name navigation remains valid; both original short-window scenarios passed afterward. No timeout or layout assertion was weakened. This e2e-only setup change was made while Vitest ran; e2e files are excluded from that suite. Production and unit-test source stayed fixed.

Tracked capture bytes were preserved and restored around the Electron batch; no existing evidence was overwritten.

The existing browser window-resize blank-page issue remains outside this change. The browser control regression checks actual native content after moving and resizing the player, before resizing the application window. Its later layout checks do not prove native content survives window resizing.

Operation counts prove removed work, not a subjective latency improvement. The installed user profile and macOS remain unverified by these synthetic Windows tests. No appearance baselines are regenerated.

## Review correction checks

After distinguishing unchecked coverage, typecheck, lint and build passed. Targeted browser, phone and cloud-player renderer tests passed: 3 files, 43 tests. These retain the initial/reopened existing-dialog mount checks and hidden observer dormancy checks, and add the first committed viewport regression. The final rebuilt Electron batch passed all three journeys: `composer-hidden-players`, `agent-browser-player-controls` and `agent-iphone`. The iPhone journey covers native web interactions and light/dark at all three window sizes. The minimum dark phone capture was visually inspected; its content and controls fit. Tracked capture bytes were restored afterward.

An earlier local attempt moved the scan into a layout effect. Its first Electron batch passed browser controls and composer edits, but its phone capture returned 390 by 843 rather than 393 by 852. An isolated retry with that attempt, an isolated comparison with the original passive hook, and its repeated combined batch all passed unchanged assertions. This single mismatch remains unexplained; those passes do not establish that it predates the attempt. Capture dimensions come from Chromium's CSS visual viewport, while player placement sets native bounds and page zoom separately. The tests wait for bounds; capture reads metrics after debugger readiness without a viewport/zoom settlement check. The final correction retains the original passive scheduling to avoid introducing that timing change. No screenshot assertion or deadline was weakened.

The earlier full-suite result above belongs to `4bcc1d5e`, before this review correction. The full suite was not rerun locally for this overlay follow-up; CI must verify the final pushed revision before merge.

## Native input check

A fresh official Codex app server, using GPT-6.1-Sol and the Computer Use skill, selected the isolated synthetic Sotto window, clicked the thread and composer, typed an unsent draft, pressed End, added one letter and removed it with Backspace. A read-only renderer audit observed the exact final draft, 3 input events, 5 keydown events, zero overlay scans and no shown players. Input-event-to-next-animation-frame samples were 4.4, 4.3 and 3.5 ms; these are not physical key-to-paint measurements. Native accessibility sometimes reported document focus or a value one capture behind, so the final draft was verified through the DOM and screenshot. This did not use the installed personal profile.

The parent inspected [the native composer capture at 1280x800](../../artifacts/hidden-player-typing/composer-native-1280x800.png): the unsent draft and controls fit. No native macOS check was performed.
