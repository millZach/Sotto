# Report for OpenAI: Computer Use stops on Chrome pages on Windows

Written for Zach to send to OpenAI. It names no account, page contents or signed-in site. Sotto's tracking issue is #2062.

## Summary

On Windows, Computer Use can stop with this message on an ordinary Chrome page:

> Computer Use has been stopped for this turn because it could not determine the current browser URL on Windows with enough confidence to enforce policy. Stop your work and send a final message noting why Computer Use ended.

It appears to happen whenever Chrome is not exposing the page's `document` accessibility node at the moment of a read. That node is missing while a JavaScript dialog is open and briefly after moving to a large page. We are not asking to weaken the URL check. We are asking for it to read the address reliably.

## Versions

- Windows 11 Home 10.0.26200
- Codex app 26.1027.3384.0, plugin 26.1027.30824, codex-cli 0.166.0
- `@oai/sky` 0.7.13, `codex-computer-use.exe`
- Chrome 156.0.8078.74

## How to reproduce

The calls ran from a Codex session started by a client other than the Codex app (Sotto, through `codex app-server`), using the app's own helper over its native pipe.

1. Open a page in Chrome that runs `setTimeout(() => alert("test"), 2000)`, and let the alert open.
2. Call `sky.get_window_state({ window, include_screenshot: false, include_text: true })` on that window.
3. It gives the message above, 3 reads out of 3.
4. Close the alert and read again in the same turn. It succeeds.

For a large page, move a tab to a page with about 20,000 rows and read in a tight loop. We got 7 refusals in about the first 700 ms out of 70 reads, then no more.

**Not tested in the Codex app itself.** The computer-use skill does not allow automating the app, and we did not run it by hand. The owner reports never having seen this in the Codex app. This laptop's kept Codex app sessions (28, all from October 26) never read a Chrome page through Computer Use, so they neither support nor contradict that. We do not know whether the app is protected by routing browser work through the Browser Use plugin.

## What we measured

Through the real helper:

| Situation | Reads | Refusals |
|---|---|---|
| Fresh Chrome, `sky` | 24 | 0 |
| Fresh Chrome, `cua.getApp` | 3 | 0 |
| Fast reload | 30 | 0 |
| Clicks, then 45 s and 100 s idle | 10 | 0 |
| JavaScript alert open | 3 | 3 |
| Moved to a very large page | 70 | 7, in about the first 700 ms |
| Slow reload (server takes 6 s) | 231 | 0 |

Through plain UI Automation on the same kind of window, looking for the first `Document` element:

| State | `Document` |
|---|---|
| Alert or confirm open | Missing until it closes, then back about 30 ms later |
| Very large page, first read | Missing about 440 ms |
| Page swap in a slow reload | Missing about 50 ms |
| Frames, modal `<dialog>`, inert page, streaming load, minimised, in the background | Present |

In the original failures on a real signed-in page, the helper's tree showed `document … Value: https://… ID: RootWebArea` at 21:37:04 UTC, and the refusal came at 21:37:06 UTC, about 2 s after a click on Save. The save had worked, but the agent could not read the result. Two earlier refusals on the same window came at 21:31:37 and 21:33:22 UTC, and the same read worked at 21:35:15 UTC. We have no tree from the moments of refusal, so what the page was doing then is inference.

## Why we think it happens

From the strings and machine code in `codex-computer-use.exe` (source path `src/policy/url_policy.rs`), and only as far as those show:

- The address comes from the accessibility tree's node with the role `document` and the ID `RootWebArea`, whose value is the URL.
- For Edge, Chrome, Brave and Opera, a read with no such value leads to this message. We found no wait or retry on that path.

## What we would like

1. Wait briefly and read again before stopping, when a Chromium window has no `RootWebArea` value. A second read a moment later already works on a large page.
2. For an open JavaScript dialog, say so, because waiting will not clear it. For example: "A dialog is open in the browser, so Computer Use cannot read this page's address. Close it and try again."
3. Make the words match the behaviour. "Stopped for this turn" is what an agent obeys, but later reads in the same turn succeed once the node is back.

## A related error

`click(<element index>)` with no screenshot taken in that session gives `coordinate input geometry is unavailable`. The same click works after `getScreenshot()`. We saw this every time we tried it, on a real page and on a test page. It costs an agent a failed step and, in our case, ended its turn. Taking a screenshot on demand, or saying "take a screenshot first" in the error, would avoid that.
