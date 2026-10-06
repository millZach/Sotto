# Tailnet connection verification

October 6, 2026. Plan `docs/plans/host-tailnet-connection.md`, pull request 4, on `feat/host-tailnet-connection`, stacked on the tailnet listener (pull request 2). The decision is [ADR-0053](../adr/0053-a-desktop-reaches-a-host-over-its-tailnet-first.md), "The order of a connect", and its October 6 amendment, "the tailnet connection as built".

## What was run

`tests/e2e/host-tailnet.spec.ts` in the built app on Windows, with reduced motion on. The scripted ssh (`tests/fixtures/fakeSsh.mjs`, `run` mode) runs the real launch script on this computer against a real headless host built from `tests/fixtures/e2eSshHost.ts`, under a throwaway home. The host's Tailscale is the end-to-end stand-in, running, so its Serve setting comes up. A loopback proxy (`tests/fixtures/serveStandIn.ts`) stands in for Tailscale Serve in front of the host's tailnet listener and sets `X-Forwarded-For` the way Serve does, and `SOTTO_E2E_TAILNET_MAP` sends `forge.tail5728ca.ts.net` to it over plain HTTP. Every ssh the app spawns is recorded.

1. Add forge from the keyboard. Before the press, the form says Sotto turns on Tailscale Serve on the host, on the tailnet only. The add pairs over SSH, turns on forge's tailnet connections, moves the socket to the tailnet and closes the SSH connection: the row reads `Tailnet · Connected`.
2. Quit Sotto and start it again. forge connects over its tailnet: the row reads `Tailnet · Connected · 4 providers · Phones off`, the phone words from the host's hello, and the ssh record is empty. No ssh ran at all, not even `ssh -V`.
3. Hold every SSH sign-in for Tailscale's approval (`run+tailscale` mode) and open forge's **Phones…** from the keyboard. The dialog reads the host over an admin connection, and while Tailscale holds its sign-in the dialog says so at its top, with **Open approval page**. Once approved, the dialog reads the host and the switch is live. The only launch in the ssh record is the admin connection's, with `start: false`. Escape closes the dialog and focus goes back to **Phones…**.
4. Make the tailnet silent: the Serve stand-in answers 502 and drops what it carries. Sotto reconnects over SSH, and the row reads `SSH forge · Connected · Tailnet did not answer`, with "Sotto tries it again every 5 minutes." under it.

Each state was captured at 1600×1000, 1280×800 and 820×560, dark and light: nothing scrolls sideways, and the row's line and the dialog's approval sit inside the window at the minimum size.

## Captures

In `artifacts/host-tailnet-first/`:

- `tailnet-1600x1000-dark.png` and `tailnet-820x560-light.png`: the row after a relaunch, on the tailnet connection.
- `phones-approval-1280x800-dark.png` and `phones-approval-820x560-light.png`: the Phones dialog while its admin connection waits for Tailscale's approval.
- `ssh-fallback-1600x1000-light.png` and `ssh-fallback-820x560-dark.png`: the row on the SSH connection after the tailnet stopped answering.

## What the tests cover that the app run does not

- The connect order (`tests/unit/main/hostConnectionPlan.test.ts`): a host with no entry stays on SSH; the tailnet comes first only when it is preferred, an address is known and this computer is paired, and never for Add host; a host that starts at boot retries the tailnet alone for its first minute after a drop from it; failures are classed by code, and only an `https:` address on a `*.ts.net` name with its port is accepted.
- A real host behind the Serve stand-in (`tests/integration/desktopHostsTailnet.test.ts`): Add host turns on the host's tailnet connections, moves the socket and closes the SSH connection; a relaunch and a drop reconnect over the tailnet with no ssh at all, keeping the threads on the page; Serve's 502 falls back to SSH with the note, and the 5-minute check, shortened, moves back; a refused pairing (401) pairs again over SSH and moves back; a client the host does not know as a desktop (403) goes over SSH, which records it, and moves back; SSH only turns the host's setting off over an admin connection and moves the socket to SSH, and the tailnet turns it on and moves it back; a press that cannot reach the host keeps the choice as it was; a grant the tailnet found missing is written at the next admin connection, with no ssh opened for it; Forget deletes the entry and the host turns its tailnet connections off itself.
- The host service contract over the stand-in (`tests/integration/socketHostContract.test.ts`, "Socket child codex over the tailnet").
- The socket client (`tests/unit/main/socketHostService.test.ts`): a host that answers health as another one is sent no token, a 403 keeps the pairing where a 401 asks to pair again, and the health check has the 5 seconds a tailnet connection gives it.
- The store and the end-to-end map (`tests/unit/main/tailnetStore.test.ts`): no entry reads as SSH, an address that cannot be accepted reads as none, a later Sotto's fields are kept, and the map reaches only loopback.
- The Hosts page (`tests/unit/renderer/hostsSettings.test.tsx`, `tests/unit/renderer/hostPhonesDialog.test.tsx`): each line of the row, the reasons under it, Add host's Serve sentence, and the Phones dialog's approval.
- The SSH-only tests that came before (`tests/integration/desktopHosts.test.ts`) run with a Serve stand-in that has nothing behind it, so a host they add stays on its SSH connection.

Not run: real TLS, MagicDNS and Tailscale Serve, and a real Tailscale approval. The check on forge is pull request 8.
