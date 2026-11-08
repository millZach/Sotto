# A thread on a paired host browses in the host's own Chromium

## Status

Accepted November 8, 2026, by Zach's picks on question cards, from the prototype kept at the tag `prototype/paired-host-browser`. **Number provisional until merge** (docs/agents/domain.md). Issue #212.

It is an Owl feature (`paired-host-browser`, ADR-0072), and it builds on the browser pane (`quiet-browser`, ADR-0154). Stable keeps "Browser is on the host machine." until Zach sends both.

Amends [ADR-0020](0020-sotto-owned-browser-tasks.md) and [ADR-0029](0029-a-thread-uses-the-browser-without-asking-by-default.md) for threads on a paired host, and the "Terminal, Browser and iPhone say they are on the host machine" line of [ADR-0025](0025-headless-host-and-client-identity.md)'s October 5 amendment, for Browser only. Adds a host feature to the host protocol. Changes no pairing rule and no policy record.

## Context

A thread on a paired host has no Sotto browser. Its agent gets no browser tools, since the host's tool servers leave the browser to the desktop (`src/host/index.ts`), and Tools > Browser says "Browser is on the host machine." Zach views forge's threads from his laptop, and those agents start dev servers on forge and need to look at them.

Sotto's browser can't simply run on a host. It is Electron's `WebContentsView`, and a host runs under plain Node with no native code in its archive (ADR-0183 has the reasons). Two routes were left:

- **On the host.** The host's Sotto drives a Chrome or Chromium already installed on the host, over the Chrome DevTools Protocol, and sends pictures of the page to the desktop's pane, which sends back the user's clicks and keys.
- **On this computer.** The agent's browser calls travel back to the desktop and open in its own Sotto browser, the way Tell Watcher and delegation already relay.

Zach saw both in the prototype, with what `localhost`, a sleeping laptop, a missing browser and an older host do on each, and chose the host.

## Decision

**1. The browser runs on the host.** The host's Sotto finds Chrome, Chromium or Edge where each installs itself on that system and runs it headless, with no window on the host's screen (Zach's pick). Sotto adds no npm dependency and nothing native to the host archive: it speaks the DevTools Protocol over `--remote-debugging-pipe`, through Node's own child process pipes, so the browser opens no port. Each workspace gets a profile of its own in a temporary folder that Sotto deletes when the browser closes, as this computer's browser keeps nothing between sessions. Page permission requests (camera, location, notifications) are refused, as on this computer.

`localhost` is the host's, so a dev server the agent starts there opens. The agent keeps browsing while no desktop is connected.

**2. A thread on the host gets Sotto's browser tools**: `browser_pages`, `browser_open`, `browser_start`, `browser_action`, `browser_status` and `browser_finish`, with the meanings they have on this computer. The test iPhone's tools come later, in their own pull request (Zach's pick), and the cloud iPhone stays this computer's. When the host has no browser, the tools say so in plain words and nothing is opened.

**3. Asking first follows this computer's setting** (Zach's pick). A connected desktop sends the host its **Let agents use the browser without asking**, when it connects and when the user changes it, and the host keeps the last value on disk, so a restart with no desktop connected still holds the user's choice. A host that has never heard from a desktop starts with the setting's default, on. The browser grant is otherwise ADR-0029's: one thread, the same four actions, the same sharing, held in the host's memory, ended by **Ask before this thread uses the browser** in the pane's More, by the setting turning off, when the thread is gone and when the host's Sotto stops.

**4. Only a desktop that may answer answers.** A request waiting for the user (with the setting off) shows in the desktop's browsing strip with Allow once, **Allow this thread to use the browser** and Deny, and only a desktop whose pairing may answer (`desktop && mayAnswer`, as for a host update) can send one (Zach's pick). **Share with agent** needs the same, since sharing gives the agent a page it couldn't see. A phone shows nothing; the request waits for a desktop and ends after five minutes, as today. Any connected desktop can drive the page by hand, open, close and navigate pages from the pane, and turn on **Ask before this thread uses the browser** (Zach's pick): those are the user's own actions in the page, or take power away.

**5. The pane and the player show pictures of the page.** While a desktop's pane or browser player shows one of the host's pages, the host sends it pictures of that page as it changes, sized to the pane. Pictures go only to a desktop that is showing that page, are dropped rather than queued when the connection falls behind, so the pane shows the newest, and are never written to disk or logged on either side. A click, a key, typed text or a scroll there goes to the page on the host. The player floats a host's page when Tools is closed, as it does for a thread here (Zach's pick).

**6. The pane's row says "on forge"** (Zach's pick A), with the machine symbol, as the paired-host terminal's bar does (ADR-0183), using the name this computer saved the host under.

**7. What the first version leaves out.** **Point at something** and **Screenshot to message** are absent on a host's page until a follow-up adds them (Zach's pick).

**Open in system browser** stays, and opens the page on this computer with `localhost`, `127.0.0.1` and `[::1]` replaced by the host's address as this computer reaches it, its tailnet name where it has one (Zach's pick). That reaches a dev server only when it listens beyond the host's own loopback; any other address opens as it is.

**8. Nothing new is contacted by Sotto.** The host's browser contacts the pages the agent or the user opens, as Sotto's browser does on this computer. Sotto downloads no browser: a host without one says to install one.

## Consequences

- A host gains a browser engine it didn't have, which is the user's own installed Chrome, Chromium or Edge, and Sotto starts it only when a thread opens a page.
- Typing in the pane lags by the round trip to the host.
- An older host keeps saying "Browser is on the host machine."; Tools says to update Sotto on the host when the desktop knows the host is older.
- A paired phone gains nothing: no pane, no pictures, no answers.
- The host's setting file gains the last **Let agents use the browser without asking** a desktop sent.

## Alternatives

- **The agent's calls come back to this computer's Sotto browser.** Nothing new on the host, and the pane would be the real pane with every control. But `localhost` would be the laptop, so the agent would need the host's tailnet address and a dev server listening beyond localhost, and a host's thread couldn't browse while no desktop was connected. Zach chose the host.
- **Sotto downloads a headless Chromium to the host.** It would work on a host without a browser, at the price of a new host Sotto contacts and a large download. A user can install one with the system's own package manager.
- **A port for the DevTools connection.** Any process on the host could drive the browser through it. The pipe is reachable only by the Sotto that started it.
