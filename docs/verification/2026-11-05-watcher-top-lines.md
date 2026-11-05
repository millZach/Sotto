# Watcher's top lines

Drake picked **B · One strip** on November 5, 2026, from [the prototype](../prototypes/watcher-top-lines-prototype.html), then confirmed it again after the prototype was checked with every count from one through six. The needs-you count now opens a list; machine activity shares its line where it fits. The header, conversation, empty state and handover are unchanged. The one scene change measures the combined strip, keeping its glyphs clear of both lines.

The old always-visible names wrapped at unrelated left edges, their underlines dominated the count, and the reasons lacked a stable place. The new list keeps each name, ring and reason on one row. Five names still show before the remaining count opens All threads. Every reason remains visible in a narrow pane. Machine names have no underline at rest. Spacing replaces the dot separators and the full-width rule.

A name still focuses its card in Watcher's conversation when present, or opens the thread beside Watcher at its request; Shift opens Threads. Closing that pane returns to the needs-you count. Escape closes the list and returns to the count. The remaining-count button stays mounted behind All threads so closing it returns focus there. Machine dialogs and their `data-host` anchors remain, as does the below-600px summary of healthy machines.

## Captures

[Before](../../artifacts/watcher-top-lines/before.png) is Drake's supplied macOS Owl screenshot, including their red box. The after frames use the real renderer bundle, its fonts, CSS and night-scene canvas, with a scratch preload bridge supplying deterministic thread and machine fixtures. Sotto was never launched. The screenshots are renderer verification, not evidence of a live provider session.

| Window | Dark | Light |
| --- | --- | --- |
| 1600×1000 | [After](../../artifacts/watcher-top-lines/after-dark-1600.png) | [After](../../artifacts/watcher-top-lines/after-light-1600.png) |
| 1280×800 | [After](../../artifacts/watcher-top-lines/after-dark-1280.png) | [After](../../artifacts/watcher-top-lines/after-light-1280.png) |
| 820×560 | [After](../../artifacts/watcher-top-lines/after-dark-820.png) | [After](../../artifacts/watcher-top-lines/after-light-820.png) |

The opened list: [dark](../../artifacts/watcher-top-lines/requests-dark-1600.png), [light](../../artifacts/watcher-top-lines/requests-light-1600.png). These use Sotto's default palette. Every built-in palette was also measured in both modes; the prototype includes the colours sampled from Drake's screenshot without assuming their saved theme name.

[Stress cases](../../artifacts/watcher-top-lines/stress-cases.png) shows dark on the left and light on the right, at 820×560. Rows: one waiter; two long, similar titles; seven waiters and the remaining count; failed turn and prototype mixed with questions and permissions; This computer plus three machines with one busy; no waiters; very long thread and machine names. [Beside at the minimum](../../artifacts/watcher-top-lines/beside-dark-820.png) shows the under-600px Watcher pane, where only the troubled machine remains named and three healthy machines are counted.

## Count review

The prototype now has a shared **Waiting: 1 · 2 · 3 · 4 · 5 · 6+** switch. Every count uses long, nearly identical titles. At six, each variant names five threads and shows “1 more”. Changing the case keeps the chosen count. Choosing a count while nothing waits restores the long-title case.

[Prototype, dark](../../artifacts/watcher-top-lines/prototype-counts-dark.png) and [prototype, light](../../artifacts/watcher-top-lines/prototype-counts-light.png) show the minimum 820×560 window. Columns are A, B with its list open, and C; rows are one through six waiting. All 108 combinations of three variants, six counts, three window sizes and two modes were rendered and inspected. Every row, reason and remaining count fits. A's open rows grow downwards; B's closed strip keeps its height; C's card grows and stacks its machines below the names in narrow rooms.

The renewed B pick was also checked in the real bundle: [dark](../../artifacts/watcher-top-lines/real-counts-dark.png) and [light](../../artifacts/watcher-top-lines/real-counts-light.png). Columns are 1600×1000, 1280×800 and 820×560; rows are one through six waiting. All 36 combinations passed the layout checks and were inspected. The app code needed no further change.

The prototype also passed 144 narrow-room layout checks across the six counts, all three variants, both modes, and the long-title, mixed-reason, four-machine and very-long-name cases. The mixed-reason renders at every count were inspected in both modes. A prototype-only Escape fix lets All threads close before the list behind it; focus returns to “1 more”, then to the needs-you count on the next Escape. Hover changes and reduced motion were checked again. The page had no script errors.

## References seen

The source images are kept outside the repository at `/tmp/watcher-top-lines-references/`; thumbnails and the complete comparison are in the prototype. There was no Mobbin tool available.

| App and screen | Source | What helped; what Sotto already did better |
| --- | --- | --- |
| Linear Inbox | [Linear docs](https://linear.app/docs/inbox) | Consistent row alignment and restrained metadata. Sotto needs fewer tabs, avatars and controls for this small strip. |
| GitHub notification row | [GitHub docs](https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/triaging-a-single-notification) | A stable place for the reason and a large row target. Sotto's direct route to the waiting card is shorter. |
| Vercel deployment status menu | [Vercel docs](https://vercel.com/docs/deployments/managing-deployments) | Small status marks beside words. Sotto's plain status avoids the extra capsules. |
| Cursor Agent queue | [Cursor docs](https://cursor.com/docs/agent/overview), frame at 3 seconds of its Agent queue video | Collapsed work leaves the room quiet. Sotto needs fewer nested borders and no duplicate headings. |
| VS Code Source Control | [VS Code docs](https://code.visualstudio.com/docs/sourcecontrol/overview) | Compact, readable rows and steady alignment. Sotto's explicit reasons need fewer icons and badges. |
| Things Today and projects | [Things product page](https://culturedcode.com/things/) | Calm spacing and light structure. Sotto's reason beside each thread explains the required action more directly. |

The real renders retain the references' useful alignment and quiet default state. The list appears only when asked for, with no extra heading or instruction. Two visual corrections followed inspection: let a machine name use spare width, then restore a small gap between its name and count. No palette was changed.

## Verification

- `npm ci --ignore-scripts` completed in this worktree before checks.
- `npm run i18n:extract` completed; it emitted existing extraction warnings for the unrelated terminal command comment constant. Its generated feature catalogs are included.
- `npm run typecheck` and `npm run lint` passed.
- Each unit file ran separately: `watcherView.test.tsx` (64), `watcherAsks.test.tsx` (18), `watcherMachines.test.tsx` (19), `checkQueueView.test.tsx` (8), and `interfaceCatalogs.test.ts` (4). All 113 tests passed. Node 25's storage shim initially prevented jsdom setup; reruns used `NODE_OPTIONS=--no-experimental-webstorage`. Old separator expectations and fixture-count assumptions were corrected before their files passed.
- `npm run build` completed without launching the app. Headless Playwright used the cached Chromium shell, with no Electron process.
- 43 layout cases passed: seven stress states at all three window sizes in both modes, plus the minimum window with a beside pane. No page overflow, clipped reason/count, or page error. The text's intended title ellipsis remains, with the complete title in its tooltip and accessible name.
- Escape and focus return were checked for the request list, remaining-count/All threads route and machine dialog. The inline-card route and Shift navigation are covered by the unit files. The `data-host` hooks remain in place for move suggestions.
- Reduced motion was checked in all seven built-in themes and both modes. The new list animation is absent with reduced motion.
- Contrast was computed from each text role's rendered sRGB and the pixels beneath its complete text box, including the night scene, in all seven built-in themes and both modes. Lowest: **6.73:1**, above 4.5:1. The list has its own opaque theme card surface. No theme tokens changed.
- `tests/e2e/watcher.spec.ts` was read and updated for the new opening and focus path; it was not run. No `npm test`, e2e spec, `design:capture`, or `design:verify` was run.

No committed design baseline covers Watcher's room. The capture suite's page, thread, appearance, widget and scaling specs and `artifacts/design/app-review/manifest.json` contain no Watcher capture. The Watcher e2e spec saves diagnostic screenshots; these are not the committed design gate. No baseline was regenerated.

## After review

Two request-list bugs were fixed before the separate review. Emptying the list now closes it, so a later request cannot reopen it unasked. Removing the focused row while others remain returns focus to the count. One regression test covers both updates without a pointer or focus event; it failed without the fixes.

The review found e2e steps pressing request rows while the list was closed. Those steps now open the list first, including the inline permission-card route. The keyboard journey checks the count in the collapsed Tab order, opens it with Enter, checks both rows, then closes with Escape and checks focus return. The contrast journey opens the requests before measuring their titles and reasons; the long-title check names the row by its accessible name. A search across every e2e file also found four scene measurements still treating the old needs-you line as a direct child. They now measure the combined strip, as the scene does. Every changed step was read against the real components; no e2e spec was run here.

The second finding reproduced in the real renderer with a 400px Watcher pane: a machine with 12 working threads, 3 waiting checks and “may slow down, busy, short on memory” left its name only 19px. Even “forge” became “fo…”. Warning words can now shrink and wrap, while a warned name keeps its width, capped at 30% of the row below 600px. In both modes, “forge” takes its full 29px; a long name keeps 106px and its complete tooltip. The count remains whole, all warning words fit on two lines, and the row has no overflow.

[Dark at 400px](../../artifacts/watcher-top-lines/machine-warning-dark-400.png) and [light at 400px](../../artifacts/watcher-top-lines/machine-warning-light-400.png) show the long-name case. All four combinations of short/long name and light/dark were rendered with reduced motion and inspected. The same warning and long name also fit at 1600×1000, 1280×800 and 820×560 in both modes, keeping the name's existing 230px cap. None of the ten renders overflowed or reported a page error. These frames use the same real-bundle headless method as the earlier captures. The supplied `before.png` is unchanged.

After these fixes, `npm run typecheck`, `npm run lint` and `npm run build` passed. Each unit file ran separately again: `watcherView.test.tsx` (65), `watcherAsks.test.tsx` (18), `watcherMachines.test.tsx` (19), `checkQueueView.test.tsx` (8), and `interfaceCatalogs.test.ts` (4): all 114 tests passed. No interface string or theme token changed in the review fixes. No full unit suite, e2e spec, design gate or hand test in the running app was run here; those remain for CI and hand verification.
