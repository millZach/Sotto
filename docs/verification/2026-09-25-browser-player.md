# A thread's browser stays in its thread, in a floating player (#331)

Checked on September 25, 2026, on Windows, in the built app. `tests/e2e/agent-browser.spec.ts` and `tests/e2e/tools-sidecar.spec.ts` drive it (`npm run build`, then `npx playwright test tests/e2e/agent-browser.spec.ts tests/e2e/tools-sidecar.spec.ts --workers=1`). Agent calls go through the e2e bridge into the same browser tools a provider reaches. The player's own captures are in `artifacts/thread-browser-player/`; the journey's captures and checks are in `artifacts/browser-grant/`. The design is variant a of the prototype on `prototype/thread-browser-player`, made smaller and movable anywhere in Sotto.

## The player

- `player-1280x800-dark.png`: an agent in Workshop opens a page and Workshop's player opens above the composer, 340 by 250, with the live page in its frame. The title bar names the page and its host and offers **Move into Tools**, **Shrink** and **Hide**. The footer shows the current action with **Pause** and the grant line, *Uses the browser without asking · Stop*.
- `player-waiting-request-1280x800-dark.png`: with the grant stopped, a waiting request sits in the footer in one row, **Allow once**, **Allow this thread** and **Deny**, and a strip of the page stays in view.
- `player-pill-1280x800-dark.png`: **Shrink** leaves a pill at the player's own corner with the current action; pressing it brings the player back.
- `player-820x560-light.png`: at the minimum window, in light, nothing is clipped and the player stays inside the window.
- `player-reduced-motion-1280x800-dark.png`: with reduced motion the player arrives without animation.

## It stays in its thread

- `focused-thread-player.png`: while Docs has a waiting request, Workshop, the focused thread, shows its own player and not Docs' (`otherThreadPlayerHidden`). Focusing another thread draws neither Workshop's player nor its page, and going back brings both back (`focusSwitchHidesPlayerAndPage`).
- Opening a task in Tools no longer pins the Tools panel, so Tools follows the focused thread afterwards; only the pin control pins. The Tools icon's dot counts only its own pane's thread.
- `settings-switch-auto-show.png` and `auto-show-off-tools.png`: with **Show the browser when an agent opens a page** off, a new task does not open a player, and the work still shows in Tools > Browser (`autoShowOffHidden`).

## Unchecked

- Dragging with a pointer and resizing from the corner in the running app: the placement rules (clamping inside the window, below the drag strip, the minimum size, arrow-key moves, one placement for every thread) are covered by `tests/unit/renderer/tools/browserPlayerStore.test.ts`.
- The 1600x1000 size, and macOS.
