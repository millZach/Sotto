# Admin connection and Forget verification

October 5, 2026. Plan `docs/plans/host-tailnet-connection.md`, pull request 3, on `feat/host-admin-connection` from `main` at 418dd00f. The decision is [ADR-0053](../adr/0053-a-desktop-reaches-a-host-over-its-tailnet-first.md), "Admin connections" and "Forget", and its build notes.

## What was run

`tests/e2e/host-forget.spec.ts` in the built app on Windows, with reduced motion on. The scripted ssh (`tests/fixtures/fakeSsh.mjs`, `run` mode) runs the real launch script on this computer against a real headless host built from `tests/fixtures/e2eSshHost.ts`, under a throwaway home, so the folders in the captures are `$HOME/...` and the Node path is this computer's.

1. Add forge, switch it off, and Forget it from the row's More menu, from the keyboard. The dialog says Sotto signs in to forge to revoke this computer there. Forget opens one admin connection, whose launch finds the running host and starts none, and runs `revoke-client` and then `stop-host` over it. forge's paired clients are empty afterwards, and the Hosts page says nothing more.
2. Add forge again, switch it off, and make SSH unable to reach it (`unreachable` mode). Forget removes forge here anyway: `remote-hosts.json` is empty, and the host still lists this computer's client ID. The Hosts page says forge still trusts this computer until it is removed there, with the one line to run on forge while its host is running. **Copy command** puts exactly that line on the clipboard, from the keyboard, and **Dismiss**, reached with Tab, puts the notice away.

Each capture was checked at 1600×1000, 1280×800 and 820×560, dark and light: nothing scrolls sideways, and the dialog and the notice sit inside the window.

## Captures

In `artifacts/host-admin-connection/`:

- `forget-confirm-820x560-dark.png` and `forget-confirm-1600x1000-light.png`: Forget's confirmation for a host this computer is not connected to.
- `forget-not-revoked-1600x1000-dark.png`, `forget-not-revoked-1280x800-light.png`, `forget-not-revoked-820x560-dark.png` and `forget-not-revoked-820x560-light.png`: what the Hosts page says after a Forget that could not revoke, with the command, **Copy command** and **Dismiss**. On a POSIX host the Node path is a plain path; here it is this Windows computer's own, quoted for a POSIX shell.

## What the tests cover that the app run does not

- A host on its SSH connection: Phones, an update step and Stop host go over that connection and start no second ssh; Forget revokes over it before the stop (`tests/integration/desktopHosts.test.ts`).
- A host on no SSH connection: one admin connection, opened with `start: false`, carries both of Forget's presses. One that finds its host stopped, or is refused the revoke, still removes the host and clears its credential, and says it was not revoked; `revoked: false` counts as revoked. An admin connection's SSH question and Tailscale approval reach the row, the question's answer goes to that connection, and **Open approval page** opens Tailscale's page.
- A drop keeps the host's threads and the selection on the page, reading Reconnecting, until the next connection takes their place; a final failure or Disconnect takes them away.
- The admin connection itself (`tests/unit/main/adminConnection.test.ts`): shared by every press while open, closed 60 seconds after the last press finishes and never while one runs, opened again after a failed connect, after Stop host and after a drop.
- The launch script (`tests/integration/sshLauncher.test.ts`): `start: false` fails with `host-not-running` and writes nothing for a host that is not running, and otherwise finds the host, its token and the Node it ran under.
- The socket client (`tests/unit/main/socketHostService.test.ts`): a feature is used only when hello lists it, and a pairing code goes only to a loopback address.

Not run: a real Tailscale approval for an admin connection, and an admin connection for a host on its tailnet connection, which needs pull request 4. The check on forge is pull request 8.
