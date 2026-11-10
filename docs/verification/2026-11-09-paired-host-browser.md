# A paired host's thread browses in the host's own Chromium

November 9, 2026. Issue #212, part 5 of [the plan](../plans/2026-11-08-paired-host-browser.md), [ADR-0198](../adr/0198-a-paired-hosts-thread-browses-in-the-hosts-own-chromium.md). Owl only, behind `paired-host-browser` and `quiet-browser`.

## What was run

`tests/e2e/paired-host-browser.spec.ts`, on forge under `xvfb-run -a -s "-screen 0 1920x1200x24"`, after `npm run build`. The journey runs a real headless host in the test's own process with the fixture Codex provider, and pairs the built app to it over the real socket, router, preload and renderer (the e2e harness skips only SSH). forge's own Chromium (`/usr/bin/chromium`) plays the host's browser. A loopback server in the test serves a sign-in page at `http://localhost:<port>/`, which is the host's localhost, as a dev server the agent started there would be.

It passed (`SOTTO_E2E_EVIDENCE=publish`, screenshots in [`artifacts/paired-host-browser/`](../../artifacts/paired-host-browser/)):

1. The host gives its thread the six browser tools and nothing of either iPhone. The agent's `browser_open` for the host's localhost runs without asking, with **Let agents use the browser without asking** on.
2. Tools > Browser shows the host's page drawn from its pictures, with "on Forge" after the address, and neither **Point at something** nor **Screenshot to message** in the row. The browsing strip says the agent went to the page. [pane-dark-1280.png](../../artifacts/paired-host-browser/pane-dark-1280.png)
3. A click in the picture and typing go to the page on the host: its field fills, its title changes to "Typed forge", and the row shows the new title. The agent's `browser_pages` reads the same title. [pane-typed-dark-1280.png](../../artifacts/paired-host-browser/pane-typed-dark-1280.png)
4. Light, and the 820 by 560 window: the page lays out again at the smaller pane, and the next picture is drawn at its size. [pane-light-1280.png](../../artifacts/paired-host-browser/pane-light-1280.png), [pane-light-820.png](../../artifacts/paired-host-browser/pane-light-820.png)
5. **Float the browser over the thread** floats the host's page in the browser player, drawn from its pictures at the player's size. [player-dark-1280.png](../../artifacts/paired-host-browser/player-dark-1280.png)
6. With the connection dropped, the pane keeps the last picture, greyed, and says "Reconnecting to Forge. The page stays open there, and the agent keeps browsing." When the connection is back, the reconnecting line goes and the page shows again. [pane-reconnecting-dark-1280.png](../../artifacts/paired-host-browser/pane-reconnecting-dark-1280.png)

## What the journey does not show

- **Open in system browser** swaps `localhost` for the host's address in main and opens the system browser. Unit tests cover the swap and the routing (`hostPageView.test.tsx`, `toolsIpc.test.ts`); the journey doesn't open a system browser.
- The older-host message and a host with no browser are covered by unit tests (`hostPageView.test.tsx`, `hostBrowserService.test.ts`), not here.
- A waiting request answered from the pane uses the same strip and answers as a thread here, and the protocol tests cover who may answer (`socketHostBrowser.test.ts`). The journey runs with the setting on, so nothing waits.
- Windows and macOS: the journey ran on forge (Linux) only. Linux checks are verification notes rather than capture baselines (ADR-0062).

## Hand test owed

On the next Owl, on Zach's laptop with forge paired:

- [ ] Start a dev server in a forge thread and let its agent open it. The page shows in Tools > Browser with "on forge", and clicking and typing reach it.
- [ ] Turn off **Let agents use the browser without asking** on the laptop. The next page a forge thread opens waits for Allow once, **Allow this thread to use the browser** or Deny on the laptop.
- [ ] **Open in system browser** on a forge page opens it at forge's tailnet name.
