# The test iPhone in the running app

October 3, 2026, on Windows 11 with Electron 43, from `tests/e2e/agent-iphone.spec.ts` against the built app (ADR-0045). The fake Workshop thread is driven through the same `sotto_browser` dispatcher a provider reaches, with **Let agents use the browser without asking** left on, as a user first meets it. The served page is a small phone app: a field, a button that records a touch, and a list taller than the screen.

## What was shown

- **`iphone_open` opens the thread's phone and floats it.** The phone player appears for the focused thread, and the Browser player does not: the phone's task floats only in the phone player.
- **The page lays out as an iPhone.** Inside the page, `innerWidth` is 393 and the user agent names an iPhone. The native view sits exactly on the player's screen rectangle. Its zoom factor is the screen's width over 393, at every window size.
- **An agent's tap, typing, key press and swipe reach the page.** A tap focused the field, `type` entered "Read 20 pages", `key` Enter added it to the list, and a tap on the button fired `touchend`. A swipe from (200, 700) to (200, 300) scrolled the list. A screenshot came back 393 by 852. None of them asked, under the default grant, and the steps say "Not asked".
- **Tools > iPhone holds the controls.** **Show in Tools** opens it on iPhone, with the grant line ("uses the browser and test iPhone without asking"), the address of the web build, **Runs as** saying it is not iOS, the sharing state, and the eight recorded steps.
- **Both stay inside the window** at 1600x1000, 1280x800 and the 820x560 minimum, in light and dark. The Tools rail, now seven surfaces, does not overflow at the minimum.
- **Escape hides the phone** and takes its page off the window. The agent's task keeps working, and `browser_finish` completes it afterwards.

## Fixed while proving it

- The phone player was rendered beside the Tools panel in its column. The panel's own measure counted it, so the panel flipped between docked and overlay on every frame. `workspaceArea` now skips the phone player, as it already skipped the Browser player.
- At 820x560 the player ran 16 pixels off the bottom, because the status below the phone was taller than assumed. The player now measures its own label and status, and shrinks the phone to fit.
- The label's icon buttons drew the browser's default border, since the Tools panel's reset does not reach outside the panel. They now carry it themselves.

## Captures

In `artifacts/test-iphone/`, which `.gitignore` keeps out of a run's commit; these seven are added by hand:

- `phone-over-thread.png`: the phone player over the Workshop thread at 1280x800, dark, after the agent's steps.
- `tools-1600x1000-dark.png`, `tools-1600x1000-light.png`, `tools-1280x800-dark.png`, `tools-1280x800-light.png`, `tools-820x560-dark.png` and `tools-820x560-light.png`: the phone player beside Tools > iPhone at each size and theme.

## Not shown here

- The permission path with the setting off is the browser's own, covered by `tests/unit/main/testIphone.test.ts`: a tap and a key press wait with "Tap at … on the test iPhone" and "Press Enter …", and a swipe never asks.
- No real provider ran a turn against the phone; that is `SOTTO_*_LIVE` territory, and the tool definitions reach each provider the way the browser's do (`tests/integration/browserProviders.test.ts`).
- A native iOS app is phase 2 (ADR-0047).
