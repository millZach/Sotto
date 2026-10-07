# A cloud iPhone runs on run.cloud and asks before each session

## Status

Accepted October 3, 2026 (Zach, #711, phase 2 of `docs/plans/2026-10-03-test-iphone.md`). Adds a host and a second key. It adds no standing grant.

## Context

The test iPhone (ADR-0045) checks a web build at phone size; it is not iOS. Zach also wants agents to test native iOS apps, from Sotto on Windows, where Apple's Simulator cannot run. `docs/research/2026-10-03-cloud-ios-devices.md` compares the services that rent one. Zach asked for whichever is cheapest and best, and agreed to run.cloud: iOS simulators at $0.02 a minute with the first $15 a month free, plain HTTP control with one bearer key, and a signed viewer URL a window can show. It is a young company, and its routes for sessions and uploads are documented only through its SDK.

AGENTS.md makes a new host an ADR and a README change before a patch, and a second key a product decision. A session costs money and uploads the user's build to a third party. Zach decided:

- An agent passes the path of a simulator build it made in the thread's folder.
- Each session asks before it starts. Inside a running session, taps and typing do not ask.
- A monthly minute cap, 750 by default, which is about run.cloud's free $15.

## Decision

**A cloud iPhone is a run.cloud iOS simulator session that one thread starts and the user watches in the phone player.** The thread's agent drives it through run.cloud's interaction API: tap, swipe, type, press a key or a button, open a URL, read the accessibility tree and take a screenshot. The user sees run.cloud's own live view in the phone's screen, and can tap and type in it too.

**Each session asks the user, with what it costs.** The request names the build, the device, that the build goes to run.cloud, the price, and this month's minutes. Nothing is uploaded and no session starts until the user presses **Start cloud iPhone**. That answer covers the session it starts and nothing after it, so the user still answers every session. Taps and typing inside it are the session the user started, not a new action, and do not ask again. This is not a standing grant and does not extend ADR-0029.

**Sotto keeps the bill inside a cap.** Settings holds a monthly cap in minutes, 750 by default. Sotto counts each session's minutes from start to release, rounded up as run.cloud bills them. It refuses a new session once the month's minutes reach the cap, before anything is uploaded. It also ends a running session when the cap is reached. A session ends when the agent finishes, at **End session**, after 5 minutes with neither an agent action nor the user's input, when its thread is gone, and when Sotto quits.

**One key, in the credential store.** The run.cloud key lives in the operating system's credential store in its own slot, like the OpenRouter key, and main alone reads it. It never reaches the renderer, a log or an agent. The viewer URL is a bearer secret for the session: it stays in main and in the viewer's own page, is loaded only over HTTPS (a loopback address is allowed only in a test), and is never logged or shown.

**Only the build the agent names leaves the computer.** The path must be a simulator build (`.app` in a `.zip` or `.tar.gz`, or a simulator `.ipa`) inside the thread's working copy, and Sotto re-checks that path, its real location and its size right before upload, refusing rather than uploading a build that changed since the agent asked. Sotto uploads it to the upload address run.cloud's own API gives for that build, and deletes the upload from run.cloud when the session ends. If a release or a deletion does not finish, Sotto keeps retrying it while Sotto is open, and the session says so plainly rather than claiming it is done. The viewer is run.cloud's own page; the viewer and the API reach run.cloud's hosts only.

**run.cloud sits behind one adapter.** Everything else addresses a cloud iPhone by its Sotto thread and session, never by run.cloud's IDs, so another service (Appetize is the runner-up) can replace it without touching the tools, the phone player or Tools > iPhone. The adapter uses Node's `fetch`. There is no SDK and no new runtime dependency. Because run.cloud documents some routes only through its SDK, the adapter keeps every route in one place and turns any answer it does not expect into a plain error.

## Consequences

- `README.md` names `api.run.cloud` and the viewer's host under "Privacy and cost", as a host used only if you add a key and start a session.
- Sotto has a second paid key. With no key saved, the cloud iPhone is absent: the tool tells the agent to ask the user to add one, and nothing else changes.
- A cloud iPhone is a simulator, not a device. Push notifications and some hardware are not tested, and the tool's description says so.
- A session can lose its place if run.cloud has no capacity; the request then says so, and the user can try again.
- Live verification needs a run.cloud key and minutes. The adapter's tests run against a local fake of the API.
