# The browser grant shares every page in the thread (ADR-0029, October 5 amendment)

Checked on October 5, 2026, on Windows, in the built app driven by `tests/e2e/agent-browser.spec.ts` against a local page server (`npm run build`, then `npx playwright test tests/e2e/agent-browser.spec.ts`: 3 passed). The new journey is the third test. Agent calls go through the e2e bridge into the same browser agent tools a provider reaches, and the page is opened, addressed and shared in Tools the way a user does it. The captures are in `artifacts/browser-grant/`, and `sharing-verification.json` holds the journey's checks. The native page is drawn by main over the window, so a renderer capture shows the pane dark where the page sits.

## A page the user opens

- With **Let agents use the browser without asking** on, as it is out of the box, a page typed into **Address for a new page** opened shared: its Share button was pressed, and the agent's `browser_pages` listed it as shared with nothing pressed first. `browser_start` and an `inspect` on it succeeded (`userPageSharedAtOnce`).

## A redirect to another site

- The page server answers `/sign-in` with a 302 to the same port on `localhost`, another origin, the way a site sends you to its sign-in. Typed into the address bar, the page finished loading at the address it reached, `http://localhost:<port>/signed-in`, the address bar showed it, and the page was still shared with that origin (`addressFollowsRedirect`, `sharedAcrossRedirect`). The agent's `inspect` read the new page.
- `shared-across-sites.png`: the address after the redirect, the Share button pressed and the grant line.
- Before this change, the same redirect left the page at the address it started from, still loading, and the agent's `inspect` was refused with "Ask the user to share this browser page"; that was reproduced in the installed Sotto before the change.

## Making one page private

- **Stop sharing** made the page private: the agent's `inspect` was refused, and a line under the address said *This page is private. The agent cannot see it · Share with agent* (`stopSharingMakesPrivate`).
- `private-line.png` at 1280 by 800 in dark, and `private-line-820x560-light.png` at the minimum window in light, where the line wraps inside the panel and nothing overflows the window.
- **Share with agent** on that line shared the page again with the origin it is on, and the line went away (`shareRestores`).

## Not checked here

- The installed Sotto: this is the built app under Playwright. The change reaches the installed app with the next release.
- A real provider turn. The agent's calls came through the e2e bridge, which reaches the same browser agent tools; the unit tests in `tests/unit/main/browserTools.test.ts` cover the grant ending while a page is shared, a page staying private when the grant is given again, and the thread's open pages being shared when the grant starts.
