# Plan: reach a remote host over the tailnet first, and let it start at boot

Status: written October 5, 2026. The decisions are [ADR-0053](../adr/0053-a-desktop-reaches-a-host-over-its-tailnet-first.md) and [ADR-0054](../adr/0054-a-host-can-start-at-boot-on-linux.md), both Accepted October 5, 2026 under the owner's delegation (section 7). The prototype is `docs/prototypes/host-tailnet-prototype.html` (variant C with A's controls). This plan does not restate the model: what each name means is in `CONTEXT.md`, and what happens is in the ADRs' sections, which this plan points to by name. It holds what the ADRs do not: the order of the work, the files, the tests, the risks and the check on forge. When a later pull request changes a detail of the model, it changes the ADR, not this plan.

## 1. Model, by ADR section

| What | Where it is decided |
|---|---|
| The names: tailnet connection, SSH connection, tailnet listener, tailnet address, admin connection, start at boot | `CONTEXT.md` entries of those names; ADR-0053 "Names" |
| What a saved host stores, and what no entry means | ADR-0053 "What a saved host stores" |
| How the address is found and checked | ADR-0053 "How the address is found" |
| The order of a connect, failure classes, drops, final failures, retries | ADR-0053 "The order of a connect" |
| Which presses use the SSH connection and which open an admin connection | ADR-0053 "Admin connections" |
| Authority and the grant | ADR-0053 "Authority", and its first consequence |
| Which clients are desktops | ADR-0053 "Which clients are desktops" |
| `tailnetConnections`: who turns it on and off | ADR-0053 "The host side" |
| Health, hello and the launch result | ADR-0053 "What the protocol gains" |
| The row, Edit connection, the Phones dialog | ADR-0053 "What the owner sees" |
| Forget's revoke, and what Forget says when SSH cannot reach the host | ADR-0053 "Forget" |
| Where start at boot applies, linger first, the three operations, the busy-host question, the unit, a launch with linger off, Forget | ADR-0054 "Decision" |

Implementation shapes the ADRs leave open, recorded here so the pull requests agree:

- The tailnet store is `<userData>/remote-host-tailnet.json`, an array of `{ id, prefer: 'tailnet' | 'ssh', address?: string, addressSeen?: number, bootStart?: BootStatus }` keyed by saved host ID. A missing entry reads as `prefer: 'ssh'`. It changes through a new `HostsCommand`, `set-connection`, which is IPC and not a setting, so the settings allow-list is not involved.
- `HostStatus` gains `via: 'tailnet' | 'ssh'`, `tailnetNote?`, `startedBy?` and `bootStart?`.
- The connect order lives in a small pure planner, `src/main/hosts/hostConnectionPlan.ts`, so its table can be unit-tested. `DesktopHosts.open()` follows it.
- The failure classes are typed codes beside today's: `tailnet-unreachable`, `tailnet-wrong-host` and `tailnet-not-desktop` go to SSH; a 401 is today's `pairing-required`; `version_mismatch` is unchanged.
- Drops and moves call the router's `setReconnecting` and then `replace`, generalising the path a host update's restart uses. `remove` is for Forget, switch-off and a final failure.
- `tailnetConnections` is host-local but lives in `AppSettings` like `phoneAccess`, because the host's settings store validates against it. It is not on the desktop's settings allow-list in `registerIpc.ts`: nothing on a desktop sets it, and the host's administrative route writes it. `tests/integration/ipc.test.ts`'s every-field check leaves it out the way it leaves out `hotkey` and `launchAtStartup`, with a comment saying why.
- The launch script's `boot-status` result is `{ supported, reason?, installed, enabled, active, linger, nodeDrift, fix? }`, where `fix` is the `sudo loginctl enable-linger <user>` line whenever linger is off. A launch reports the same shape.
- The launch script's `revoke-client` stays the only revoke. `LiveHost.admin()` exposes it, and Forget calls it through `admin()` whichever connection carries the socket; the socket gains no revoke command.

## 2. The unit

```
[Service]
ExecStart=/bin/sh %h/.local/share/sotto-host/boot-start.sh
Environment=SOTTO_HOST_STARTED_BY=boot
KillMode=mixed
TimeoutStopSec=25
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=75
[Install]
WantedBy=default.target
```

`boot-start.sh` resolves `current` as the launch script does, then runs `exec "<absolute node>" <entry> --data <data> --port <remotePort>`, with no `--key-file`. The installation folder in `ExecStart` is the saved host's, not always the default.

`boot-install`, in order:

1. Read `loginctl show-user "$USER" -p Linger`. If it is `no`, run `loginctl enable-linger` without sudo. If polkit refuses, return `{ linger: false, fix: 'sudo loginctl enable-linger <user>' }` and stop: nothing is written and the running host is untouched.
2. Write the unit and `boot-start.sh`, run `systemctl --user daemon-reload` and `systemctl --user enable sotto-host`.
3. If the running host is Sotto's, stop it (SIGTERM, 15 seconds), run `systemctl --user start sotto-host` and wait for it as a launch does. If it is not Sotto's, leave it.

`boot-remove { restart }`: `systemctl --user disable --now sotto-host`, remove both files, `daemon-reload`, then, only when `restart` is true, start a detached host as a launch does. The desktop passes `restart: true` only when the saved host is switched on; a switched-off host (including one Stop host switched off) and Forget pass `false`, so boot-remove never starts or restarts a host that is switched off.

A launch checks the unit before it spawns anything:

- Unit enabled, `Linger=yes`: if `systemctl --user is-active sotto-host` says active, it finds and reuses that host. Otherwise it runs `discover()` first and reuses a running host with the expected `hostId`, the state `boot-install` leaves when the running host is not Sotto's; only when none runs does it run `systemctl --user start sotto-host` and wait for the host. It never spawns a detached host. A host refused because another live host holds the lock (`src/host/lock.ts`'s `heldMessage` refusal, and only that one) exits with its own code, 75, which the unit lists in `RestartPreventExitStatus=`, so a unit that loses the lock stops rather than retrying every 5 seconds, below systemd's start limit. Every other `HostLockError`, including the reclaim contention whose message says to wait a moment and start again, keeps exit code 1, so `Restart=on-failure` retries it.
- Unit enabled, `Linger=no`: the launch's own sign-in may have started the unit through `default.target`. It runs `systemctl --user disable --now sotto-host`, which stops the unit's host if one is running and keeps `Restart=on-failure` from bringing it back, then spawns a detached host as today. The unit's files stay. Its result reports start at boot as off (`enabled: false, linger: false`) with the `fix` line. The stop asks no busy-host question, so turns in progress on the unit's host stop once; ADR-0054's consequences say so.
- Unit not enabled: today's launch.

`boot-install` keeps refusing to enable the unit while `Linger=no` (step 1).

## 3. Docs that change with the code

Each of these changes in the pull request that makes it true, not before.

- **README "Privacy and cost"** (PR 4):
  - Phone access's bullet adds that, with the owner's consent at Add host or in Edit connection, the host's Tailscale Serve also carries this computer's connection to it over the tailnet, and that adding a host turns that Serve setting on by default.
  - The "Only if you use them" bullet names "SSH hosts you add, and those hosts' own tailnet addresses".
  - "You answer every request": the line that a desktop "connected through your SSH account" can answer becomes that a desktop set up over your SSH account can answer, and that it can do so over your tailnet as well.
- **`docs/host-protocol.md`** (PR 2): the tailnet listener carries desktops; per-client features in hello and what that does to the health rule; hello's `tailnetAddress`, `startedBy` and a desktop's phone access; the launch result's fields; `v` stays 1.
- **`docs/guide.md`**: the Hosts row strings and Edit connection (PR 5); in the Tailscale approval section, "With a tailnet connection, Tailscale asks for approval only for a press that changes something on the host." (PR 4); the privacy lines (PR 4); a new section, "Start at boot", covering linger, the unit, Stop host, Stop starting at boot and Forget (PR 7).
- **`CONTEXT.md`**: done in PR 1. A later pull request that changes a term's meaning edits its entry.

## 4. UI

The prototype draws the row's meta lines, Edit connection, Add host's tailnet step (active, done, failing on the Serve operator), the connected card's boot offer, the Start at boot consent modal, linger refused, Stop starting at boot and the Phones dialog's approval state. Variant C's one-time line was dropped (ADR-0053, "What the owner sees"), so the prototype no longer has it.

States the prototype does not draw, and the pull request that draws them in its own mock-up or captures before it builds them:

- PR 3: what Forget says when the revoke did not happen (SSH could not reach the host, or the host was stopped): the host is removed from this computer, the host still trusts this computer until it is removed there, and the `--revoke-client` command to run while the host is running, as the one line ADR-0053 gives, which resolves `current` on the host and falls back to the flat entry, with the data folder, this computer's client ID and a copy button.
- PR 5: Add host's form before the press, with its sentence that Sotto turns on Tailscale Serve on the host; the Tailscale row's missing-state line; Rename copy.
- PR 7: Stop host's and Forget's confirmations for a host with the unit (Forget says the unit is removed); the update panel's copy for a host started at boot; the consent modal for a host Sotto did not start (the unit takes over at the next boot); the busy-host question on Start at boot and Stop starting at boot; linger refused from Add host's connected card.

Every surface is checked at 1600×1000, 1280×800 and 820×560, in light and dark, and with reduced motion. Keyboard path: radios with arrows, every modal answers Escape, focus returns to the control that opened it.

## 5. Pull requests

Dependency order: 1, then 2 and 3 (in parallel), then 4, then 5, then 6, then 7 and 8.

1. **Decide how a desktop reaches a host over its tailnet and starts it at boot**
   - Branch: `feat/host-tailnet-adr`.
   - ADR-0053 and ADR-0054 (Accepted under the owner's delegation), the amendments to ADR-0004, ADR-0025, ADR-0037, ADR-0040 and ADR-0050, the prototype, the `CONTEXT.md` entries, and this plan. Docs only.
2. **Let a host's tailnet listener carry desktops**
   - Branch: `feat/host-tailnet-listener`.
   - Files:
     - `src/shared/settings.ts`: `tailnetConnections` (type, schema, default `false`), and `tests/integration/ipc.test.ts`'s every-field check leaving it out, as section 1 says;
     - `src/shared/hostProtocol.ts`: optional `tailnetAddress`, `startedBy` and `phoneAccess` on `hostHelloSchema`, optional `tailnetAddress` and `startedBy` on `hostHealthSchema`, since both are plain `z.object` and would strip unknown keys;
     - `src/host/index.ts` and `src/host/phones.ts`: the setting, the `/v1/admin/tailnet` route, the descriptor's `tailnetAddress` and `startedBy`, turning the setting off when the last desktop is revoked;
     - `src/main/phones/phoneAccess.ts`: Serve on while either setting is on; refuse `/v1/pair` while phones are off; refuse a session to any client not in `desktop-clients.json` while phones are off;
     - `src/main/agents/socketServer.ts`: per-client features in hello, the hello fields, one observation key per listener, one receipt map for both, tailnet peers counted as connected;
     - `src/main/hosts/launchScript.ts`: the launch result's `tailnetAddress` and `startedBy`; writing `desktop-clients.json` at the step that writes the desktop's default grant.
   - Tests:
     - `hostPhoneAccess.test.ts` with the Tailscale stand-in: with phones off and desktops on, a phone's session is refused and `/v1/pair` gets 403, while a recorded desktop gets the full features; a client paired with `--pairing-code` and in neither file is treated as a phone; an unreadable `desktop-clients.json` counts nobody as a desktop;
     - launch-script tests that every SSH connect records the desktop, including one paired before the file existed;
     - `socketServer` unit tests for the observation and receipt fixes;
     - `hostListener.test.ts` still asserts loopback only.
   - Docs: `docs/host-protocol.md`.
3. **Keep the admin SSH apart from a host's socket connection**
   - Branch: `feat/host-admin-connection`.
   - A refactor that changes no behaviour a user sees, except Forget's when SSH cannot reach the host:
     - `LiveHost` gets `admin(): Promise<AdminConnection>`, which returns the SSH connection when the host is on it and otherwise opens an admin connection (lazy, 60 seconds idle close);
     - `openSocket` takes `{ url, expectedHostId }`;
     - phones, updates, stop, forget and cancelAdd go through `admin()`;
     - Forget revokes this desktop with `admin()`'s `revokeClient` (the launch script's `revoke-client`) before the stop and the boot unit's removal, whichever connection carries the socket, no longer only when the host has a tunnel. When `admin()` cannot reach the host, or reaches it stopped so `revoke-client` fails, Forget still removes it from this desktop and clears its credential, and its result says the pairing was not revoked, which Settings > Hosts turns into the sentence and command in section 4;
     - drops use `setReconnecting` then `replace`;
     - `SocketHostService` gates on hello's features, and `pair()` refuses any address that is not loopback.
   - Tests:
     - `desktopHosts.test.ts`: threads survive a drop; a final failure removes them; an admin press on a host on its SSH connection opens no second ssh; on a tailnet connection it opens one and reuses it;
     - Forget: on a host on its SSH connection, `revoke-client` runs over that connection with no second ssh; on a host whose socket is not on SSH, it opens an admin connection and runs `revoke-client` there; in both, the recorded operations show the revoke before `stop`; with `admin()` failing to connect, or reaching a stopped host so `revoke-client` returns `failed`, the host is removed, its credential cleared and the result says not revoked; `revoked: false` counts as revoked; the revoke's drop of the socket does not reconnect or pair again;
     - the `hostPhones` and `hostUpdates` unit tests.
4. **Connect to a host over its tailnet before SSH**
   - Branch: `feat/host-tailnet-connection`.
   - Files: `hostConnectionPlan.ts`; the tailnet store; `HostStatus.via` and `tailnetNote`; the 5-minute return check; the `set-connection` command, which turns `tailnetConnections` on or off over `admin()`; the grant left for the next SSH or admin connection.
   - Test seam: a `resolveTailnet` option on `DesktopHosts`, wired in main only for e2e (`SOTTO_E2E_TAILNET_MAP=forge.tail5728ca.ts.net=127.0.0.1:<port>`, guarded like `SOTTO_E2E_SSH_SCRIPT`), which lets plain HTTP reach that one loopback mapping.
   - Tests:
     - unit tests of the planner's table, including a host with no entry staying on SSH;
     - integration with `tests/fixtures/serveStandIn.ts`, a loopback proxy with upgrade support that sets `X-Forwarded-For` the way Serve does, in front of the real host's tailnet listener: no `FixtureSsh` connect on reconnect, fallback to SSH on 502, 401 and an unrecorded desktop, and moving back to the tailnet;
     - `describeHostServiceContract` over the proxy;
     - e2e `host-tailnet.spec.ts`: add forge (fake ssh `run`), relaunch, and `FAKE_SSH_RECORD` shows no ssh; stop the stand-in for `SSH forge · … Tailnet did not answer`; Phones… with `+tailscale` shows the approval in the dialog.
   - Docs: the README lines in section 3, the guide's approval and privacy lines, and anything in ADR-0053 the build changed.
5. **Show how each host is connected in Settings > Hosts**
   - Branch: `feat/host-connection-ui`.
   - Row copy, Edit connection's choice with its Serve sentence, Add host's step and its Serve sentence, the Phones dialog's approval and not-yet-read states, and the PR 5 states in section 4. Update every exact string in `hostsSettings.test.tsx` and the hosts, host-setup, host-agent-setup and host-provider specs.
   - Docs: the guide's Hosts row and Edit connection. A verification note with captures in `artifacts/host-tailnet-connection/`.
6. **Let a Linux host start at boot**
   - Branch: `feat/host-boot-start`.
   - Files: `launchScript.ts` (`boot-status`, `boot-install` with linger first, `boot-remove { restart }`, a launch that checks the unit and linger before it spawns as section 2 says, stop and `update-restart`, `boot-start.sh`, Node drift, Forget's removal after its revoke); the desktop passing `restart` from whether the saved host is switched on; `src/host/index.ts` (`startedBy: 'boot'`, and exit code 75 only when another live host holds the lock, every other lock refusal keeping 1); the widened phone access retry; the sshLauncher operations.
   - Tests: `sshLauncher` and launch-script integration with fake `systemctl` and `loginctl` executables on `PATH`, which record their calls and simulate linger off, a polkit refusal (assert nothing is written and the host keeps its PID) and no user manager. Real systemd only in PR 8. The launch cases:
     - unit enabled, `Linger=yes`, `is-active` active: the launch reuses the unit's host, runs no `start` and spawns nothing;
     - unit enabled, `Linger=yes`, inactive, no host running: `start sotto-host`, then the host the unit started, and no detached spawn;
     - unit enabled, `Linger=yes`, inactive, with a host Sotto did not start holding the lock: the launch reuses that host, runs no `start` and spawns nothing;
     - a host refused because another live host holds the lock exits with code 75, and a host refused by reclaim contention (another host kept its turn to clear the lock, or hosts kept taking and releasing it) exits with 1;
     - unit enabled, `Linger=no`, with the fake unit's host running: `disable --now sotto-host` before one detached spawn, the unit's host gone, the unit's files still there, and the result reporting start at boot off with the `fix` line;
     - `boot-install` with `Linger=no` and `enable-linger` refused never calls `enable`;
     - `boot-remove` with `restart: false` after a stop spawns nothing, and with `restart: true` spawns one detached host.
   - Docs: anything in ADR-0054 and its amendments the build changed.
7. **Offer to start a host at boot from Settings > Hosts**
   - Branch: `feat/host-boot-start-ui`.
   - The connected card's offer, the More menu items, the consent modals with the linger command and copy button, the busy-host question on both, and the PR 7 states in section 4.
   - Tests: unit tests and e2e with the fake systemctl through fake ssh `run`.
   - Docs: the guide's "Start at boot" section.
8. **Verify the tailnet connection and boot start on forge**
   - Branch: `chore/forge-tailnet-verification`.
   - A `docs/verification/` note and its captures. See section 6.

## 6. Risks and the check on forge

**Risks.**

- **Linux operator.** Serve needs `tailscale set --operator` on Linux. Until it is set the desktop stays on SSH and the row says why, with the command.
- **Unit Node path.** The pinned Node path drifts with version manager upgrades. `boot-status` reports it and an update rewrites the script.
- **Restarts.** Installing and removing the unit each restart a host Sotto started once.
- **TLS in CI.** Real TLS and MagicDNS cannot run in CI; only the forge check proves the certificate path.
- **A stolen desktop token.** It works from anywhere on the tailnet and carries the desktop's grant (ADR-0053's first consequence).
- **Pacing.** The 32-peer cap and the pacing are shared with phones.
- **Downgrade.** An older Sotto ignores `remote-host-tailnet.json` and keeps working over SSH.

**The check on forge.** forge runs 0.1.30 under mise's Node. The agent only reads. It never stops, restarts, updates or reconfigures forge's running host or its Tailscale settings, and never runs sudo; the owner makes every change below, in Sotto or on forge, and the agent records what it reads before and after.

1. **Read-only checks**, over `ssh -o BatchMode=yes forge`:
   - `tailscale serve status --json`;
   - `tailscale status --self --json`, keeping only the DNS name;
   - `loginctl show-user "$USER" -p Linger`;
   - `systemctl --user is-system-running`;
   - a `node -e` that prints only `startedBy`, `port` and `sottoVersion` from `~/.sotto/host-listener.json`, never `adminToken`;
   - with phone access on, `curl https://<dns>:<port>/v1/health` from Windows.
2. **Changes the owner makes**, each one the agent names and the owner chooses to do or not:
   - (a) Update forge's host with Sotto's Update, which restarts it. If Sotto did not start it, the owner runs the commands Sotto shows.
   - (b) Choose "Over your tailnet" in forge's Edit connection, which turns on `tailnetConnections` and Sotto's Serve setting there.
   - (c) Press Start at boot for forge. If linger needs an administrator, the owner runs `sudo loginctl enable-linger <user>` on forge first.
   - (d) Optionally, restart forge.
   - The way back: Stop starting at boot, then "SSH only".
3. **Proof**, read after each change:
   - With the Tailscale SSH check period lapsed, relaunch Sotto: the row reads `Tailnet · Connected`, no approval page opens, and `Get-Process ssh` finds nothing.
   - Phones… asks for approval once.
   - After the restart, forge's host comes back with `startedBy: boot`, and Sotto reconnects over the tailnet without SSH.
   - Captures go in `artifacts/forge-tailnet/`.

## 7. Decisions taken under the owner's delegation, October 5, 2026

The owner delegated the open decisions on October 5 ("Go ahead and do everything we discussed, no need to stop and ask me"), including those the owner's reviews of PR 1 left open. The agent decided them as follows, and the ADRs record them as picks made under that delegation:

- **UI variant:** C (setup-led) with A's controls, without C's one-time line, since nothing in Sotto announces itself unasked. An existing host moves through Edit connection and the More menu.
- **Tailnet connection default:** on for a new host, written by Add host. A host saved before keeps SSH until the owner chooses the tailnet.
- **Boot offer in Add host:** yes, on the connected card, one consented press.
- **Row wording:** as in ADR-0053, "What the owner sees".
- **Desktops on the tailnet listener:** recorded by the launch script over SSH; every other client is a phone.
- **A final failure:** takes the threads away, as ADR-0040 says of an update.
- **Start at boot without linger:** nothing is installed.
- **Forget:** revokes this desktop with the launch script's `revoke-client` over the SSH connection or an admin connection, whichever connection carries the socket, before it stops the host or removes the unit. When the revoke does not happen (SSH cannot reach the host, or the host is stopped), Forget still removes it here and says the host still trusts this computer until it is removed there, and how.
- **A launch with linger off and the unit enabled:** disables the unit, stops its host if one runs, spawns a detached host and reports start at boot as off with the linger command. With linger on and the unit active, a launch reuses the unit's host and never spawns a second; with the unit inactive, it reuses any running host with the expected ID before it starts the unit, and a unit that loses the host lock stops instead of retrying.
- **Stop starting at boot:** never starts or restarts a host that is switched off.
- **ADRs:** ADR-0053 and ADR-0054 are Accepted October 5, 2026, under this delegation.
- **forge:** see section 6. Releases are cut by the owner by hand (`docs/release/releasing.md`); no agent cuts or publishes one.
