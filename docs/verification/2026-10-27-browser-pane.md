# Quiet browser pane verification

October 27, 2026, on `feat/browser-pane`, from `main` at d717248d4. This is ADR-0154's pane, behind the `quiet-browser` Owl feature. `tests/e2e/browser-pane.spec.ts` launched the built app on the Owl track (`onReleaseTrack('owl')`) over the fake Claude Code provider and a local page server, drove the thread's agent through `window.sottoE2E.browserAgent`, and ran with `SOTTO_E2E_EVIDENCE=publish`. Captures are the window's own pixels (`desktopCapturer` by window title), so the native page main draws is in them. The window's content was 1280x800 or 820x560; the captures are at the laptop's 150% scale. Every capture below was looked at. The numbers, including the strip's measured contrast, are in `artifacts/browser-pane/verification.json`.

## What the captures show

1. **The agent opens a page with Tools open** (`agent-1280x800-dark.png`, `agent-1280x800-light.png`): Tools was open on Files with focus outside it. The agent's `browser_open` turned Tools to Browser and its page, and the player did not float. Above the page is one row: Back, Forward, Reload, the address as host and path with the page's title muted after it, Screenshot to message and More. There is no tab line for one page, no grant line, no task line and no steps fold. After the agent clicked Save trail, the strip at the page's foot reads "Agent is browsing · clicked in the page" with Pause. Its dot is steady. The strip's text measured 16.0:1 and 7.8:1 in dark, and 14.7:1 and 6.3:1 in light. Main drew exactly one native view, at the pane's viewport.
2. **At the minimum** (`agent-820x560-dark.png`, `agent-820x560-light.png`): the row, the page and the strip fit in the panel. Nothing ran past it and the window did not scroll sideways. The page's title gives way first: the field shows the address alone rather than a single letter of the title.
3. **Paused** (`paused-1280x800-dark.png`): Pause in the strip paused the task. The strip reads "Browsing paused · clicked in the page", the dot is an empty ring, and the button is Resume.
4. **Screenshot to message** (`screenshot-to-message-1280x800-dark.png`): one press put the page in the thread's draft as browser feedback, with no comment step. The composer shows its picture and its feedback lines, and the status says "Added to the draft for Workshop". The draft held one attachment. The status shows for 1.6 seconds over the strip's middle, as Tools' status does on every surface.
5. **More** (`more-menu-1280x800-dark.png`, `more-menu-820x560-light.png`): New page, Close page, Open in system browser, Stop sharing and Float the browser over the thread; then the sizes, Fit the pane checked; then Ask before this thread uses the browser. While it is open the page steps aside (main drew no native view), and it fits above the panel's foot at 820x560. Escape closed it and gave focus back to More. Ask before this thread uses the browser ended the grant, and the item left the menu.
6. **Two pages** (`two-pages-1280x800-dark.png`): New page from More opened a second page, and the tabs went onto their own line above the row, with New page at its end. The agent's task was still working on the first page, and the player did not float over the thread while Tools showed the thread's browser.
7. **No page** (`empty-1280x800-dark.png`, `empty-1280x800-light.png`, `empty-820x560-light.png`): with both pages closed, the pane is the address field and the addresses this thread's browser opened this session, newest first.
8. **Tools closed** (`player-tools-closed-1280x800-dark.png`): with Tools closed, the agent's next page floated in the browser player as on stable, with its request waiting, since the grant had been ended. Allow once in the player answered it.

The unit tests in `tests/unit/renderer/tools/browserPane.test.tsx` cover the same behaviour, as well as stable keeping today's surface, a waiting request in the strip's place, and Tools not switching while focus is inside it or while **Show the browser when an agent opens a page** is off.

## Not checked here

- Reduced motion. The pane adds no animation, and its loading line under the row is steady rather than the stable toolbar's sweep. The spec checked that the strip's dot has no animation.
- 1600x1000. It is the wide layout, between the two sizes captured.
- A screen reader's reading of the strip and the request.
- macOS and Linux.
- `npm run design:verify`. Its baselines do not include Tools > Browser on either track, so nothing changed there.
