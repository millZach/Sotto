# A thread uses the browser without asking, by default (ADR-0029)

Checked on September 25, 2026, on Windows, in the built app driven by `tests/e2e/agent-browser.spec.ts` against a local page server (`npm run build`, then `npx playwright test tests/e2e/agent-browser.spec.ts --workers=1`: 2 passed). Agent calls go through the e2e bridge into the same browser agent tools a provider reaches; answers are pressed in Tools the way a user presses them. The captures are in `artifacts/browser-grant/`, and `verification.json` holds the journey's checks. The native page is drawn by main over the window, so a renderer capture shows the pane dark where the page sits.

## Default on

- With **Let agents use the browser without asking** on, as it is out of the box, an agent's first `browser_open` in a thread returned at once with no pending request, and so did a click and typing on its page (`grantedByDefault`, `clickAndTypeWithoutAsking`).
- `grant-line.png`: Tools > Browser says *This thread uses the browser without asking · Stop*. The page opened shared, as Open and share shares it.

## Stop, and allowing again

- **Stop** took the line away. The thread's next open waited for an answer, and a click after it did too (`stopAsksAgain`).
- `request-card.png` and `request-card-820x560-light.png`: the waiting request offers **Allow once**, **Allow this thread to use the browser** and **Deny**, for an open and for a click alike. At the minimum window, in light, the three stay inside the panel.
- `grant-line-restored.png`: **Allow this thread to use the browser** ran the waiting action and brought the line back (`threadWideAnswerRestoresGrant`).

## The setting

- `settings-switch-grant.png`: the switch in Settings > Application, with its sentence about clicking and typing and where to stop it for one thread.
- With it off, another thread's open waited for an answer (`settingOffAsksOtherThread`). The first journey in the spec runs with it off throughout, so the one-time answers of ADR-0020 are still proven: **Allow once**, **Deny**, sharing and Stop sharing.

## Unchanged and still checked

- The corner preview checks moved with it: step 1 replaced the preview with the browser player, and `2026-09-25-browser-player.md` records them. A waiting request marks the Tools icon (`toolsIconMarkedWaiting`).
- The Settings > Application design baseline (`artifacts/design/app-review/baseline/settings-application-privacy.png` and `-light.png`) was regenerated for the new switch row; nothing else in it changed.

## Unchecked

- A provider's own turn reaching the grant: the journey uses the e2e bridge. The provider path to the same tools is covered by `docs/verification/2026-09-25-browser-prompts-and-computer-use.md`.
- macOS.
