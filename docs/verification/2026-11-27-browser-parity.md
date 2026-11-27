# The full browser and browser profiles verification

November 27, 2026, on `feat/browser-parity-and-secret-requests`, from `origin/main` at 9220d0129, on Windows 11 with Node 24.22.1. This is [ADR-0220](../adr/0220-sottos-browser-does-what-t3-codes-does.md)'s full browser catalog and [ADR-0221](../adr/0221-browser-profiles-keep-the-users-sign-ins.md)'s browser profiles, behind the `browser-parity` Owl feature. `tests/e2e/browser-parity.spec.ts` launched the built app (`npm run build`) with `SOTTO_OWL_FEATURES=browser-parity=1` over the fake Claude Code provider, against pages the test serves on loopback, and ran with `SOTTO_E2E_EVIDENCE=publish`. Captures are the window's own pixels (`desktopCapturer` by window title), so the native page main draws is in them. Every capture in `artifacts/browser-parity/` was looked at.

The agent's calls go through `window.sottoE2E.browserAgent`, the same tool server a provider reaches, bound to the Workshop thread.

## What the specs check

1. **The agent's full catalog** (first test). `browser_open` by port returns once the page loaded. A snapshot names elements with refs, and a click by ref reaches the one it named. A confirm the page opens holds the click until the `dialog` action answers it. A native select by label; an HTML drag and drop the page reads. Upload by selector and through the file chooser a click opens, each asking the user first and naming the file; a file outside the thread's folder is refused before anything is asked. `wait_for` for late words, `evaluate`, hover, keys with modifiers, scrolling one container ("Scrolled its container by 0, 200"), right click and double click. The colour scheme as the page's media query sees it, and device presets in both orientations at their sizes. A screenshot kept as a PNG in browser files, and a WebM recording that plays in a video element. A second page opened in the background is listed, not brought forward, and closed by the agent; a page the user opened is refused to `browser_close`. The test's own server was not started from Sotto, so `browser_servers` lists none. `navigate` waits for its readiness and says when it ran out of time.
2. **The pane** (second test). With no page, **Servers started from Sotto** says none is answering. A confirm shows as the dialog card at the page's foot with OK focused while the page stays drawn, one native view on the window; **OK** answers it. While the agent records, "Recording this page" shows with the time and **Stop**, which keeps the video, and `record_stop` then returns its path. More shows **iPhone 12 Pro**, **Rotate** and **Page in light colours**, and the page lists the preset, its orientation and its colour scheme. **Take over** pauses the agent, the strip says the page is the user's, the agent's click is refused, and **Hand back** gives it back. The dialog's and the recording's dots have no animation (`verification.json`).
3. **Browser profiles** (third test). The test made a Firefox profile folder of its own with one cookie for `localhost`, and pointed Sotto at it with `SOTTO_E2E_IMPORT_ROOT`, so the tester's own Firefox was never read. **Open new pages in** starts on **A fresh page**. **Add a profile that keeps sign-ins** focuses the name; "Work", **Copy sign-ins from** Firefox · default-release, **Add profile**: "Added Work and copied its sign-ins (1 cookie)", and Work is chosen. The page the user then opens is in Work: the chip beside the address names it, the page reads the copied cookie, it says "This page is private. The agent cannot see it" though the grant is on, and `browser_pages` gives the agent its ID alone. **Open developer tools** opens Chromium's tools in a window of their own. The agent's own page at the same address has no cookie. Only after **Share with agent** does the agent see the profile's page. Sotto was then closed and started again on the same data folder: Work was still listed, and a page opened in it still had the cookie. **Remove Work** asked in place with **Keep** focused; **Delete sign-ins** closed the page and removed Work (`profiles-verification.json`).

The three tests passed together, and again with `SOTTO_E2E_EVIDENCE=publish` for the captures.

## What the captures show

- **Empty pane** (`empty-servers-1280x800-dark.png`, `-light.png`): the servers heading with Look again, and the words that none is answering, above the hint.
- **Dialog card** (`dialog-1600x1000-*`, `dialog-1280x800-*`, `dialog-820x560-*` in dark and light, `dialog-reduced-motion-1280x800-dark.png`): "The page asks", the page's words, OK and Cancel in the strip's place under the drawn page. At 820x560 the card keeps one line of words and both buttons inside the pane.
- **Recording** (`recording-1600x1000-light.png`, `recording-1280x800-*`, `recording-820x560-dark.png`, `recording-reduced-motion-1280x800-dark.png`): "Recording this page · 0:0x" with a steady dot in the error role's colour, and Stop.
- **More** (`more-menu-1280x800-dark.png`) and **a preset on its side** (`device-landscape-1280x800-dark.png`): the device list with iPhone 12 Pro checked, Rotate, and the three colour choices; the page drawn at 844 by 390.
- **Taken over** (`taken-over-1280x800-*`): "You have the page. The agent waits until you hand it back" with Hand back.
- **Profiles** (`profiles-add-1280x800-*`, `profiles-1600x1000-*`, `profiles-1280x800-*`, `profiles-820x560-*`, `profiles-1280x800-dark-reduced-motion.png`, `profiles-remove-1280x800-*`): Open new pages in, with A fresh page and Work as radios, each with its note on the right; the add form with its name, Copy sign-ins from and the note to close that browser first; the result line; and Remove's Delete sign-ins and Keep in place of the bin. At 820x560 the notes stay on one line beside the names.
- **A page in a profile** (`profile-page-private-1280x800-*`): the "Work" chip after the address, and "This page is private. The agent cannot see it · Share with agent" over the page, which shows the copied cookie.

Nothing in these parts moves: the dots are steady and no transition runs longer than the pane's own, so reduced motion draws the same.

## Unit and integration tests

`tests/unit/main/pageSnapshot.test.ts` (the tree, refs, untrusted words, line limit; keys and modifiers), `browserParityTools.test.ts` (the two catalogs, Antigravity's compact listing over HTTP, the grant's actions and upload), `browserTools.test.ts` (the service: the catalog off, `browser_close`, upload asking, user input holding the agent, the pane's full-browser requests refused with the feature off, developer tools, and profiles: refused when off, the copy into the profile's own partition, a failed copy leaving nothing, private under the grant, no agent profile, removal), `browserFiles.test.ts`, `localServers.test.ts`, `browserProfiles.test.ts` (the store, the partition sweep, names; `profiles.ini`, the platforms' folders, cookie mapping, a real `cookies.sqlite` copied and read, its copy deleted), `browserRequestWords.test.ts`; `tests/unit/renderer/tools/browserParity.test.tsx`, `browserProfiles.test.tsx` and `browserPane.test.tsx` (the dialog card, recording line, menus, servers, profiles and the chip, developer tools, each only with the feature on). `browserParityTools.test.ts` also checks that the thread host asks for the compact catalog for an Antigravity thread alone, and `tests/integration/browserProviders.test.ts` that every other provider's browser server is still asked for with the thread's ID alone. `toolsIpc.test.ts` holds each of the 48 tools channels, the eight new ones among them, to the main window.

## Gates

`npm run typecheck`, `npm run lint`, `npm run notices:verify` (202 components), `npm run e2e:list` (692 tests in 304 files) and `npm run build` passed. `npm run test:desktop-smoke` passed 12 and failed `daily-workspace.spec.ts:169` (a Changes diff row), and `npm run design:verify` passed 6 and failed `settings-providers-light`, `setup-welcome` and `scale-100-help`. Both runs fail the same way on `origin/main` at 9220d0129, built and run from a detached checkout.

The full `npm test -- --maxWorkers=2` run found three failures from this branch, fixed since:

- `toolsIpc.test.ts` counted 40 channels, and now counts the 48 there are.
- `browserProviders.test.ts`: the thread host asked for every provider's browser server with an empty second argument. It now gives options only to Antigravity.
- `devinPolicy.test.ts`: the secret request change added `sotto_secrets` to Devin's approval profile without a new version. Sotto refuses a profile it wrote that has changed, so Devin would have been refused for everyone who already had version 6. The profile is now version 7.

The rest failed for reasons outside this branch, each rerun on its own:

- `threadWorktreeReclaim` and `threadWorktreeInterruptedRemoval` fail on a clean main.
- `gitRepository` fails because this computer's Git has no `gc --no-detach`.
- `liveChildSteps` fails because Windows refuses to make the symlinks without the right to.
- `installedProvidersGate` finds this computer's Hermes, which the test does not stub.
- `bringBackAcrossMachines`, `opencodeTools` and `workspaceStoreWriter` passed when rerun.

## Hands-on check

After a code review, the built app was used by hand on Windows: a secret request typed into a page's password field, browser profiles, dialogs, zoom and downloads, at 1280×800 and 820×560. The secret's canary value was found nowhere outside the page: not in the transcript, Sotto's data folder, the logs or an agent's tool results. Four problems were found and fixed, each with a test:

- A `browser_close` call blanked the thread's workspace until a reload: the browser line had no step for it or for `browser_servers`, and the renderer threw. It now says "closed a page" and "listed the local servers", any tool it does not know falls back to "worked in the page", and a unit test puts every tool in the full catalog into words.
- Escape did nothing on the page's dialog card. It now answers Cancel from any of the card's controls.
- At 820×560 a profile page at 125% pushed More under the window's Close button. The profile's name now shrinks to its icon, the zoom chip shows only its magnifier in a narrow row and steps aside in the narrowest row, where **Actual size** in More still says the level. `browser-parity.spec.ts` checks that every control ends inside the row's padding at that size.
- The secret-files folder stayed behind if Sotto started with secret requests off. It is now emptied at every start.

Ctrl with the wheel is checked against the zoom requests Chromium raises: Electron's `sendInputEvent` follows its wheel with a synthetic end of scroll that Chromium counts as a second notch, so one call gives two steps in the test.

## Not checked here

- macOS and Linux. The server list's `lsof` and `ss` readers and the Firefox folders there are unit-tested on fixed text only.
- A paired host's page with the full catalog in the running app; the host's service is covered by unit tests, and ADR-0198's paired-host spec was not rerun with the feature on.
- A `prompt()` on this computer: Electron cancels it (ADR-0220, decision 9).
- Copying from a real Firefox or Zen profile; the test used one it made in Firefox's format.
- A screen reader's reading of the dialog card and the profile radios.
- `npm run design:verify`: its baselines do not include Tools > Browser.
