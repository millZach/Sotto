# A question opens the pages its agent made

October 14, 2026, on Windows 11, from `tests/e2e/question-prototype-pages.spec.ts` and `tests/e2e/question-message-links.spec.ts` against the built app, and from the unit and integration tests named below. The provider's effects come from the E2E host. Only the operating system's opening is recorded: `shell.openPath` and `shell.openExternal` are replaced, so nothing opens.

## Why

Zach still had no way to open a prototype an agent asked him about, after #954. Reading his own threads from the two weeks before showed why. #954 lifted only `http` and `https` addresses, and of about seventy prototype hand-offs, 23 were a tailnet link that opened on the phone. 29 were a `localhost` address only, which the phone's row could not reach. 16 were a file path and 2 a `file://` link, which got no row anywhere. He chose for Sotto to find the pages itself for every provider, to pass `localhost` pages through phone access, to serve any HTML file in the thread's folder, and to open a page on the iPhone in Safari's in-app browser. He picked rows (variant A) from `prototype/question-prototype-pages` (ADR-0084).

## What was shown in the app

- A real project folder holds `docs/prototypes/greeting-prototype.html`. The agent's reply names it by that relative path, and then the agent asks which greeting to use. The card shows one row, "Open the prototype, greeting-prototype.html", between the question and its choices. The host found the page; no provider sent it.
- At 1600x1000, 1280x800 and 820x560, in light and dark, the row fits inside the card and the card does not scroll sideways. Its two lines meet 4.5:1 on the card.
- From the collapse toggle, Tab goes to the row and then to the first choice. Enter on the row opened the file through main, at its full path, and picked no choice.
- With the provider disconnected the choices are disabled, and the row still opens the file.
- With the file deleted, a press opens nothing, and the card says "That page is no longer there. The file was moved or deleted, or the question was answered. Nothing else changed."
- In #954's spec, the agent's `http://localhost:8075/` review page is now a page row, "Open the prototype, localhost:8075", ahead of the GitHub link's row. Enter on it opened `http://localhost:8075/` through main. Its other checks, at every size and in both themes, still pass.

## What the tests prove

- `tests/unit/main/questionPages.test.ts`: how agents write a page (bold `localhost` links, relative and absolute paths with spaces, Markdown links, `file://` links with escapes), in the order written. That a file must be inside the thread's folder after links are followed and outside `.git`. That a file name alone is found only when it is unambiguous. That pages are pinned when a question arrives, so a later reply does not move them, and permissions get none. That pages a provider put on a request are dropped. That a token works for an hour after its question leaves, and not after.
- `tests/unit/host/questionPageRoute.test.ts`, over a real listener and a real loopback page server:
  - The page and its stylesheet are served sandboxed and uncached.
  - Hidden files, source files and escapes from the folder are refused.
  - An unknown token and a deleted file each get a plain page.
  - A `localhost` page is passed through without cookies either way, and its redirect stays on the route.
  - A stopped server, or the listener's own port, gets the "server has stopped" page.
- `tests/integration/socketServer.test.ts`: the socket listener serves a page by its token with a tailnet `Origin` and no session, and still refuses its own routes to that origin.
- `tests/unit/main/desktopHostRouter.test.ts`: the desktop opens this computer's file as itself, a `localhost` page at its address, and a remote host's page under the host's address. It opens nothing for a token not on that request.
- `tests/unit/renderer/requests/agentRequestCard.test.tsx`: the rows' order, a served `localhost` link with no row of its own, opening by request and token while the choices are disabled, and both failure lines.

## The iPhone

`AgentRequest` in SottoCore reads `pages`, leaves out a page it cannot read without losing the request, and leaves pages out of equality. A request read before its pages arrived is therefore still the one to answer. `RequestPage.url(on:)` builds the page's address on the computer's tailnet origin and refuses a token that is not one. The sheet uses the address its connection actually reached, which can be phone access's other port, and opens the page in `SFSafariViewController` over the sheet. `RequestTextTests` covers decoding, the address, a `localhost` link with no row of its own, and equality. None of it was compiled or run here: there is no Swift toolchain on this machine or on forge, and the iPhone client builds only on the macOS CI job.

## Captures

In `artifacts/question-prototype-pages/`:

- `question-pages-1600x1000-dark.png`, `-1600x1000-light.png`, `-1280x800-dark.png`, `-1280x800-light.png`: the card with its page row.
- `question-pages-820x560-dark.png` and `-820x560-light.png`: the minimum window, scrolled to the row.
- `question-pages-1280x800-dark-gone.png`: the row after its file was deleted, with the line that says so.

## Not shown here

- A page opened on a real iPhone through Tailscale Serve. The route is the same listener Serve already carries for phone access, at every path, and the integration test covers the listener. The iPhone side waits on the macOS job and a hand test.
- A page on a remote host opened from this desktop. The router test covers the address it builds.
- Android, whose question sheet shows no link rows yet.
- A dev server that loads files from its own root or keeps a live-reload socket. Through the page route it may load only in part; ADR-0084 records that this was accepted.
