# Updating an older host from the Threads page

September 29, 2026, for #475 and ADR-0040. The pill and panel and the update itself, proved in the built app on Windows by `tests/e2e/host-update.spec.ts`, over the scripted ssh (`tests/fixtures/fakeSsh.mjs`) that runs the real launch script on this computer. No real host was touched: forge was not contacted, and no SSH server, GitHub or browser took part.

## What was proved

- **The stand-in.** forge is a flat install, `host/index.js` in the installation folder itself as every install before this one, of the real headless host with scripted providers, and its `package.json` says 0.1.22. A local releases page publishes this build's host as `Sotto-host-<version>-win32-x64.tar.gz`, the name the launch script asks for on this machine, with a checksum sidecar that does not match it at first.
- **The pill.** Once Add host has connected forge, it reads "Update for forge", just left of the window controls. It comes before the thread panes in the page, and its computed `-webkit-app-region` is `no-drag`. The pane header under it ends at or before its left edge, so no drag region covers it, and it ends before the window controls. Beside a second pane it shrinks to its mark, 28 pixels wide, and the last pane's layout controls move over by the mark's room alone.
- **The keyboard path.** Enter on the pill opens the panel with focus on "forge", Tab reaches **Update forge**, and Escape closes the panel and gives focus back to the pill.
- **A failure.** Update shows the steps ("Updating forge · 1 of 4", with Cancel update), then "forge was not updated. The download on forge did not match the release's checksum, so Sotto deleted it and installed nothing." with "forge still runs 0.1.22. Nothing was lost.", Try again, Copy commands, Show commands and Not now. Nothing was unpacked into `versions`, and the host stayed connected on 0.1.22.
- **Try again.** With the sidecar put right, Try again unpacked the release into `versions/<version>`, wrote `current`, restarted forge's host and reconnected. The panel read "forge runs Sotto <version>.", the host's row reported the new version, the two threads made on forge before the update were back and connected under the same IDs, and the flat install stayed where it was. Dismiss took the pill away.
- **The captures.** Each state was captured at 1600x1000, 1280x800 and 820x560, dark and light. The page never scrolled sideways, the pill and panel sat wholly inside the window, and every piece of their text measured at least 4.5:1 against the surface it sits on.

The other host specs (`tests/e2e/*host*`) pass on this branch, except that `host-provider-agent.spec.ts` fails on some runs at "Show thread" taking focus. It does the same on `main`: three of five runs failed there at 86e62416, and two of four here.

## Evidence

`artifacts/host-update/`, a selection of the captures:

- `pill-1280x800-dark.png`, `pill-820x560-light.png`: the pill beside the window controls, full and shrunk to its mark in a narrow window.
- `pill-split-1600x1000-light.png`: two panes side by side, the pill as its mark.
- `panel-needs-1600x1000-light.png`, `panel-needs-820x560-dark.png`: the panel before Update.
- `panel-updating-1280x800-dark.png`: the download step, with Cancel update.
- `panel-failed-820x560-dark.png`, `panel-failed-1280x800-light.png`: the checksum failure, with the commands shown.
- `panel-done-1280x800-dark.png`: "forge runs Sotto 0.1.25."

## Not proved here

- A real Linux host. The launch script ran under Node on Windows behind the fake ssh, so Windows' `tar` unpacked the archive, and the old host was ended with Windows' TerminateProcess, not SIGTERM. The POSIX Node probe running the receive script is covered by an integration test that runs only on a POSIX machine.
- The download from GitHub, and this computer's fallback download against the real releases page. Integration and unit tests cover the fallback against local stand-ins.
- The pill on macOS, the busy host's question, and the Reconnecting rows during a restart, which unit and integration tests cover.
