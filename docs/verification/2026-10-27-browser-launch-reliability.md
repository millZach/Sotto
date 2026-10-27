# Browser launch reliability verification

October 27, 2026, on `fix/browser-launch-reliability`, from `main` at 4899f508, on Windows 11 with Electron 43.8.3. The causes are in `docs/research/2026-10-27-built-in-browser.md`.

## In the running app

`tests/e2e/browser-hidden-page-input.spec.ts` launched the built app, opened a 60-note page as the Workshop thread's agent with `browser_open`, and hid the browser player, so the page sat on no window. The agent's scroll returned in 185 ms and the page title reported `Fieldnotes, scrolled to 1200`. A second scroll on the same page ran at once rather than reporting that an action was still running. Tools > Browser then showed the page where the agent left it (`artifacts/browser-launch-reliability/hidden-scroll-landed.png`, `hidden-scroll.json`).

The same spec with input's surface removed failed. The scroll got no answer and, after the new 20-second deadline, returned "The page did not answer in time. Inspect it before trying again." Before this change it had no deadline and waited until someone showed the page, as the fifteen 300-second cut-offs in the transcripts did.

## Unit tests

Each was run with its fix undone and failed, and passes with it (`tests/unit/main/browserTools.test.ts`, "browser actions that the page cannot finish"):

- a scroll and a tap on a page that is not on screen borrow the off-screen surface;
- a command the page never answers fails in words at the deadline, detaches the debugger, and frees the page;
- a debugger setup that failed once is tried again rather than kept;
- typing refused because the focused element is not a plain text field says so, instead of "This tool is unavailable. Refresh and try again."

Not checked here: macOS and Linux. The capture host they share was already used for screenshots there; input on a hidden page was not tried on either.
