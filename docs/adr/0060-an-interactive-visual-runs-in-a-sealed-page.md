# An interactive visual runs in a sealed page

## Status

Accepted October 6, 2026, for issue #794, the third ticket in `docs/plans/2026-10-06-visualize-tool.md`. Builds on ADR-0056, which kept the card, the store and the tool; this adds a second kind to them. Amends ADR-0056's case for asking nothing, which rested on a visual running no command and being source the agent could have written into its reply; a page runs script (see **Still no prompt** below).

## Context

A diagram is Mermaid source that Sotto draws itself, as an inert image. An interactive visual is different: it is an agent's own HTML page with its own script, the way Claude's and Codex's in-chat visuals work (a chart, a simulation, a clickable explainer). The script is whatever the model wrote. Sotto cannot inspect it into safety, so it has to contain it. Two things are expensive to get wrong. The page must never become a way around a provider's own network sandbox, or a way to send what is in the thread anywhere. And it must never reach Sotto's window, whose preload holds the bridge to everything Sotto does.

An iframe in the main window would share the window's session, and no Content-Security-Policy directive covers WebRTC. Electron's WebRTC policy is set per webContents, so limiting it for the iframe would limit the whole window too. The page needs a webContents of its own.

## Decision

**A `<webview>` guest on an in-memory session.** The page runs in a `<webview>` guest: a webContents of its own, in its own renderer process, on the partition `sotto-visual`, which has no `persist:` prefix and so keeps nothing on disk. The other candidate was a WebContentsView laid over the window. Electron 43.1 has both, and the choice came down to how each sits in the transcript. A WebContentsView is a native layer above the window's page. It does not scroll with the transcript or clip to it, it covers menus and dialogs, and main would have to move it on every scroll and resize. A guest is composited with the page: it scrolls with the card, is clipped by the transcript above the composer at 820x560, sits in the tab order, and opens inside the Expand dialog like any element. The running app shows all of that (`artifacts/interactive-visual/`). Electron's documentation steers apps away from `<webview>` because its architecture may change. Sotto accepts that for the one thing it is used for here. Only the main window turns the tag on, and only main admits a guest.

**Served once from main's own store.** The window asks for a page by thread and visual ID and sends the theme to start it in. It never sends HTML. Main reads the visual from its store, and if it is an interactive visual the thread holds, answers with a one-time address, `sotto-visual://page/<token>`, that names neither the thread nor the visual. An address is good for one load, for 30 seconds, and at most 16 wait at once. The scheme is registered as standard and nothing more: not secure, no fetch, no CORS, no service workers. The page is served with these headers:

- `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts`. The sandbox gives the page an opaque origin with scripts and nothing else: no popups, forms, modals, downloads, storage or top navigation. There is no report URI, because a violation report would itself be a request.
- `X-DNS-Prefetch-Control: off`, a `Permissions-Policy` that turns every listed feature off, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

Before the agent's HTML, Sotto puts a charset, a `color-scheme` that matches the theme (a mismatch paints the frame white in dark mode), Figtree as data URLs, and a style with the theme's colours as `--sotto-text`, `--sotto-muted`, `--sotto-line`, `--sotto-background`, `--sotto-surface`, `--sotto-border`, `--sotto-group`, `--sotto-note` and `--sotto-accent`, the font as `--sotto-font`, and no movement when reduced motion is on. Every colour is a six-digit hex value, checked in main and again in the guest, so nothing but a colour reaches the page's CSS. They are the diagram palette under names agents are given.

**The session reaches nothing.** On the `sotto-visual` session:

- Every request is cancelled except a live page address loaded as the page itself.
- Every permission request and permission check is denied, and so is every device.
- Downloads are blocked and spellcheck is off.
- Everything is sent to a SOCKS5 proxy with no bypass, loopback included (`<-loopback>`). The proxy is a loopback port Sotto holds for as long as it runs, so no other program can take it, and it closes every connection without a byte. A connection that never passes a request filter, such as WebRTC or a preconnect, has nowhere to go. The session, its seal and the proxy are set up the first time a page is asked for, so a launch that shows no page sets up none of them. If the port cannot be held, the session is not sealed and no page is shown; the card says so and points at what the visual has besides it, and the next request tries again.

**The guest is sealed too.** Main admits a `<webview>` only in its main window, only once the session is sealed, only for a page address awaiting its load, and replaces whatever preferences the element asked for: sandbox, context isolation, no Node in any frame, web security on, no nested webviews, no plugins, no dialogs, no popups, the `sotto-visual` partition and Sotto's guest preload. Every other attribute is dropped. A guest that somehow attached on another session is closed before it loads. Every guest has its WebRTC IP handling limited to `disable_non_proxied_udp`, so WebRTC can use only the proxy that answers nothing. It opens no window, and it follows no navigation, redirect or nested webview the page starts. Its one load is Electron's own, from the address it was attached with.

**A small bridge, isolated from the page.** Sotto's guest preload runs in an isolated world and exposes nothing. It is a second preload entry that shares no module with the window's, because a sandboxed preload cannot load a shared chunk. It passes `{ type: 'sotto-visual-step', step, total, highlight }` and `{ type: 'sotto-visual-theme', tokens, mode, reducedMotion }` to the page as window messages. It rewrites the theme style and colour scheme when the theme changes, measures the page's own height and sends it to Sotto, and sends Escape back to Sotto. Its Escape listener is on the window in the capture phase, registered before any script on the page, so the page cannot stop it, and it counts only a trusted key, one the user pressed: an Escape the page dispatches itself moves nothing, so a page cannot take focus away, close Expand or flood Sotto with messages. The step and theme go to the page once its script has run and again once its load has finished, and the tool's description tells agents to attach their listener at the top of the page's script. Sotto measures the content, the larger of the root's own box and the body's scroll height, so a page whose body fills the frame still grows to its content; content sized in `vh` follows the frame, and the description tells agents to size by content. Sotto holds the frame between 160 and 640 pixels whatever the page measures, and a taller page scrolls inside. A page with steps has the same walkthrough under it as a diagram (#793, kept per visual like a diagram's): each step the reader moves to goes to the page with the step counted from 1, the total and the names that step lists, and Read all sends step 0 with no names. The current step goes again once the page has finished loading.

**At most three at once.** A page runs only while its card is near the view, watched against the transcript that scrolls it so it starts just before it scrolls in, and at most three run at once. The others show a quiet line until they come near. Expand shows the page over the window: an expanded page always runs and counts among the three, and the card's own page stops meanwhile, so one visual never runs twice. A page that comes back starts again from the top, on a new address.

**Still no prompt.** ADR-0056 asks the user nothing for a visual because drawing one changes nothing outside the thread, runs no command, and draws from source the agent could have written into its reply. A page breaks the second and third: it runs the agent's own script. It asks nothing all the same, because the script runs sealed. It runs on this computer in a renderer of its own, can reach no host, read no file and see no part of Sotto, cannot ask for a permission, and drives nothing back but its height and the user's own Escape. What it can change is what it shows in its own frame. That is still nothing outside the thread, so the argument holds on the seal rather than on the source. ADR-0056 carries a note pointing here.

**The tool.** `visualize` takes `kind: "interactive"` with a source of up to 60,000 characters. A page gets none of the diagram checks; containment stands in for them. The tool's description tells agents that the page cannot load anything, to colour it with the `--sotto-*` variables and how to listen for the two messages. The fallback text and what the iPhone gets are ADR-0056's.

## What the tests prove, and what they do not

On Zach's decision (October 6, 2026), the tests use ordinary loads only. An earlier attempt at a page that tried every way out was stopped, and the issue's call for one is not met. This section records what that leaves.

The unit tests (`tests/unit/main/visualPages.test.ts`, `tests/unit/shared/visualGuest.test.ts`, `tests/unit/renderer/interactiveVisual.test.tsx`) show what Sotto asks Electron for. An address loads once and lapses. Another thread, an unknown visual or a diagram gets no address. The headers are as above. Every request but a live page loaded as the page is cancelled, every permission and device is denied, and downloads are blocked. The proxy has no bypass, and the dead proxy closes a connection without a byte. A guest's requested preferences are replaced. The guest's WebRTC policy, window handler and navigation refusals are set. Height is held to 160 to 640, step and theme messages are passed on only in shape, and at most three pages run. The window never sends a page.

`tests/e2e/visual-sandbox.spec.ts` runs the built app with a TCP listener on loopback. It shows that:

- The page draws and runs its script, and cannot see `window.sotto`, `require` or `process`.
- The page receives the step and theme messages: stepping the card's walkthrough to step 2, to Read all and back shows on the page, and its style and colour scheme follow light and dark.
- The page is sized to its own 260 pixels, and a 2,000-pixel page is held to 640.
- Escape inside the page gives focus back to the card, with its focus ring, and an Escape the page dispatches itself moves nothing.
- The card fits at 1600x1000, 1280x800 and 820x560 in light and dark, and with Reduce motion on the page is told and its style stops movement.
- A page whose body fills the frame grows to its content.
- An ordinary `fetch` and an ordinary `<img>` aimed at the listener are refused by the page's policy.
- An ordinary link and an ordinary new-window link leave the page where it was and open no window.
- An ordinary fetch made by the session itself, outside any page's policy, fails as blocked by Sotto (`ERR_BLOCKED_BY_CLIENT`) before it leaves.
- Read through the app's own evaluation, the session resolves a loopback address to its SOCKS5 proxy, not DIRECT, and the guest's WebRTC IP policy is `disable_non_proxied_udp`. This shows the settings are in place, not that WebRTC traffic is held back.
- A page address cannot be loaded twice.
- Across the run the listener sees no connection at all, no request completes but the pages, no frame commits a navigation but each guest's one load, and nothing downloads.

They do not prove that nothing else gets out. No test tries WebRTC with STUN or TURN, DNS prefetch or preconnect, WebSocket, EventSource, WebTransport or beacons, workers, nested `about:blank` or `srcdoc` frames, meta refresh, forms, each permission prompt, UDP, a page that lies about its height, timing or other side channels, a compromised renderer, or a flaw in Chromium or Electron. For those, the containment rests on its layers and on Chromium and Electron doing what their documentation says: the page's policy, the request filter, the proxy with no bypass, the WebRTC policy and the permission denials. A test does not stand behind them. A future hostile-page spec belongs in its own issue, with the user's agreement.

## Consequences

- The README's "Privacy and cost" stays true: a visual is made on this computer and contacts no one. The dead proxy is a port on this computer that Sotto holds, not a host.
- Turning off **Let agents draw visuals in threads** stops new visuals, as ADR-0056 says. A page already in a thread still shows, as a diagram does.
- The main window has `webviewTag` on. Any later use of `<webview>` must pass the same admission in main; today a guest is admitted for a live visual page address and nothing else.
- A page has an opaque origin, so `localStorage` and cookies throw or are empty; the tool's description says it has no storage.
- A page's script runs in its own renderer process. A page that spins costs that process, not Sotto's window. Sotto does not measure or stop it.
- The walkthrough drives the page through the step message; the page drives nothing back. The bridge carries height and the user's own Escape only, so a page cannot move the walkthrough itself.
