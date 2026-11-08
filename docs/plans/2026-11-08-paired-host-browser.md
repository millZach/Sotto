# Sotto's browser for a thread on a paired host

Issue #212. Decision: [ADR-0198](../adr/0198-a-paired-hosts-thread-browses-in-the-hosts-own-chromium.md). Prototype: tag `prototype/paired-host-browser`. Owl feature `paired-host-browser`.

Each part is its own pull request off `main`, "Part of #212", and the last closes it. Nothing a user sees changes until part 5, and nothing at all on stable.

## Zach's picks, November 8, 2026

- The browser runs on the host, in the host's own Chrome, Chromium or Edge, headless.
- The pane's row says "on forge" (A).
- An Owl feature.
- Asking first follows this computer's **Let agents use the browser without asking**; the host keeps the last value a desktop sent.
- Only a desktop that may answer answers a waiting request. Any connected desktop can drive the page and press Share with agent.
- The browser player floats a host's page too.
- **Open in system browser** stays, with `localhost` swapped for the host's address.
- Later, in their own pull requests: **Point at something** and **Screenshot to message** on a host's page, and the test iPhone on the host.

## Parts

**1. The decision.** ADR-0198 and this plan.

**2. The host drives a browser.** `src/host/browser/`, plain Node, no Electron and no Lingui:
- Find Chrome, Chromium or Edge on Linux, Windows and macOS (`cliLookup.ts` is the precedent).
- Start it headless with `--remote-debugging-pipe` and a temporary profile per workspace, deleted on close.
- A DevTools Protocol client over the pipe (NUL-delimited JSON on fds 3 and 4).
- Pages: open, navigate, back, forward, reload, close; actions: inspect, screenshot, click, type, key, scroll, viewport; `Page.startScreencast` pictures with acknowledgement, newest wins.
- Permission requests refused.
- Tests: a scripted fake pipe for the client, and a real-browser integration test gated on finding one.

**3. A host's threads get the browser tools.**
- Lift what `browserAgentTools.ts` needs of `BrowserService` into an interface the host's browser service also meets, without changing the desktop's behaviour.
- The host's browser service: tasks, the grant (ADR-0029's rules, in the host's memory), the waiting request and its five-minute end, and sharing.
- Register the tool server for the host's threads behind the Owl answer, read once at start.
- The host keeps the last **Let agents use the browser without asking** in its settings file.

**4. The protocol.** A `browser` host feature, offered to desktops only and only with the Owl answer on:
- Requests: list pages, open, navigate, back, forward, reload, close, input, watch a page (with a size) and stop watching, share, answer, ask before this thread uses the browser, the setting.
- Pushes: pages, tasks, pictures (only to a desktop watching that page, within the frame limit, dropped when behind).
- Answers need `desktop && mayAnswer`; driving, sharing and the rest need a connected desktop.
- The desktop client, router and preload bridge route a remote thread's browser channels to its host.
- `tests/integration/socketHost.test.ts` covers a picture through the socket; `docs/host-protocol.md`.

**5. The pane and the player.**
- Tools > Browser and the browser player draw a host's page from pictures and send input back.
- The row says "on forge".
- Point at something and Screenshot to message are absent on a host's page.
- Open in system browser swaps the loopback address for the host's.
- The waiting request, the browsing strip and the browser line work as for a thread here.
- An older host keeps "Browser is on the host machine." and says to update it.
- `CONTEXT.md`, `README.md` and `docs/guide.md`.
- A Playwright journey with a real headless host and a real browser on forge, and a verification note. Closes #212.
