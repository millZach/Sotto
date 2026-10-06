# The test iPhone is a page in Sotto's browser

## Status

Accepted October 3, 2026 (Zach, `docs/plans/2026-10-03-test-iphone.md`). Extends ADR-0020 and ADR-0029 to a second kind of browser page. It adds no standing grant.

## Context

Zach wants agents to test the apps they build on an iPhone, from Sotto on Windows, starting from his Virtual iPhone widget. Virtual iPhone has two modes. Its AirPlay mirror shows a real phone and cannot send a tap back; AirPlay has no input channel. Its app preview is a phone-sized Chromium view of a web build in an iPhone frame. Windows cannot run Apple's iOS Simulator, so a native app needs a Mac, a real phone with a signed helper, or a cloud device service.

Zach chose web and Expo-web builds first and a cloud device service later. He chose a Tools surface for the phone, and a phone that floats over the thread while an agent works on it. He chose the browser's default for permission. From three prototypes he picked **C, Floating phone, control tab** (`docs/prototypes/iphone-tool-prototype.html`): the phone floats as Virtual iPhone's framed widget did, and Tools > iPhone holds its controls rather than a second copy of its screen.

ADR-0029 makes the browser grant a deliberate exception to "the user answers every permission" and says a second standing grant of its kind is a new ADR, not an extension.

## Decision

**The test iPhone is a page in Sotto's browser, drawn as a phone.** A browser page carries a kind, `device`. An ordinary page has none; the test iPhone's is `iphone`. Everything ADR-0020 gives a page, the phone has too: one thread owns it, it is private until shared (or, while the thread has a browser grant, shared as every page is; ADR-0029, October 5 amendment), its tasks record steps, evidence and unchecked cases, and Pause stops them. It is not a second browser and not a second grant.

**The browser grant covers it, because it is the browser.** A tap is a click and a key press is typing, so each asks, or runs under the grant, exactly as those do. A swipe asks nothing, as a scroll does. **Stop** and **Let agents use the browser without asking** reach the phone and the browser together, and the words on both say so. No grant was added, and nothing the grant did not already allow became possible.

**What makes a page a phone.**

- It lays out at an iPhone 15 Pro's 393 by 852 CSS pixels, with iOS Safari's user agent and a touch screen. A screenshot is 393 by 852.
- It is scaled by page zoom to whatever size the player draws it, and not by Chromium's device emulation. In Electron 43, `enableDeviceEmulation` with a `scale` moved CDP input to `1 / scale` of the point asked for. With page zoom, a touch at (110, 200) reached the page at (110, 200).
- Each thread's phone has its own session. A phone keeps its own storage, as a separate device does. Chromium also keeps page zoom per origin within a session, so the phone's zoom never reaches a page in Tools > Browser.
- A thread has one phone. `iphone_open` replaces what it shows, unless a task is still working or paused on it.
- Desktop scrollbars are hidden with injected CSS. There is still no preload, as ADR-0020 requires.

**Main can show two pages at once:** one in the pane slot (Tools > Browser or the Browser player) and the phone in its own slot. A page's kind decides its slot, so the renderer's mount request is unchanged.

**Agents reach it on the endpoint they already have.** `sotto_browser` gains `iphone_open`, and `browser_action` gains `tap`, `swipe` and `key`. No provider's launch or allow-list changed shape: Claude's `--allowedTools` and Codex's server entry are built from the tool list, and Grok's admission matches any of the server's tools.

**It is not iOS, and Sotto says so.** The tool's description tells the agent to say so in its finished report. Tools > iPhone says so under **Runs as**. Native modules, the camera, push and iOS rendering are not tested here.

## Consequences

- Testing a web build on a phone needs nothing new from the user: no key, no host, no download. The README's hosts are unchanged.
- The phone player and the Browser player can both be open. Each steps aside only where the other overlaps it.
- A native app, the second half of what Zach asked for, needs a cloud device service. That adds a host and a key, so it is ADR-0047 and a README change before any code. The candidates are compared in `docs/research/2026-10-03-cloud-ios-devices.md`.
- Virtual iPhone's AirPlay receiver is not brought in. It cannot be driven, and its firewall changes are more than Sotto asks of anyone.
