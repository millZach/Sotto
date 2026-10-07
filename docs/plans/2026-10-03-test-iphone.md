# A test iPhone that threads can drive

Zach asked for an iPhone that agents can use to test the apps they build, inside Sotto on Windows, starting from his Virtual iPhone widget (`millZach/virtual-iphone`, read at `44c9364`). Planned on `origin/main` at `e5686a97`.

## What Virtual iPhone is

It has two modes, and neither can be driven by an agent as it stands.

- **Mirror my iPhone** is an AirPlay receiver (AirPlayServer/MirrorSimAdapter). It shows the real phone's screen and sends nothing back: no taps, no typing. AirPlay has no input channel, so this stays view-only whatever Sotto does with it.
- **App preview** loads a web build (Expo web, Vite, Next) into a phone-sized Chromium view inside an iPhone 15 Pro frame. It is not iOS and does not run `.ipa` files.

Windows cannot run Apple's iOS Simulator. A native app needs a Mac, a real phone with a signed helper, or a cloud device service.

## What Zach chose (October 3, 2026)

- Web and Expo-web builds first, then native apps on a **cloud device service**, the cheapest one that is good for agents.
- A new **iPhone** surface in the Tools panel, and a phone that floats over the thread while an agent works in it.
- The same default as the browser: a thread uses it without asking (ADR-0029).
- Prototype variant **C, Floating phone, control tab** (`docs/prototypes/iphone-tool-prototype.html`): the phone is Virtual iPhone's framed widget brought into Sotto, and Tools > iPhone is its control page, not a second view of the screen.
- Bring Virtual iPhone's look, not its AirPlay receiver.

## Phase 1: the test iPhone

**The test iPhone is a page in Sotto's browser, in a phone's shape** (ADR-0045). It is not a second browser. It reuses `BrowserService`'s pages, tasks, sharing, evidence and the browser grant, so ADR-0029's grant covers it without a second standing grant (ADR-0029 forbids extending it to anything that is not Sotto's browser).

What makes a page a phone, checked in Electron 43 before planning (`.claude/tmp/iphone-spike`):

- **Size by page zoom, not device emulation.** The native view sits in the phone's screen at whatever size the player draws, and its zoom factor is `width / 393`, so the page lays out at 393 CSS pixels wide however large the phone is drawn. `enableDeviceEmulation` with a `scale` was tried and rejected: CDP input then lands at `1 / scale` of the requested point.
- **CDP input lands where the agent aims.** With page zoom, `Input.dispatchTouchEvent` at (110, 200) reached the page at (110, 200), fired `pointerdown`, `touchstart`, `touchend` and `click`, and a ten-step touch move scrolled the page. `Input.insertText` typed into the tapped field.
- **Its own session.** Chromium keeps zoom per origin in a session, so phone pages get their own partition per workspace (`sotto-phone-…`). A phone also keeps its own storage, as Virtual iPhone's preview did.
- **An iOS Safari user agent**, touch emulation while the debugger is attached, and scrollbars hidden with `insertCSS` (no preload, ADR-0020).
- **Rounded corners** with `WebContentsView.setBorderRadius`.

One test iPhone per thread. `iphone_open` loads the thread's phone, or opens it the first time.

### Agent tools

On the existing `sotto_browser` endpoint, so no provider wiring changes:

- `iphone_open {url, description}` opens a URL on the thread's test iPhone and starts a browser task on it.
- `browser_action` gains `tap {x, y}`, `swipe {x, y, toX, toY}` and `key {key}` (Enter, Backspace, Tab, Escape and the arrows). They work on any page. On the phone they are CSS pixels of a 393 by 852 screen.
- The browser grant covers `tap` and `key` as it covers `click` and `type`; `swipe` asks for nothing, like `scroll`. A `viewport` action on the phone is refused: the phone keeps its size.

### Main

- `BrowserService` can show two pages at once: one in the Tools pane and one in the phone. Which slot a page takes follows from the page (`device`), so the mount request does not change.
- The phone page is excluded from Tools > Browser and from the Browser player.

### Renderer

- **Phone player** (`PhonePlayer.tsx`): the framed iPhone 15 Pro over the thread, with Virtual iPhone's label pill above (drag, size, hide) and a status pill below (what the agent is doing, Pause, a request's Allow once / Allow this thread / Deny). It opens on its own when the focused thread starts a task on its phone, under the same setting as the Browser player. The user can tap and type in it too.
- **Tools > iPhone** (`IPhoneSurface.tsx`): the address to load a web build, Reload, Close, Share with the thread, the grant line, and the task's steps. Show phone or Hide phone.
- A live dot on the rail while a phone task works or waits.

### Docs

ADR-0045; `CONTEXT.md` (Test iPhone, Phone player, the Tools panel's seven surfaces, the browser grant reaching the phone); `README.md` and `docs/guide.md`; `docs/agent-control.md` for the tools; a verification note with screenshots.

## Phase 2: a cloud iPhone (#711)

Native apps on a run.cloud iOS simulator (ADR-0047, `docs/research/2026-10-03-cloud-ios-devices.md`, `docs/research/2026-10-03-run-cloud-api.md`).

What Zach decided on October 3, 2026:
- An agent passes the path of a simulator build it made in the thread's folder.
- Each session asks before it starts; taps and typing inside it do not.
- A monthly minute cap, 750 by default.
- Prototype variant **C** (`docs/prototypes/cloud-iphone-prototype.html`): a Cloud iPhone page in Settings, the request as a card in the thread, the phone once the session runs.

### Main

- `src/shared/cloudIphone.ts` is the contract: a **cloud iPhone session** per thread at most, its states (asking, starting, active, ended, denied, failed, refused), its steps, and the bridge.
- `runCloudClient.ts` is the one adapter: Node's `fetch`, every run.cloud route in one file, a base URL tests can point at a local fake.
- `CloudIphoneService` owns sessions:
  - It checks the build path is inside the thread's working copy and the month's minutes are under the cap.
  - It waits up to 5 minutes for the user's answer.
  - Once answered, it uploads the build, starts the session and shows run.cloud's viewer in its own native view.
  - It runs the agent's actions, counts minutes into `cloud-iphone-usage.json`, ends a session idle for the set minutes or at the cap, and releases everything when Sotto quits.
- The key lives in the credential store's `runcloud` slot, set through the cloud iPhone bridge, so it never touches the agents state.
- Settings: `cloudIphoneMonthlyMinutes` (750) and `cloudIphoneIdleMinutes` (5), on the patch allow-list.
- Agent tools on `sotto_browser`:
  - `iphone_cloud_open {buildPath, description}`
  - `iphone_cloud_action {action}`: tap, swipe, type, key, button, open a URL, inspect, screenshot, in iOS points
  - `iphone_cloud_status`
  - `iphone_cloud_finish {summary, unchecked}`

### Renderer

- Settings > Cloud iPhone: the key (Save, Replace, Remove, checked against run.cloud), the cap, the idle minutes, this month's minutes and recent sessions.
- The thread's request card, in the transcript after its permission requests: **Start cloud iPhone** or **Deny**, with the build, the device, the price and this month's minutes. It also says when a session is refused, starting or failed.
- The phone player shows a running cloud session in preference to the test iPhone, with its minutes and **End session**.
- Tools > iPhone has a Cloud iPhone card.

### Verification

- The adapter and service are tested against a local fake of run.cloud's API.
- An e2e spec runs the whole journey against the fake.
- A live run needs Zach's run.cloud key.
