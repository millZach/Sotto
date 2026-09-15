# Issue 74: Windows layout and recovery regression lane

Scope: the three failures left in `2026-09-14-terminal-display.md`, on the existing Sotto Windows desktop at 1280x860, 1600x1000 and the shipped 820x560 minimum. The current Sotto sidecar is the reference: compact context and surface tabs, no redundant Tools rail, unchanged theme tokens and terminal fidelity. Physical microphone testing remains pending in #81; macOS is explicitly deferred by the user and unverified.

## Acceptance and current state

- [x] Working folder remains discoverable and copyable from the compact Tools header at normal and minimum sizes; no redundant path rail is restored.
- [x] Changes selection is wholly visible after resizing; the diff retains more than twice the list height and keyboard selection/closing remains usable.
- [x] Personal chat keeps at least 150 CSS px of transcript with the existing draft, skill, voice and send controls at 820x560; original disconnect/restart/default-change recovery completes.
- [x] Repeat original journeys, inspect dark/light captures, and preserve a small before/after set in `artifacts/issue-74-layout`.

Tastify target: desktop only, explicitly established by the task. Concept: a working conversation and its selected code stay readable while their controls remain within reach. Considered focuses: restore a path rail; let the diff dominate under compact folder controls; compress all conversation text. Chosen: the existing compact controls and full-size content, preserving the user's current design.

Scoped visual checks: retain Sotto typography and theme colors, reduce excess spacing before text size, retain named controls and full folder tooltips, show the selected file without cropping, and inspect the chat transcript/composer hierarchy in both modes. No copy or motion is added, so no new signature animation is applicable; existing keyboard feedback and reduced-motion behavior are retained. Count visible text purposes in the affected components, identify essential operating labels and state feedback individually, and ensure no new explanatory or decorative copy competes with the conversation or code.

## Diagnosis

Red command, run twice against the initial production build:

```powershell
npx playwright test tests/e2e/phase-three-ui.spec.ts tests/e2e/phase-three-ui-final-fixes.spec.ts --grep 'keeps the working folder|reviews changes|starts, continues' --workers=1 --output=test-results/issue74-layout
```

Both runs: 3 failed, consistently in the same assertions. Folder height was 1px instead of >30; selected row containment was false; personal transcript was 142.667px instead of >=150. The existing journeys reach the real AppShell/renderer/IPC and services using temporary owned profiles, fixture providers, real Git folders and terminal/browser services. No provider turn is paid or sent to an installed account.

Ranked predictions before instrumentation: (1) folder assertion expects the retired path rail, so rendered header plus source should show intentional accessible-only text and working title/copy actions; (2) the selected row exceeds the short list height, so matching list space to row height will remove clipping; (3) personal chat lacks the compact header spacing used by project panes, so reducing that padding/gap will restore reading space without clipping controls. Alternatives considered: selection scroll restoration timing and a hard transcript min-height conflict.

Instrumentation confirmed the list is 31px tall while its row is 34px tall (selected row top 236 versus list top 239.333). The resize observer cannot place a taller row wholly inside that box. Personal chat has a 112px header and 203.333px compose region, leaving 142.667px for reading. The folder text is deliberately styled as a 1px accessible-only element; its full value remains on directory action tooltips. Before captures were visually inspected. These are two real spacing regressions and one stale pre-sidecar assertion.

The first rebuilt run passed both original spacing assertions and reached three later assumptions previously hidden by early failures. The old 190px diff threshold predates Git actions and the comparison selector: the current minimum-window diff has 159.333px, enough for 6.8 full-size lines. The replacement requires six line-heights and more than twice the file-list height, checked against the rendered code rather than an obsolete chrome allocation. The unsupported-personal-provider case now uses OpenRouter: Claude is supported by the completed #69 work. A browser resize containment check now polls the same strict bounds because the native window resize event can arrive before the sidecar's ResizeObserver; a persistent overflow still fails. These test changes preserve the user-facing requirements rather than restoring retired UI or disabling provider support.

## Result

Production changes are eight lines of CSS: the compact Changes strip now allows 35px for its 34px row and border, and the personal-chat header uses a 2px gap and 6px block padding below 640px window height. Font sizes, title ordering, composer controls, theme colors and terminal rendering are unchanged.

Green command:

```powershell
npx playwright test tests/e2e/phase-three-ui.spec.ts tests/e2e/phase-three-ui-final-fixes.spec.ts tests/e2e/phase-three-ui-recovery.spec.ts --grep 'working-folder actions|reviews changes|starts, continues|explains a page|recovers a message' --workers=1 --output=test-results/issue74-layout
```

**5 passed in 30.2 seconds.** This includes keyboard Home/End selection inside the single-row Changes strip, restoring app.ts and closing its diff, real terminal input and local browser placement/menu/reduced-motion behavior, keyboard folder-path copy verified against the clipboard, personal-chat draft/skill persistence across disconnect/restart/default changes, a refused native browser page recovering after its working folder returns, and a failed personal message merged with a newer draft without a duplicate send. The final resend is explicit and accepted once the owned fixture can save again.

Rendered review caught the first capture occurring during diff loading after keyboard reselection. The test now waits for the actual added greeting before capture. Repeated `npx playwright test tests/e2e/phase-three-ui.spec.ts --grep 'reviews changes' --workers=1 --output=test-results/issue74-layout`: **1 passed in 9.7 seconds**, with refreshed dark/light code captures inspected. No empty/loading diff is used as final evidence.

`npm run build` passed. `npx eslint tests/e2e/phase-three-ui.spec.ts tests/e2e/phase-three-ui-final-fixes.spec.ts` passed. Scoped `git diff --check` passed. Temporary metric instrumentation was removed. Broader typecheck/tests and final integration are owned by the parent #74 lane.

## Rendered acceptance

The ten curated captures are in [artifacts/issue-74-layout](../../artifacts/issue-74-layout/). Three `before-*` files preserve the reproduced states. Reviewed final views:

- `after-changes-minimum-dark.png` and `after-changes-minimum-light.png`: complete selected-file focus border, filename, staging state and folder; loaded code shows the function signature and removed/added greeting. The diff has 159.333 CSS px, approximately 6.8 line-heights, and remains the largest region inside Changes. Scrolling exposes the remaining code. The short-list fix consumes only 4px more than before.
- `after-tools-tall-light.png`: compact context plus surface tabs, full-height code, visible keyboard focus on Copy, and the `Path copied` status. The full folder is verified on Copy/Reveal tooltips at both sizes; there is no restored path rail.
- `after-chat-minimum-dark.png`, `after-chat-minimum-light.png`, and `after-chat-tall-dark.png`: title and context retain their hierarchy; readable conversation precedes the composer. Minimum transcript height passes the unchanged 150px requirement. Full-size draft, skill insertion, send arrow, voice controls and usage state stay above the application footer. Normal desktop spacing remains unchanged.
- `after-chat-recovered-minimum.png`: the failure explanation and recovered status remain readable, the newer draft and restored message are both present, and Send stays accessible. The transcript scrolls independently as a longer composer grows.

Scoped text inventory at the minimum size: Tools header has six visible purposes (project, working-copy kind, four tool tabs); the selected-file row has four (status, filename, staging state, folder). Each is an operating label or state needed to select the right work. Personal-chat header has six (provider/model identity, project-free state, title, Make prompt, Refresh, Disconnect); the resting transcript shows three message content elements; its composer/voice/status area has nine (draft, model, conversation kind, Dictate, Talk, voice selection, token state, context state, estimate state). These are conversation content, operating controls and state feedback, not promotional/explanatory companions. Added decorative or explanatory text: zero. The repeated filename identifies both the selection and its open diff; the chat title identifies the saved chat while the transcript retains the user's actual message. No new repeated fact is introduced.

Typography and palette match the pre-fix Sotto reference. Existing 14px controls, 16px prompt text and 12px secondary text retain their sizes; the journey's smallest-visible-text check stays at >=12px. Changes theme fills and chat focus rings remain readable in dark/light; keyboard targets remain unchanged. The squint review keeps code/conversation dominant over chrome. The subject-specific working-copy controls and conversation input make the layout recognizably Sotto's workspace, with no generic landing-page sections or invented imagery. No animation was introduced; the existing browser/menu reduced-motion check passed in the full journey.

This completes the bounded Windows layout/recovery lane only. It does not claim macOS, physical microphone, packaged release, or the separate long-history performance gate. No commit, push, normal-app profile change, or installed-account conversation was made by this lane.
