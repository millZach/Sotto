# A thread's browser stays in its thread, in a floating player (#331)

Checked on September 25, 2026, on Windows, in the built app. `tests/e2e/agent-browser.spec.ts`, `tests/e2e/tools-sidecar.spec.ts` and `tests/e2e/agent-browser-player-controls.spec.ts` drive it (`npm run build`, then `npx playwright test tests/e2e/agent-browser.spec.ts tests/e2e/tools-sidecar.spec.ts tests/e2e/agent-browser-player-controls.spec.ts --workers=1`). Agent calls go through the e2e bridge into the same browser tools a provider reaches. The player's own captures are in `artifacts/thread-browser-player/`; the journey's captures and checks are in `artifacts/browser-grant/`. The design is variant a of the prototype on `prototype/thread-browser-player`, made smaller and movable anywhere in Sotto.

This note also covers the two-axis review fixes made afterward: a keyboard path for the corner resize, focus handed on from Shrink and Hide, one placement default so the first corner resize never jumps, a named drag bar, the way back to the player from Tools, the two-axis review's own message and evidence gaps, disabling the request buttons in flight, and a per-thread record of every task ever shown so a late update to an old task cannot reopen a hidden player.

## The player

- `player-1280x800-dark.png`: an agent in Workshop opens a page and Workshop's player opens above the composer, 340 by 250, with the live page in its frame. The title bar names the page and its host and offers **Move into Tools**, **Shrink** and **Hide**. The footer shows the current action with **Pause** and the grant line, *Uses the browser without asking · Stop*.
- `player-waiting-request-1280x800-dark.png`: with the grant stopped, a waiting request sits in the footer in one row, **Allow once**, **Allow this thread** and **Deny**, and a strip of the page stays in view. `tests/unit/renderer/tools/browserReview.test.tsx` covers the buttons disabling while the task is paused or an answer is in flight, matching `BrowserTaskDetails.tsx`.
- `player-pill-1280x800-dark.png`: **Shrink** leaves a pill at the player's own corner with the current action; pressing it brings the player back. Shrink and Hide now hand focus on themselves (to the pill, and to the composer) rather than dropping it, covered by `browserReview.test.tsx`.
- `player-820x560-light.png`: at the minimum window, in light, nothing is clipped and the player stays inside the window.
- `player-reduced-motion-1280x800-dark.png`: with reduced motion the player arrives without animation.
- `player-1600x1000-dark.png`: the player at the largest of the three verified widths, in dark, with the corner grip's own focus ring visible after a keyboard resize; nothing is clipped.

## Keyboard and pointer, moving and resizing

- The drag bar is a named `group` (`aria-roledescription="drag handle"`, "Move the browser. Drag, or use the arrow keys…"), not an unnamed div; the corner grip is focusable, named ("Resize the browser. Use the arrow keys…") and resizes with the arrow keys (16px steps, 64px with Shift), the wrong `aria-orientation` removed. Both are covered by `tests/unit/renderer/tools/browserReview.test.tsx` and driven with real keyboard input in `agent-browser-player-controls.spec.ts`.
- `agent-browser-player-controls.spec.ts` also drags the title bar and resizes from the corner with the mouse in the running app: the player moves or grows, stays inside the window and below the drag strip, and the very first corner resize does not jump (the top-left corner stays exactly where it was drawn). The store now has one default placement (pane-anchored) instead of two disagreeing ones, and resize builds from the rectangle actually on screen, the way the arrow-key move already did; `BrowserPlayerStore.move()`/`resize()` are gone, since only tests called them, in favour of the same `setRect` the player itself uses (`tests/unit/renderer/tools/browserPlayerStore.test.ts`).

## The way back, both directions

- Tools > Browser offers **Float the browser over the thread** when it shows the focused thread's own task: it closes Tools and restores the player, without pinning (`tests/unit/renderer/tools/browserSurface.test.tsx`).
- `webLinks.tsx`'s fallback message now tells apart being pinned elsewhere (the page opened here; unpin to see it) from an unfocused pane's click (open Tools > Browser in that thread), covered by `tests/unit/renderer/tools/browserSurface.test.tsx`.

## It stays in its thread

- `focused-thread-player.png`: while Docs has a waiting request, Workshop, the focused thread, shows its own player and not Docs' (`otherThreadPlayerHidden`). Focusing another thread draws neither Workshop's player nor its page, and going back brings both back (`focusSwitchHidesPlayerAndPage`).
- Opening a task in Tools no longer pins the Tools panel, so Tools follows the focused thread afterwards; only the pin control pins. The Tools icon's dot counts only its own pane's thread.
- `settings-switch-auto-show.png` and `auto-show-off-tools.png`: with **Show the browser when an agent opens a page** off, a new task does not open a player, and the work still shows in Tools > Browser (`autoShowOffHidden`).
- A hidden player no longer reopens when an older, already-seen task gets a late update and becomes the thread's newest again: `BrowserPlayerStore` now keeps every task ID a thread has ever shown, not just the last one (`tests/unit/renderer/tools/browserPlayerStore.test.ts`).

## Unchecked

- macOS.
