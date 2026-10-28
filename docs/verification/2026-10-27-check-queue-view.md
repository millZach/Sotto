# The check queue on screen, October 27, 2026

Issue #1312's fourth part: Zach's pick C of the check queue prototype. Parts 1 to 3 (#1647, #1655, #1661) built the queue itself, Watcher's and a host's checks in it, and the reused check worktree. This part shows it. All of it is part of the Owl feature Work across machines (`cross-machine-work`); Stable shows none of it.

## What changed

- **The machines line** adds the checks waiting their turn after a machine's working count: "forge 0 working, 2 checks waiting", and "2 waiting" on the narrow line, where the calm count reads "2 machines, 5 working, 2 waiting".
- **A machine's panel** lists "Checks, one at a time": the running check first with a working ring, then the waiting ones numbered in the order asked, each with whose it is ("Watcher's", or "Delegated by Footer links") and where it stands ("running", "1 ahead"). While the running check's packages install, it reads "installing packages first, because package-lock.json changed" in place of running. A line under the list says why: "forge runs one check at a time. The rest wait here in the order they were asked for, whoever asked." The threads working there besides the checks follow under Also working.
- **Tools › Agents.** A delegated check whose thread is not made yet has a row of its own, marked Check, whose outcome reads Working. It opens to "Waiting for forge's check to finish. 1 ahead." and the machine's list with its own check in bold. A check's row once its thread exists says the same, or Zach's install sentence while its packages install. The card in the delegating thread is unchanged: no queue line.
- **Where it comes from.** Main reads This computer's `CheckQueue` and each connected host's, which a host pushes under the new `check-queue-views` feature, and sends the window the whole view whenever one changes (`sotto:checks:changed`). See `docs/host-protocol.md`.

## How it was checked

On forge (Omarchy, Linux), in its own checkout of `feat/check-queue-view`, against Sotto Owl built from the branch, with the room's projection, the machines read and the queues seeded through the end-to-end stand-in (`src/renderer/src/e2e/watcherStandIn.ts`, which now answers the queues from its seed):

- `npx playwright test tests/e2e/watcher.spec.ts -g "#1312"` on forge's virtual display (Xvfb): in dark and light with reduced motion, at 1280x800 and 820x560, the line reads "forge 0 working, 2 checks waiting"; from the keyboard, Enter on forge's name opens its panel with focus in it, the list reads the three checks in order with whose each is and where it stands ("Omarchy capture check, Watcher's · running", "Linux journeys for the footer fix, Delegated by Footer links · 1 ahead", "Linux unit suite for the footer fix, Watcher's · 2 ahead"), and Escape closes it back to the name. Nothing leaves the window at either size; at 820x560 the panel scrolls inside the room as it did before. The room's text, the panel's included, measured 4.5:1 or more on what it sits on.
- Captures: the line, [dark 1280x800](../../artifacts/check-queue-view/checks-line-dark-1280x800.png), [light 1280x800](../../artifacts/check-queue-view/checks-line-light-1280x800.png), [dark 820x560](../../artifacts/check-queue-view/checks-line-dark-820x560.png) and [light 820x560](../../artifacts/check-queue-view/checks-line-light-820x560.png); forge's panel, [dark 1280x800](../../artifacts/check-queue-view/checks-panel-dark-1280x800.png), [light 1280x800](../../artifacts/check-queue-view/checks-panel-light-1280x800.png), [dark 820x560](../../artifacts/check-queue-view/checks-panel-dark-820x560.png) and [light 820x560](../../artifacts/check-queue-view/checks-panel-light-820x560.png).
- Not captured in the built app: a waiting check's row in Tools › Agents. The end-to-end design scenario has no delegation bridge, so Tools › Agents lists no delegated rows there; the row, its details and Escape are checked in the renderer test below.
- These are verification screenshots, not design baselines: the baselines are Windows and macOS (ADR-0062), and no baseline changed.

Unit and integration tests, run on forge with `~/xm-test.sh`:

- `tests/unit/main/checkQueue.test.ts`: the view says whose each check is, keeps its place without an owner's words, is the same array until the queue changes, caps at 100, and its listeners hear one word per turn.
- `tests/unit/main/checkQueueIpc.test.ts`: nothing is registered where this computer keeps no queue; the main window reads this computer's queue first with its threads named as the window names them, then each host's; a change sends the whole view once.
- `tests/integration/socketCheckQueueViews.test.ts`: a recorded desktop that accepts `check-queue-views` is pushed the queue after its hello and on each change, with a hidden thread's check unnamed; a phone, a desktop that did not accept it, and a host with no queue get nothing.
- `tests/unit/host/remoteCommands.test.ts`: the feature adds no request, and the push carries ids and names only.
- `tests/unit/preload/checkQueues.test.ts`: the bridge exists only where the machines line does.
- `tests/unit/renderer/checkQueueView.test.tsx`: the line's words wide and narrow, the panel's list, the install words, main's pushes replacing the first read, the waiting row and its Escape, and both answers of Work across machines.
