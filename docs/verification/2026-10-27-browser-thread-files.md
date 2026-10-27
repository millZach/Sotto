# Thread file pages verification

October 27, 2026, on `fix/browser-opens-thread-files`, from `main` at d717248d4, on Windows 11 with Electron 43.8.3. The cause is number 4 in `docs/research/2026-10-27-built-in-browser.md`. The decision is ADR-0085's October 27 amendment.

## In the running app

`tests/e2e/browser-thread-files.spec.ts` launched the built app with phone access off and **Let agents use the browser without asking** on, its default. It wrote `docs/prototypes/trail-prototype.html` into the Workshop thread's working folder, with `assets/look.css` and `assets/variant.js` beside it. Then, as the Workshop thread's agent, it called the browser tools through the same dispatcher a provider reaches.

- `browser_open` with a `file://` URL to a file in a temporary folder outside the thread's folder returned an error: "Only HTML files inside this thread's folder can open in Sotto's browser. …\elsewhere.html is outside it. Nothing was opened. Copy the page into …, or serve it and open its http address." No page opened.
- `browser_open` with `file:///…/docs/prototypes/trail-prototype.html?variant=B` opened the page at `http://127.0.0.1:<port>/page/<token>/trail-prototype.html?variant=B`. Its own script ran in the sandbox, read `variant=B` from the query string, and found the style sheet beside the page applied, so the page title read `Trail picker, variant B, styled`. The agent's `inspect` on it ran, because the thread's browser grant shared the page as it shares any other.
- `artifacts/browser-thread-files/thread-file-player.png` is the window at 1280x800 with the browser player over the Workshop thread. The player is titled `Trail picker, variant …` with a `127.0.0.1` address, the page shows its **Variant B** badge, and the task line reads "Show the trail picker prototype, variant…".
- `artifacts/browser-thread-files/thread-file-tools.png` is the same page in Tools > Browser. The address bar holds the `http://127.0.0.1:<port>/page/…` address, and the page is drawn in full with the sibling style sheet's colours: the **Variant B** badge, the "Take the long way home." heading, the landscape band and **Save trail**.
- `artifacts/browser-thread-files/thread-file.json` records the same, with the folder, port and token replaced by placeholders, and no page errors.

With the browser service's change undone and the app rebuilt, the same spec failed at its first check. The outside file got "This browser request is invalid. Use the tool's documented arguments.", the answer the transcripts showed.

## Unit tests

Each was run with its fix undone and failed, and passes with it.

- `tests/unit/main/threadFilePages.test.ts` covers opening and serving, over a real loopback listener. A `file://` URL inside the folder opens at a `127.0.0.1` address and keeps `?variant=A#second`. An absolute and a relative path open the same file under the same token. The page and its sibling CSS, JS and PNG are served with their types and the sandbox and `no-store` headers. The serving refuses `..` traversal in its escaped forms, `.env`, a hidden HTML file, `.git`, JSON and a folder link (a junction) that leads outside, and refuses POST. Opening refuses, in plain words, a file outside the folder by absolute path, by `file://` URL, by `../` and by a UNC path (Windows only, never looked at). It also refuses a file that is not HTML, a missing file, a hidden file, a file in `.git`, and a folder link that leads out. An address with another scheme is left to the caller. A forgotten thread's page answers "This page has closed", with words that do not mention a question. The fixes undone were the folder check, the hidden and `.git` check, keeping the query, the route's own words for a closed page, and the route's refusals; each turned its tests red.
- `tests/unit/main/browserTools.test.ts`, "a thread file page": the browser service opens a `file://` URL in the thread's folder at the served loopback address, and the page record carries that address. A file outside the folder and a JSON file are refused with code `blocked` and plain words. Another scheme is refused with words that name both kinds of page. None of the three opens a page.
- `tests/unit/main/testIphone.test.ts`: `iphone_open` opens a file by a path relative to the folder, keeping `#tabs`. A file that cannot open leaves the existing phone in place.
- `tests/unit/main/browserAgentTools.test.ts`: the dispatcher passes a `file://` URL on to the browser service instead of answering "invalid", returns the service's own words, and the `browser_open` and `iphone_open` descriptions and input schema tell agents they can pass a file.

`tests/unit/host/questionPageRoute.test.ts` still passes with the route's new option and its reworded refusal line.

Not checked here: macOS and Linux, and a real provider turn. The spec drives the tool dispatcher directly, as `agent-browser.spec.ts` does, so the agents' use of the new descriptions is not observed. The folder-link cases ran through a junction. File symbolic links need Developer Mode on this computer, so those cases skipped here and run where the system allows them.
